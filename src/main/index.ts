import { BrowserWindow, Notification, app, ipcMain, powerMonitor, shell } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { config as loadDotenv } from 'dotenv'
import { closeDatabase, dbPath, getDb, openDatabase } from './db'
import { clearLog, listLog, log } from './log'
import { NOTIFICATION_ID_PREFIX, PROTOCOL, dispatchToastAction, setToastActionHandler, showToast } from './notifier'
import * as repo from './repo'
import { TICK_MS, startScheduler, startupSweep, stopScheduler, tick } from './scheduler'
import { createTray, refreshTrayMenu } from './tray'
import { GeminiProvider } from './ai/gemini'
import type { Provider } from './ai/provider'
import { applyExternalTools, enqueueChat } from './ai/orchestrator'
import { IPC, type AppInfo, type ChatStatus, type CreateItemInput } from '../shared/types'
import { listAiCalls } from './log'

// ---- Identity: required for Windows toasts, otherwise they vanish silently (spec §5) ----
const APP_USER_MODEL_ID = 'com.suhani.secretary'
app.setAppUserModelId(APP_USER_MODEL_ID)

// "--hidden" is passed by the Windows login entry so the app starts in the tray without a window.
const startedHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let quitting = false
let provider: Provider | null = null
let aiModel = ''

// ---- Single instance: a second launch (e.g. `npm start` while the tray copy runs) just focuses the first.
// Toast buttons launch `secretary://…` URLs; Windows starts a second instance with the URL in argv,
// which lands here and is routed to the running copy. ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    log('info', 'protocol.second_instance', url ?? `(no url; argv: ${argv.slice(1).join(' ')})`)
    if (url) handleProtocolUrl(url)
    else showWindow()
  })
  // macOS delivers protocol launches this way; harmless on Windows, and keeps the two paths identical.
  app.on('open-url', (e, url) => {
    e.preventDefault()
    log('info', 'protocol.open_url', url)
    if (app.isReady()) handleProtocolUrl(url)
    else app.whenReady().then(() => handleProtocolUrl(url))
  })
  app.whenReady().then(onReady)
}

/** Register secretary:// so toast buttons can reach us. In dev this points at electron.exe + project dir. */
function registerProtocol(): void {
  const ok = app.isPackaged
    ? app.setAsDefaultProtocolClient(PROTOCOL)
    : app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [app.getAppPath()])
  log(ok ? 'info' : 'warn', 'protocol.registered', `${PROTOCOL}:// → ${ok ? 'ok' : 'FAILED'} (${process.execPath} ${app.isPackaged ? '' : app.getAppPath()} "%1")`)
}

/**
 * Windows attributes toasts to an app by AppUserModelId, and for an unpackaged app it learns that id from a Start Menu
 * shortcut. Without the shortcut the toast still displays, but activation (clicks, buttons) is treated as coming from
 * an unknown app and protocol launches fail with "Get an app to open this link". Electron writes one for its own default
 * identity; we need one for ours.
 */
function ensureStartMenuShortcut(): void {
  if (process.platform !== 'win32') return
  try {
    const dir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    const link = join(dir, 'Secretary.lnk')
    // 'create' overwrites if present; 'replace' fails when the file does not exist yet. Icon must be .ico/.exe, so use the exe's own.
    const ok = shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: 'Secretary — conversational personal secretary',
      appUserModelId: APP_USER_MODEL_ID,
      icon: process.execPath,
      iconIndex: 0
    })
    log(ok ? 'info' : 'warn', 'aumid.shortcut', `${link} → ${ok ? 'written' : 'FAILED'} (AppUserModelId ${APP_USER_MODEL_ID})`)
  } catch (e) {
    log('error', 'aumid.shortcut', (e as Error).message)
  }
}

/**
 * secretary://reminder/<reminderId>/(open|done|snooze/<min>|reschedule)
 * Every write goes through the same validated tool layer as typed input.
 */
function handleProtocolUrl(raw: string): void {
  log('info', 'protocol.received', raw)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return
  }
  const parts = u.pathname.split('/').filter(Boolean) // host is "reminder"; pathname "/<id>/<action>[/<arg>]"
  const reminderId = parts[0]
  const action = parts[1] ?? 'open'
  const arg = parts[2]
  if (u.host !== 'reminder' || !reminderId) {
    showWindow()
    return
  }
  performReminderAction(reminderId, action, arg, 'protocol url')
}

