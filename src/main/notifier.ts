import { Notification } from 'electron'
import { log } from './log'

export interface ToastOptions {
  title: string
  body: string
  reminderId?: string | null
  onClick?: () => void
  onClose?: () => void
}

/**
 * Shows a Windows toast. Requires app.setAppUserModelId() to have been called at startup,
 * otherwise Windows drops the toast silently (spec §5). Every outcome is written to the log.
 */
export function showToast(opts: ToastOptions): boolean {
  if (!Notification.isSupported()) {
    log('error', 'notify.unsupported', 'Notification API reports unsupported on this system', opts.reminderId)
    return false
  }
  try {
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      silent: false,
      timeoutType: 'default'
    })
    n.on('show', () => log('info', 'notify.shown', `"${opts.title}"`, opts.reminderId))
    n.on('click', () => {
      log('info', 'notify.clicked', `"${opts.title}"`, opts.reminderId)
      opts.onClick?.()
    })
    n.on('close', () => {
      log('info', 'notify.closed', `"${opts.title}"`, opts.reminderId)
      opts.onClose?.()
    })
    n.on('failed', (_e, err) => log('error', 'notify.failed', String(err), opts.reminderId))
    n.show()
    log('info', 'notify.requested', `"${opts.title}" — ${opts.body}`, opts.reminderId)
    return true
  } catch (e) {
    log('error', 'notify.exception', (e as Error).message, opts.reminderId)
    return false
  }
}
