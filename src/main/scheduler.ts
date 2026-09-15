import { DateTime } from 'luxon'
import { log } from './log'
import { showToast } from './notifier'
import { acknowledgeReminder, duePendingReminders, markDelivered, nextPendingReminder } from './repo'
import type { Reminder } from '../shared/types'

export const TICK_MS = 30_000

let timer: NodeJS.Timeout | null = null
let ticking = false
let onDeliveredCb: (() => void) | null = null

/** Human-readable lateness, e.g. "4 min", "2 h 10 min", "1 day 3 h". */
function describeLateness(fireAtUtc: string, now: DateTime): string {
  const diff = now.diff(DateTime.fromISO(fireAtUtc, { zone: 'utc' }), ['days', 'hours', 'minutes']).toObject()
  const d = Math.floor(diff.days ?? 0)
  const h = Math.floor(diff.hours ?? 0)
  const m = Math.floor(diff.minutes ?? 0)
  const parts: string[] = []
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`)
  if (h) parts.push(`${h} h`)
  if (m || parts.length === 0) parts.push(`${m} min`)
  return parts.join(' ')
}

function localTime(utcIso: string): string {
  return DateTime.fromISO(utcIso, { zone: 'utc' }).toLocal().toFormat('ccc d LLL, HH:mm')
}

/**
 * Deliver one reminder. Order matters (spec §5 state machine):
 *   1. write pending→delivered to the database
 *   2. only then show the toast and log it.
 * If the state write fails or someone else already delivered it, nothing is shown.
 */
function deliver(r: Reminder, opts: { missed: boolean; now: DateTime }): void {
  if (!markDelivered(r.id)) {
    log('warn', 'deliver.skipped', 'reminder was no longer pending when we tried to deliver it', r.id)
    return
  }
  const title = r.item_title ?? 'Reminder'
  const scheduled = localTime(r.fire_at_utc)
  const actions = { reminderId: r.id, itemId: r.item_id }
  if (opts.missed) {
    const late = describeLateness(r.fire_at_utc, opts.now)
    log('warn', 'deliver.missed', `"${title}" was due ${scheduled}, delivered ${late} late (app was not running)`, r.id)
    showToast({
      title: `Missed reminder (${late} late)`,
      body: `${title} — was due ${scheduled}.`,
      reminderId: r.id,
      actions,
      persistent: true,
      onClose: () => acknowledgeReminder(r.id)
    })
  } else {
    log('info', 'deliver.ok', `"${title}" due ${scheduled}`, r.id)
    showToast({
      title,
      body: `Reminder — ${scheduled}`,
      reminderId: r.id,
      actions,
      persistent: true,
      onClose: () => acknowledgeReminder(r.id)
    })
  }
  onDeliveredCb?.()
}

/**
 * Startup sweep (spec §5): anything that should have fired while we were not running
 * is delivered now and clearly marked as missed, with how late it is.
 */
export function startupSweep(): number {
  const now = DateTime.utc()
  const due = duePendingReminders(now.toISO()!)
  log('info', 'sweep.start', `${due.length} overdue reminder(s) found at launch`)
  for (const r of due) deliver(r, { missed: true, now })
  const next = nextPendingReminder()
  log(
    'info',
    'sweep.done',
    next ? `next pending reminder: "${next.item_title ?? 'Reminder'}" at ${localTime(next.fire_at_utc)}` : 'no pending reminders'
  )
  return due.length
}

/** One tick: query the table for anything due. Holds no state of its own — SQLite is the truth. */
export function tick(reason = 'interval'): void {
  if (ticking) return
  ticking = true
  try {
    const now = DateTime.utc()
    const due = duePendingReminders(now.toISO()!)
    if (due.length > 0) log('info', 'tick.due', `${due.length} reminder(s) due (${reason})`)
    for (const r of due) {
      // If a tick was delayed by sleep/hibernate by more than one interval, treat as missed.
      const lateMs = now.toMillis() - DateTime.fromISO(r.fire_at_utc, { zone: 'utc' }).toMillis()
      deliver(r, { missed: lateMs > TICK_MS * 2, now })
    }
  } catch (e) {
    log('error', 'tick.exception', (e as Error).stack ?? String(e))
  } finally {
    ticking = false
  }
}

export function startScheduler(onDelivered: () => void): void {
  onDeliveredCb = onDelivered
  if (timer) return
  timer = setInterval(() => tick(), TICK_MS)
  log('info', 'scheduler.started', `ticking every ${TICK_MS / 1000}s`)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  log('info', 'scheduler.stopped')
}