/**
 * The one place a reminder action is carried out, whichever way it arrived (toast button, protocol URL, cold-start
 * activation). Every write goes through the same validated tool layer as typed input (spec §5).
 */
function performReminderAction(reminderId: string, action: string, arg: string | undefined, source: string): void {
  const rem = repo.getReminder(reminderId)
  if (!rem) {
    log('warn', 'toast.unknown_reminder', `${reminderId} (${source})`)
    showWindow()
    return
  }
  // The action itself, parsed — this is the line to look for when testing toast buttons.
  log('info', 'toast.received', `action=${action}${arg ? `/${arg}` : ''} for reminder "${rem.item_title ?? 'Reminder'}" (state ${rem.state}) via ${source}`, reminderId)
  const ext = (calls: { name: string; args: Record<string, unknown> }[]): void => {
    const res = applyExternalTools('toast', 'user', calls)
    log(res.applied.length ? 'info' : 'warn', 'toast.action', `${action}: ${res.applied.map((a) => a.summary).join(' | ') || res.error || 'nothing applied'}`, reminderId)
    notifyRendererChanged()
  }
  switch (action) {
    case 'done':
      repo.acknowledgeReminder(reminderId)
      if (rem.target_type === 'item') ext([{ name: 'complete_item', args: { id: rem.target_id } }])
      break
    case 'snooze': {
      const minutes = Math.max(1, Math.min(60 * 24, Number(arg) || 15))
      ext([{ name: 'snooze_reminder', args: { id: reminderId, minutes } }])
      break
    }
    case 'reschedule':
      repo.acknowledgeReminder(reminderId)
      showWindow()
      // Let the renderer finish loading before prefilling; the user completes the sentence.
      setTimeout(() => send(IPC.chatPrefill, `Move "${rem.item_title ?? 'that'}" to `), 400)
      break
    default:
      repo.acknowledgeReminder(reminderId)
      showWindow()
  }
}

// ---- Toast buttons (spec §5 "Notification actions") ----
function installToastActivation(): void {
  // Live toasts: the Notification object's `action` event → dispatchToastAction → performReminderAction.
  setToastActionHandler((reminderId, action, arg, source) => performReminderAction(reminderId, action, arg, source))
  // Toasts whose Notification object is gone (app restarted, GC): Windows hands the activation to the app itself.
  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation((details) => {
      log('info', 'toast.activation', `type=${details.type} actionIndex=${details.actionIndex ?? '-'} args=${details.arguments}`)
      const m = new RegExp(`${NOTIFICATION_ID_PREFIX}([0-9a-f-]{36})`).exec(details.arguments ?? '')
      if (!m) {
        showWindow()
        return
      }
      if (details.type === 'action' && typeof details.actionIndex === 'number') dispatchToastAction(m[1], details.actionIndex, 'handleActivation')
      else {
        repo.acknowledgeReminder(m[1])
        showWindow()
      }
    })
    log('info', 'toast.activation_hook', 'Notification.handleActivation installed')
  }
}

// ---- AI provider (spec §4). The key lives in .env next to package.json and never leaves the main process. ----
function setupProvider(): void {
  loadDotenv({ path: join(app.getAppPath(), '.env'), quiet: true })
  // Comma-separated fallback chain; free-tier quotas are per model, so siblings absorb bursts.
  aiModel = process.env['GEMINI_MODEL'] || 'gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash'
  const key = process.env['GEMINI_API_KEY']
  if (key && key.trim()) {
    provider = new GeminiProvider(
      key.trim(),
      aiModel.split(',').map((s) => s.trim()).filter(Boolean)
    )
    log('info', 'ai.provider', `gemini / ${aiModel} (key present)`)
  } else {
    provider = null
    log('warn', 'ai.provider', 'GEMINI_API_KEY missing from .env — chat will explain instead of working')
  }
}

// ---- Start with Windows ----
// In development we are running `electron.exe <projectDir> --hidden`; when packaged, path/args differ.
function loginItemArgs(): { path: string; args: string[] } {
  if (app.isPackaged) return { path: process.execPath, args: ['--hidden'] }
  return { path: process.execPath, args: [app.getAppPath(), '--hidden'] }
}
function getOpenAtLogin(): boolean {
  return app.getLoginItemSettings(loginItemArgs()).openAtLogin
}
function setOpenAtLogin(enabled: boolean): boolean {
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemArgs() })
  getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('open_at_login', ?)`).run(enabled ? '1' : '0')
  const actual = getOpenAtLogin()
  log(actual === enabled ? 'info' : 'warn', 'login_item.set', `requested=${enabled} actual=${actual}`)
  return actual
}
function applyStoredOpenAtLogin(): void {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'open_at_login'`).get() as { value: string } | undefined
  // Default ON: restart survival is a core requirement.
  const wanted = row ? row.value === '1' : true
  app.setLoginItemSettings({ openAtLogin: wanted, ...loginItemArgs() })
  log('info', 'login_item.applied', `openAtLogin=${getOpenAtLogin()} (${row ? 'from settings' : 'default'})`)
}

