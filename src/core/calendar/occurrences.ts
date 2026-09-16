import { DateTime } from 'luxon'
import * as rrulePkg from 'rrule'
import type { RRule as RRuleClass } from 'rrule'
import type { CalendarEvent, EventOccurrence } from '../../shared/types'

/**
 * Expanding event series into occurrences (spec §6). Platform-independent: luxon + rrule only, no Electron, no SQLite.
 *
 * One recurrence engine for the whole app: like reminders and constraints (src/core/recurrence.ts), a series is walked in
 * the event's own wall-clock zone by feeding the rrule library "fake UTC" dates, so a 15:00 weekly meeting stays at 15:00
 * across a daylight-saving change. Exceptions live in `exdates` as the UTC start of the skipped occurrence; a changed
 * occurrence is an exdate plus a standalone event, so the series itself is never rewritten (spec 6e).
 */

const pkg = rrulePkg as unknown as { RRule: typeof RRuleClass; rrulestr: (s: string, opts?: Record<string, unknown>) => RRuleClass; default?: { RRule: typeof RRuleClass; rrulestr: (s: string, opts?: Record<string, unknown>) => RRuleClass } }
const RRule = pkg.RRule ?? pkg.default!.RRule
const rrulestr = pkg.rrulestr ?? pkg.default!.rrulestr

/** Local wall-clock → a Date whose UTC fields carry the local numbers (what rrule wants). */
function toFakeUtc(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second))
}
function fromFakeUtc(d: Date, zone: string): DateTime {
  return DateTime.fromObject({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }, { zone })
}

export function parseExdates(json: string | null): Set<string> {
  if (!json) return new Set()
  try {
    const arr = JSON.parse(json) as unknown
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Every occurrence of `events` that overlaps [fromUtc, toUtc), sorted by start. Non-recurring events appear once. */
export function expandEvents(events: CalendarEvent[], fromUtc: string, toUtc: string): EventOccurrence[] {
  const from = DateTime.fromISO(fromUtc, { zone: 'utc' })
  const to = DateTime.fromISO(toUtc, { zone: 'utc' })
  const out: EventOccurrence[] = []
  for (const e of events) {
    const start = DateTime.fromISO(e.starts_at_utc, { zone: 'utc' })
    const end = e.ends_at_utc ? DateTime.fromISO(e.ends_at_utc, { zone: 'utc' }) : null
    const durationMs = end ? end.toMillis() - start.toMillis() : e.all_day ? 24 * 3600_000 : 60 * 60_000
    if (!e.rrule) {
      const occEnd = start.plus({ milliseconds: durationMs })
      if (occEnd > from && start < to) out.push({ ...e, occurrence_start_utc: e.starts_at_utc, occurrence_end_utc: e.ends_at_utc ?? occEnd.toISO()!, is_recurring_instance: false })
      continue
    }
    const zone = e.tz || 'utc'
    const exdates = parseExdates(e.exdates)
    let rule: RRuleClass
    try {
      const anchorLocal = start.setZone(zone)
      const body = e.rrule.replace(/^RRULE:/i, '')
      rule = rrulestr(`DTSTART:${toFakeUtc(anchorLocal).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}\nRRULE:${body}`)
    } catch {
      continue // an unreadable rule shows nothing rather than something wrong
    }
    // Widen the window by one duration so an occurrence that started before `from` but is still running is included.
    const winFrom = toFakeUtc(from.minus({ milliseconds: durationMs }).setZone(zone))
    const winTo = toFakeUtc(to.setZone(zone))
    const dates = rule.between(winFrom, winTo, true)
    for (const d of dates) {
      const occStart = fromFakeUtc(d, zone).toUTC()
      const occStartIso = occStart.toISO()!
      if (exdates.has(occStartIso)) continue
      const occEnd = occStart.plus({ milliseconds: durationMs })
      if (occEnd <= from || occStart >= to) continue
      out.push({ ...e, occurrence_start_utc: occStartIso, occurrence_end_utc: occEnd.toISO()!, is_recurring_instance: true })
    }
  }
  out.sort((a, b) => a.occurrence_start_utc.localeCompare(b.occurrence_start_utc))
  return out
}

/** Minutes of timed (non all-day) schedule inside a local day, overlapping occurrences merged so a double-booking is not counted twice. */
export function scheduledMinutes(occ: EventOccurrence[], dayStartUtc: string, dayEndUtc: string): number {
  const ds = DateTime.fromISO(dayStartUtc, { zone: 'utc' }).toMillis()
  const de = DateTime.fromISO(dayEndUtc, { zone: 'utc' }).toMillis()
  const spans = occ
    .filter((o) => !o.all_day)
    .map((o) => [Math.max(ds, DateTime.fromISO(o.occurrence_start_utc, { zone: 'utc' }).toMillis()), Math.min(de, DateTime.fromISO(o.occurrence_end_utc ?? o.occurrence_start_utc, { zone: 'utc' }).toMillis())] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let cur: [number, number] | null = null
  for (const sp of spans) {
    if (!cur || sp[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0]
      cur = [sp[0], sp[1]]
    } else cur[1] = Math.max(cur[1], sp[1])
  }
  if (cur) total += cur[1] - cur[0]
  return Math.round(total / 60_000)
}

export { RRule }
