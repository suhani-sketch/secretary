import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'path'
import { log } from './log'

let tray: Tray | null = null

export interface TrayHandlers {
  showWindow: () => void
  quit: () => void
  getOpenAtLogin: () => boolean
  setOpenAtLogin: (enabled: boolean) => void
}

function trayIcon(): Electron.NativeImage {
  const p = join(app.getAppPath(), 'resources', 'tray.png')
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) {
    log('warn', 'tray.icon_missing', `no icon at ${p}; using blank`)
    return nativeImage.createEmpty()
  }
  return img
}

export function createTray(h: TrayHandlers): Tray {
  if (tray) return tray
  tray = new Tray(trayIcon())
  tray.setToolTip('Secretary')
  const rebuild = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Secretary', click: h.showWindow },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: h.getOpenAtLogin(),
        click: (mi) => {
          h.setOpenAtLogin(mi.checked)
          rebuild()
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: h.quit }
    ])
    tray!.setContextMenu(menu)
  }
  rebuild()
  tray.on('click', h.showWindow)
  tray.on('double-click', h.showWindow)
  log('info', 'tray.created')
  return tray
}

export function refreshTrayMenu(h: TrayHandlers): void {
  if (!tray) return
  tray.destroy()
  tray = null
  createTray(h)
}
