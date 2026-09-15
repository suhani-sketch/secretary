import { BrowserWindow, app, ipcMain, powerMonitor, shell } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { config as loadDotenv } from 'dotenv'
import { closeDatabase, dbPath, getDb, openDatabase } from './db'
import { clearLog, listLog, log } from './log'
import { showToast } from './notifier'
import * as repo from './repo'
import { TICK_MS, startScheduler, startupSweep, stopScheduler, tick } from './scheduler'
import { createTray, refreshTrayMenu } from './tray'
import { GeminiProvider } from './ai/gemini'
import type { Provider } from './ai/provider'
import { enqueueChat } from './ai/orchestrator'
import { IPC, type AppInfo, type ChatStatus, type CreateItemInput } from '../shared/types'

// ---- Identity: required for Windows toasts, otherwise they vanish silently (spec §5) ----
const APP_USER_MODEL_ID = 'com.suhani.secretary'
app.setAppUserModelId(APP_USER_MODEL_ID)

// "--hidden" is passed by the Windows login entry so the app starts in the tray without a window.
const startedHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let quitting = false
let provider: Provider | null = null
let aiModel = ''

// ---- Single instance: a second launch (e.g. `npm start` while the tray copy runs) just focuses the first ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(onReady)
}

// ---- AI provider (spec §4). The key lives in .env next to package.json and never leaves the main process. ----
function setupProvider(): void {
  loadDotenv({ path: join(app.getAppPath(), '.env'), quiet: true })
  aiModel = process.env['GEMINI_MODEL'] || 'gemini-3.6-flash'
  const key = process.env['GEMINI_API_KEY']
  if (key && key.trim()) {
    provider = new GeminiProvider(key.trim(), aiModel)
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
  setupProvider()
  createTray(trayHandlers)
  registerIpc()

  mainWindow = createWindow()
  if (!startedHidden) mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Highest-risk subsystem first: sweep what we missed, then start ticking.
  startupSweep()
  startScheduler(notifyRendererChanged)

  // Developer hook: SECRETARY_CHAT="first message||second message" runs a scripted conversation
  // through the real orchestrator, prints the results, then quits. Used for the §7 Phase 1 test.
  const script = process.env['SECRETARY_CHAT']
  if (script) {
    void (async () => {
      for (const line of script.split('||')) {
        console.log(`\n>>> USER: ${line}`)
        const res = await enqueueChat({ provider, onStatus: () => undefined, onChanged: () => undefined }, line)
        console.log(`<<< ASSISTANT: ${res.assistantMessage.content}`)
        for (const a of res.applied) console.log(`    ✓ ${a.summary}`)
        if (res.error) console.log(`    ✗ error: ${res.error}`)
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
    showToast({ title: 'Secretary test', body: 'If you can read this, Windows toasts work.' })
  })

  // Conversation (Phase 1)
  ipcMain.handle(IPC.sendChat, (_e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty message')
    return enqueueChat({ provider, onStatus: sendChatStatus, onChanged: notifyRendererChanged }, text.slice(0, 8000))
  })
  ipcMain.handle(IPC.chatHistory, (_e, limit?: number) => repo.recentMessages(limit ?? 60))
  ipcMain.handle(IPC.listExtractions, (_e, limit?: number) => repo.listExtractions(limit ?? 30))
}
