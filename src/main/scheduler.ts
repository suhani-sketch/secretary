import { DateTime } from 'luxon'
import { RRule } from 'rrule'
import { log } from './log'
import { showToast } from './notifier'
import * as repo from './repo'
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
 * Recurring reminder: after this occurrence is delivered, queue the next one as a fresh pending row
 * (same rrule), so the table stays the single source of truth and each firing has its own history.
 */
function scheduleNextOccurrence(r: Reminder, now: DateTime): void {
  if (!r.rrule) return
  try {
    const rule = RRule.fromString(`DTSTART:${DateTime.fromISO(r.fire_at_utc, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'")}\nRRULE:${r.rrule}`)
    const next = rule.after(now.toJSDate(), false)
    if (!next) {
      log('info', 'recur.finished', 'no further occurrences', r.id)
      return
    }
    const nr = repo.insertReminder(r.target_id, next.toISOString(), { rrule: r.rrule, offsetMinutes: r.offset_minutes })
    repo.insertActivity({ targetType: 'reminder', targetId: nr.id, verb: 'created', actor: 'system', summary: `Next occurrence of "${r.item_title ?? 'reminder'}" queued for ${localTime(nr.fire_at_utc)}`, after: nr, reversible: false })
    log('info', 'recur.next', `next occurrence at ${localTime(nr.fire_at_utc)}`, nr.id)
  } catch (e) {
    log('error', 'recur.failed', `${r.rrule}: ${(e as Error).message}`, r.id)
  }
}

/**
 * Deliver one reminder. Order matters (spec §5 state machine):
 *   1. write pending→delivered to the database
 *   2. only then show the toast and log it.
 * If the state write fails or someone else already delivered it, nothing is shown.
 */
function deliver(r: Reminder, opts: { missed: boolean; now: DateTime }): void {
  if (!repo.markDelivered(r.id)) {
    log('warn', 'deliver.skipped', 'reminder was no longer pending when we tried to deliver it', r.id)
    return
  }
  const title = r.item_title ?? 'Reminder'
  const scheduled = localTime(r.fire_at_utc)
  const actions = { reminderId: r.id, itemId: r.target_type === 'item' ? r.target_id : null }
  const ack = (): void => {
    repo.acknowledgeReminder(r.id)
    repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'dismissed', actor: 'user', summary: `Dismissed reminder for "${title}"`, reversible: false })
  }
  if (opts.missed) {
    const late = describeLateness(r.fire_at_utc, opts.now)
    log('warn', 'deliver.missed', `"${title}" was due ${scheduled}, delivered ${late} late (app was not running)`, r.id)
    repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'reminder_missed', actor: 'system', summary: `Missed reminder for "${title}" (due ${scheduled}, ${late} late)`, reversible: false })
    const shown = showToast({
      title: `Missed reminder (${late} late)`,
      body: `${title} — was due ${scheduled}. Do it now, or move it?`,
      reminderId: r.id,
      actions,
      persistent: true,
      onClose: ack
    })
    if (!shown) repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'delivery_failed', actor: 'system', summary: `Could not show toast for "${title}"`, reversible: false })
  } else {
    log('info', 'deliver.ok', `"${title}" due ${scheduled}`, r.id)
    repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'reminder_fired', actor: 'system', summary: `Reminder fired for "${title}" (${scheduled})`, reversible: false })
    const shown = showToast({
      title,
      body: `Reminder — ${scheduled}`,
      reminderId: r.id,
      actions,
      persistent: true,
      onClose: ack
    })
    if (!shown) repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'delivery_failed', actor: 'system', summary: `Could not show toast for "${title}"`, reversible: false })
  }
  scheduleNextOccurrence(r, opts.now)
  onDeliveredCb?.()
}

/**
 * Startup sweep (spec §5): anything that should have fired while we were not running
 * is delivered now and clearly marked as missed, with how late it is.
 */
export function startupSweep(): number {
  const now = DateTime.utc()
  const due = repo.duePendingReminders(now.toISO()!)
  log('info', 'sweep.start', `${due.length} overdue reminder(s) found at launch`)
  for (const r of due) deliver(r, { missed: true, now })
  const next = repo.nextPendingReminder()
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
    const due = repo.duePendingReminders(now.toISO()!)
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