// ---- Window ----
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#FAF6F0',
    title: 'Secretary',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('close', (e) => {
    // Closing the window hides to tray; the app keeps running so reminders keep firing.
    if (!quitting) {
      e.preventDefault()
      win.hide()
      log('info', 'window.hidden', 'window closed to tray; scheduler keeps running')
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // Developer hook: SECRETARY_SCREENSHOT=<file.png> saves a picture of the window ~2.5s after load, then quits.
  const shot = process.env['SECRETARY_SCREENSHOT']
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage()
          writeFileSync(shot, img.toPNG())
          log('info', 'dev.screenshot', shot)
        } catch (e) {
          log('error', 'dev.screenshot', (e as Error).message)
        }
        quitting = true
        app.quit()
      }, 2500)
    })
  }
  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}
const notifyRendererChanged = (): void => send(IPC.changed)
const sendChatStatus = (s: ChatStatus): void => send(IPC.chatStatus, s)

const trayHandlers = {
  showWindow,
  quit: () => {
    quitting = true
    app.quit()
  },
  getOpenAtLogin,
  setOpenAtLogin: (v: boolean) => {
    setOpenAtLogin(v)
    notifyRendererChanged()
  }
}

// ---- Startup ----
function onReady(): void {
  openDatabase()
  log('info', 'app.start', `v${app.getVersion()} electron ${process.versions.electron} hidden=${startedHidden} db=${dbPath()}`)
  applyStoredOpenAtLogin()
  ensureStartMenuShortcut()
  registerProtocol()
  setupProvider()
  createTray(trayHandlers)
  registerIpc()
  installToastActivation()

  // If a toast button launched us cold (app was not running), the URL is in our own argv.
  const coldUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`))

  mainWindow = createWindow()
  if (!startedHidden && !coldUrl) mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Highest-risk subsystem first: sweep what we missed, then start ticking.
  startupSweep()
  startScheduler(notifyRendererChanged)
  if (coldUrl) handleProtocolUrl(coldUrl)

  // Developer hook: SECRETARY_CHAT="first message||second message" runs a scripted conversation
  // through the real orchestrator, prints the results, then quits. Used for the §7 Phase 1 test.
  const script = process.env['SECRETARY_CHAT']
  if (script) {
    void (async () => {
      // Lines starting with "!" are manual edits: !tool_name {"json":"args"} — run as the UI would, through the
      // same tool layer. $ITEM / $REMINDER are replaced with the ids from the most recent applied change.
      let lastItem = ''
      let lastReminder = ''
      const remember = (applied: { itemId?: string; reminderId?: string }[]): void => {
        for (const a of applied) {
          if (a.itemId) lastItem = a.itemId
          if (a.reminderId) lastReminder = a.reminderId
        }
      }
      for (const line of script.split('||')) {
        if (line.startsWith('!')) {
          const m = /^!(\w+)\s*(\{.*\})?$/.exec(line.trim())
          if (!m) continue
          const args = JSON.parse((m[2] ?? '{}').replace(/\$ITEM/g, lastItem).replace(/\$REMINDER/g, lastReminder)) as Record<string, unknown>
          console.log(`\n>>> MANUAL: ${m[1]} ${JSON.stringify(args)}`)
          const res = applyExternalTools('manual', 'user', [{ name: m[1], args }])
          for (const a of res.applied) console.log(`    ✓ ${a.summary}`)
          if (res.confirm) console.log(`    ? confirm: ${res.confirm.question}`)
          if (res.error) console.log(`    ✗ error: ${res.error}`)
          remember(res.applied)
          continue
        }
        console.log(`\n>>> USER: ${line}`)
        const res = await enqueueChat({ provider, onStatus: () => undefined, onChanged: () => undefined }, line)
        console.log(`<<< ASSISTANT: ${res.assistantMessage.content}`)
        for (const a of res.applied) console.log(`    ✓ ${a.summary}`)
        if (res.error) console.log(`    ✗ error: ${res.error}`)
        remember(res.applied)
      }
      quitting = true
      app.quit()
    })()
  }

  // Laptop lid / sleep: run a tick immediately on wake instead of waiting for the interval.
  powerMonitor.on('resume', () => {
    log('info', 'power.resume', 'system resumed; ticking now')
    tick('resume')
    notifyRendererChanged()
  })
}

// Keep running in the tray when all windows are closed (Windows behaviour we want).
app.on('window-all-closed', () => {
  /* do nothing — tray keeps us alive */
})
app.on('before-quit', () => {
  quitting = true
  stopScheduler()
  log('info', 'app.quit')
  closeDatabase()
})

// ---- IPC: the only door between the renderer and the database ----
function registerIpc(): void {
  ipcMain.handle(IPC.listItems, () => repo.listItems())
  ipcMain.handle(IPC.createItem, (_e, input: CreateItemInput) => {
    const res = repo.createItemWithReminder(input.title, input.remindAtLocal)
    log(
      'info',
      'item.created',
      res.reminder ? `"${res.item.title}" with reminder at ${res.reminder.fire_at_utc}` : `"${res.item.title}" (no reminder)`,
      res.reminder?.id
    )
    return res
  })
  ipcMain.handle(IPC.completeItem, (_e, id: string) => {
    repo.completeItem(id)
    log('info', 'item.completed', id)
  })
  ipcMain.handle(IPC.listReminders, () => repo.listReminders())
  ipcMain.handle(IPC.createTestReminder, (_e, minutes: number) => {
    const r = repo.createTestReminder(minutes)
    log('info', 'reminder.test_created', `fires at ${r.fire_at_utc} (${minutes} min from now)`, r.id)
    if (minutes <= 0) tick('immediate') // past-dated: deliver right away rather than waiting up to 30s
    return r
  })
  ipcMain.handle(IPC.cancelReminder, (_e, id: string) => {
    repo.cancelReminder(id)
    log('info', 'reminder.cancelled', undefined, id)
  })
  ipcMain.handle(IPC.listLog, (_e, limit?: number) => listLog(limit ?? 50))
  ipcMain.handle(IPC.clearLog, () => clearLog())
  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '?',
    dbPath: dbPath(),
    appPath: app.getAppPath(),
    execPath: process.execPath,
    startedHidden,
    openAtLogin: getOpenAtLogin(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    schedulerIntervalMs: TICK_MS,
    ai: { provider: provider?.name ?? 'none', model: aiModel, hasKey: provider !== null }
  }))
  ipcMain.handle(IPC.setOpenAtLogin, (_e, enabled: boolean) => {
    const actual = setOpenAtLogin(enabled)
    refreshTrayMenu(trayHandlers)
    return actual
  })
  ipcMain.handle(IPC.sendTestNotification, () => {
    // Uses the newest reminder so the buttons have something real to act on, if one exists.
    const r = repo.listReminders()[0]
    showToast({
      title: 'Secretary test',
      body: r ? `Buttons act on "${r.item_title ?? 'Reminder'}".` : 'If you can read this, Windows toasts work.',
      actions: r ? { reminderId: r.id, itemId: r.target_type === 'item' ? r.target_id : null } : undefined
    })
  })

  // Manual editing (spec hard rule 3): the UI runs the same tools as the model, as the user.
  ipcMain.handle(IPC.runTool, (_e, name: string, args: Record<string, unknown>) => {
    if (typeof name !== 'string') throw new Error('Bad tool name')
    const res = applyExternalTools('manual', 'user', [{ name, args: args ?? {} }])
    notifyRendererChanged()
    return res
  })
  ipcMain.handle(IPC.listActivities, (_e, limit?: number) => repo.listActivities(limit ?? 50))
  ipcMain.handle(IPC.listAiCalls, (_e, limit?: number) => listAiCalls(limit ?? 20))

  // Conversation (Phase 1)
  ipcMain.handle(IPC.sendChat, (_e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty message')
    return enqueueChat({ provider, onStatus: sendChatStatus, onChanged: notifyRendererChanged }, text.slice(0, 8000))
  })
  ipcMain.handle(IPC.chatHistory, (_e, limit?: number) => repo.recentMessages(limit ?? 60))
  ipcMain.handle(IPC.listExtractions, (_e, limit?: number) => repo.listExtractions(limit ?? 30))
}
