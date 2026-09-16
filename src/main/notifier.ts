import { Notification } from 'electron'
import { log } from './log'

export const PROTOCOL = 'secretary'

/** The buttons every reminder toast carries, in order. The index is what Windows reports back. */
export const TOAST_ACTIONS = [
  { key: 'done', label: 'Done' },
  { key: 'snooze', label: 'Snooze 15 min', arg: '15' },
  { key: 'snooze', label: 'Snooze 1 h', arg: '60' },
  { key: 'reschedule', label: 'Reschedule' }
] as const

export type ToastActionHandler = (reminderId: string, action: string, arg: string | undefined, source: string) => void

let actionHandler: ToastActionHandler | null = null
/** index.ts installs the handler that routes button presses into the tool layer. */
export function setToastActionHandler(h: ToastActionHandler): void {
  actionHandler = h
}

export const NOTIFICATION_ID_PREFIX = 'reminder:'

/** Toasts currently on screen, kept referenced so their events keep firing. */
const live = new Map<string, Notification>()

export interface ToastOptions {
  title: string
  body: string
  reminderId?: string | null
  /** When set, the toast carries Done / Snooze / Reschedule buttons that act on this reminder. */
  actions?: { reminderId: string; itemId: string | null }
  /** Keep the toast on screen until the user acts. */
  persistent?: boolean
  onClick?: () => void
  onClose?: () => void
}

/** Turn a button index into the reminder action it stands for. */
export function dispatchToastAction(reminderId: string, actionIndex: number, source: string): void {
  const a = TOAST_ACTIONS[actionIndex]
  if (!a) {
    log('warn', 'toast.unknown_button', `index ${actionIndex}`, reminderId)
    return
  }
  log('info', 'toast.button', `"${a.label}" (index ${actionIndex}) via ${source}`, reminderId)
  if (!actionHandler) {
    log('error', 'toast.no_handler', 'button pressed before the handler was installed', reminderId)
    return
  }
  actionHandler(reminderId, a.key, 'arg' in a ? a.arg : undefined, source)
}

/**
 * Shows a Windows toast. Requires app.setAppUserModelId() at startup (plus a Start Menu shortcut carrying that id
 * for an unpackaged app), otherwise Windows drops or orphans the toast. Every outcome is written to the log.
 *
 * Buttons use Electron's native `actions` (supported on Windows in Electron 44): while the app is running the
 * `action` event fires with the button index; if the app was restarted, `Notification.handleActivation` in index.ts
 * receives the activation instead. No protocol handler or registry entry is involved.
 */
export function showToast(opts: ToastOptions): boolean {
  if (!Notification.isSupported()) {
    log('error', 'notify.unsupported', 'Notification API reports unsupported on this system', opts.reminderId)
    return false
  }
  try {
    // Hold a reference while the toast is on screen: a garbage-collected Notification cannot fire `action`.
    const key = opts.actions ? opts.actions.reminderId : `plain:${Date.now()}`
    const n = new Notification({
      id: opts.actions ? `${NOTIFICATION_ID_PREFIX}${opts.actions.reminderId}` : undefined,
      title: opts.title,
      body: opts.body,
      silent: false,
      timeoutType: opts.persistent ? 'never' : 'default',
      actions: opts.actions ? TOAST_ACTIONS.map((a) => ({ type: 'button' as const, text: a.label })) : undefined
    })
    n.on('show', () => log('info', 'notify.shown', `"${opts.title}"${opts.actions ? ' (with buttons)' : ''}`, opts.reminderId))
    n.on('click', () => {
      log('info', 'notify.clicked', `"${opts.title}" (body click)`, opts.reminderId)
      opts.onClick?.()
    })
    n.on('action', (details) => {
      if (opts.actions) dispatchToastAction(opts.actions.reminderId, details.actionIndex, 'action event')
      else log('info', 'notify.action', `index ${details.actionIndex} on "${opts.title}"`, opts.reminderId)
    })
    n.on('close', () => {
      live.delete(key)
      log('info', 'notify.closed', `"${opts.title}"`, opts.reminderId)
      opts.onClose?.()
    })
    n.on('failed', (_e, err) => {
      live.delete(key)
      log('error', 'notify.failed', String(err), opts.reminderId)
    })
    live.set(key, n)
    n.show()
    log('info', 'notify.requested', `"${opts.title}" — ${opts.body.replace(/\n/g, ' ')}`, opts.reminderId)
    return true
  } catch (e) {
    log('error', 'notify.exception', (e as Error).message, opts.reminderId)
    return false
  }
}
