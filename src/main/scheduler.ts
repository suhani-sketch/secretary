import { DateTime } from 'luxon'
import { nextOccurrenceUtc } from './recurrence'
import { log } from './log'
import { showToast } from './notifier'
import * as repo from './repo'
import type { Reminder } from '../shared/types'
import { doneLineFor } from './ai/tools'

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
    const tz = r.series_tz ?? DateTime.local().zoneName
    const series = {
      rrule: r.rrule,
      anchorLocal: r.series_anchor_local ?? DateTime.fromISO(r.fire_at_utc, { zone: 'utc' }).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm"),
      tz
    }
    // Next occurrence after whichever is later: now, or the slot this firing stood for (a snoozed alarm must not
    // re-queue the occurrence it was snoozed from). Computed in local wall-clock time, so DST does not shift it.
    const scheduled = DateTime.fromISO(r.fire_at_utc, { zone: 'utc' })
    const after = (scheduled > now ? scheduled : now).toISO()!
    const next = nextOccurrenceUtc(series, after, false)
    if (!next) {
      log('info', 'recur.finished', 'no further occurrences', r.id)
      return
    }
    const nr = repo.insertReminder(r.target_id, next, {
      rrule: r.rrule,
      offsetMinutes: r.offset_minutes,
      seriesAnchorLocal: series.anchorLocal,
      seriesTz: series.tz
    })
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
/**
 * Conditional follow-ups (spec 3c): {"unless_resolved": "<item id>"} — evaluated here, against item state in the database,
 * deterministically. Returns a reason string when the reminder must NOT fire, else null.
 */
function conditionBlocks(r: Reminder): string | null {
  if (!r.condition_json) return null
  let cond: { unless_resolved?: string }
  try {
    cond = JSON.parse(r.condition_json) as { unless_resolved?: string }
  } catch {
    log('warn', 'condition.unparseable', r.condition_json, r.id)
    return null // a broken condition must not silence a reminder
  }
  if (cond.unless_resolved) {
    const watched = repo.getItem(cond.unless_resolved)
    if (!watched) return `the watched item no longer exists`
    if (['done', 'cancelled', 'archived'].includes(watched.status)) return `"${watched.title}" was resolved (${watched.status})`
  }
  return null
}

function deliver(r: Reminder, opts: { missed: boolean; now: DateTime }): void {
  const blocked = conditionBlocks(r)
  if (blocked) {
    // The condition failed: retire the follow-up quietly, with a record, and never show a toast.
    repo.cancelReminder(r.id)
    repo.insertActivity({ targetType: 'reminder', targetId: r.id, verb: 'cancelled', actor: 'system', summary: `Follow-up for "${r.item_title ?? 'reminder'}" dropped — ${blocked}`, reversible: false })
    log('info', 'deliver.condition_not_met', `"${r.item_title ?? 'reminder'}": ${blocked}`, r.id)
    onDeliveredCb?.()
    return
  }
  if (!repo.markDelivered(r.id)) {
    log('warn', 'deliver.skipped', 'reminder was no longer pending when we tried to deliver it', r.id)
    return
  }
  const conditional = !!r.condition_json
  const title = conditional ? `Still ${(r.item_title ?? 'waiting').replace(/^Waiting/, 'waiting')}` : (r.item_title ?? 'Reminder')
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
      body: conditional ? `No reply by ${scheduled}. Want to follow up?` : `Reminder — ${scheduled}`,
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
/**
 * Living activities (Phase 5): a timed happening whose time is up ends on its own, with one quiet toast and no buttons.
 * Nothing is written to `activities`, `items` or `reminders` — a happening is not an obligation and leaves no history
 * beyond its own row. `late` = the app was not running when it ended; we say when it finished rather than pretend.
 */
function endDueHappenings(now: DateTime, late: boolean): number {
  const due = repo.dueHappenings(now.toISO()!)
  for (const h of due) {
    const ended = repo.finishHappening(h.id, 'done')
    if (!ended) continue
    const endedAt = DateTime.fromISO(h.ends_at ?? now.toISO()!, { zone: 'utc' }).toLocal().toFormat('HH:mm')
    const lateBy = now.toMillis() - DateTime.fromISO(h.ends_at ?? now.toISO()!, { zone: 'utc' }).toMillis()
    const wasLate = late || lateBy > TICK_MS * 2
    const title = h.metaphor ? doneLineFor(h.label, h.metaphor) : `${capital(h.label)} — time's up.`
    const body = wasLate ? `Finished at ${endedAt}, while I wasn't running.` : `${capital(h.label)} · started ${DateTime.fromISO(h.started_at, { zone: 'utc' }).toLocal().toFormat('HH:mm')}`
    log('info', 'happening.ended', `"${h.label}"${wasLate ? ` (ended ${endedAt}, noticed late)` : ''}`)
    showToast({ title, body, persistent: false })
  }
  if (due.length) onDeliveredCb?.()
  return due.length
}
const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function startupSweep(): number {
  const now = DateTime.utc()
  endDueHappenings(now, true)
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
    endDueHappenings(now, false)
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
