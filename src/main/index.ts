import { BrowserWindow, app, ipcMain, powerMonitor, shell } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { closeDatabase, dbPath, getDb, openDatabase } from './db'
import { clearLog, listLog, log } from './log'
import { showToast } from './notifier'
import * as repo from './repo'
import { TICK_MS, startScheduler, startupSweep, stopScheduler, tick } from './scheduler'
import { createTray, refreshTrayMenu } from './tray'
import { IPC, type AppInfo, type CreateItemInput } from '../shared/types'

// ---- Identity: required for Windows toasts, otherwise they vanish silently (spec §5) ----
const APP_USER_MODEL_ID = 'com.suhani.secretary'
app.setAppUserModelId(APP_USER_MODEL_ID)

// "--hidden" is passed by the Windows login entry so the app starts in the tray without a window.
const startedHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let quitting = false

// ---- Single instance: a second launch (e.g. `npm start` while the tray copy runs) just focuses the first ----
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(onReady)
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
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
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
  // Developer hook: SECRETARY_SCREENSHOT=<file.png> saves a picture of the window ~2s after load, then quits.
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

function notifyRendererChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.changed)
}

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
  createTray(trayHandlers)
  registerIpc()

  mainWindow = createWindow()
  if (!startedHidden) mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Highest-risk subsystem first: sweep what we missed, then start ticking.
  startupSweep()
  startScheduler(notifyRendererChanged)

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
    schedulerIntervalMs: TICK_MS
  }))
  ipcMain.handle(IPC.setOpenAtLogin, (_e, enabled: boolean) => {
    const actual = setOpenAtLogin(enabled)
    refreshTrayMenu(trayHandlers)
    return actual
  })
  ipcMain.handle(IPC.sendTestNotification, () => {
    showToast({ title: 'Secretary test', body: 'If you can read this, Windows toasts work.' })
  })
}
