import { Notification } from 'electron'
import { log } from './log'

export const PROTOCOL = 'secretary'

export interface ToastOptions {
  title: string
  body: string
  reminderId?: string | null
  /** When set, the toast carries Done / Snooze / Reschedule buttons that call back via the secretary:// protocol. */
  actions?: { reminderId: string; itemId: string | null }
  /** Keep the toast on screen until the user acts (Windows "reminder" scenario). */
  persistent?: boolean
  onClick?: () => void
  onClose?: () => void
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/**
 * Windows toast XML with action buttons. Electron's `actions` field is macOS-only, so on Windows we
 * hand it the raw toast XML. Buttons use protocol activation: Windows launches
 * `secretary://reminder/<id>/<action>`, which our single-instance handler routes through the tool layer.
 */
function buildToastXml(o: ToastOptions): string {
  const a = o.actions!
  const base = `${PROTOCOL}://reminder/${a.reminderId}`
  const scenario = o.persistent ? ' scenario="reminder"' : ''
  return `<toast activationType="protocol" launch="${base}/open"${scenario}>
  <visual>
    <binding template="ToastGeneric">
      <text>${esc(o.title)}</text>
      <text>${esc(o.body)}</text>
      <text placement="attribution">Secretary</text>
    </binding>
  </visual>
  <actions>
    <action content="Done" activationType="protocol" arguments="${base}/done"/>
    <action content="Snooze 15 min" activationType="protocol" arguments="${base}/snooze/15"/>
    <action content="Snooze 1 h" activationType="protocol" arguments="${base}/snooze/60"/>
    <action content="Reschedule" activationType="protocol" arguments="${base}/reschedule"/>
  </actions>
  <audio src="ms-winsoundevent:Notification.Reminder"/>
</toast>`
}

/**
 * Shows a Windows toast. Requires app.setAppUserModelId() to have been called at startup,
 * otherwise Windows drops the toast silently (spec §5). Every outcome is written to the log.
 * If the rich (buttons) toast fails, falls back to a plain one so the reminder is never lost.
 */
export function showToast(opts: ToastOptions): boolean {
  if (!Notification.isSupported()) {
    log('error', 'notify.unsupported', 'Notification API reports unsupported on this system', opts.reminderId)
    return false
  }
  const rich = !!opts.actions && process.platform === 'win32'
  const attempt = (useXml: boolean): boolean => {
    try {
      const n = new Notification(
        useXml
          ? { toastXml: buildToastXml(opts) }
          : { title: opts.title, body: opts.body, silent: false, timeoutType: opts.persistent ? 'never' : 'default' }
      )
      n.on('show', () => log('info', 'notify.shown', `"${opts.title}"${useXml ? ' (with buttons)' : ''}`, opts.reminderId))
      n.on('click', () => {
        log('info', 'notify.clicked', `"${opts.title}"`, opts.reminderId)
        opts.onClick?.()
      })
      n.on('close', () => {
        log('info', 'notify.closed', `"${opts.title}"`, opts.reminderId)
        opts.onClose?.()
      })
      n.on('failed', (_e, err) => {
        log('error', 'notify.failed', `${useXml ? 'rich toast' : 'plain toast'}: ${String(err)}`, opts.reminderId)
        if (useXml) attempt(false)
      })
      n.show()
      log('info', 'notify.requested', `"${opts.title}" — ${opts.body.replace(/\n/g, ' ')}`, opts.reminderId)
      return true
    } catch (e) {
      log('error', 'notify.exception', `${useXml ? 'rich' : 'plain'}: ${(e as Error).message}`, opts.reminderId)
      return useXml ? attempt(false) : false
    }
  }
  return attempt(rich)
}
