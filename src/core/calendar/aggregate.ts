import { DateTime } from 'luxon'
import type { CalendarEvent, Constraint, DayBundle, Happening, Item, Note, Reminder } from '../../shared/types'
import { expandEvents, scheduledMinutes } from './occurrences'

/**
 * Day aggregation (spec §8 6a). Platform-independent: given the raw records for a window, assemble everything the
 * secretary knows about one local date. Nothing is copied or created — every entry is a reference to an existing row,
 * so the calendar can never drift from the rest of the app.
 *
 * Time-bound and date-bound are different things: a task due Thursday appears under `due` and never occupies schedule
 * time. `status` is descriptive workload (light / normal / busy / overloaded), derived from scheduled hours, due
 * obligations and unavailable constraints. It is never a score.
 */

export interface DayInputs {
  /** Local calendar date "YYYY-MM-DD". */
  date: string
  zone: string
  nowUtc: string
  /** Event series that could touch the day (the caller may over-fetch; expansion filters). */
  events: CalendarEvent[]
  /** Open and done items with a due date on this day, plus open items whose due day has passed (for priorities). */
  items: Item[]
  /** Reminders whose fire time falls on this day. */
  reminders: Reminder[]
  notes: Note[]
  happenings: Happening[]
  constraints: Constraint[]
  waiting: Item[]
}

export function dayWindow(date: string, zone: string): { startUtc: string; endUtc: string } {
  const start = DateTime.fromISO(date, { zone }).startOf('day')
  return { startUtc: start.toUTC().toISO()!, endUtc: start.plus({ days: 1 }).toUTC().toISO()! }
}

const isToday = (date: string, zone: string, nowUtc: string): boolean => DateTime.fromISO(nowUtc, { zone: 'utc' }).setZone(zone).toISODate() === date

/**
 * Descriptive workload, deterministic (spec 6d). Hours are scheduled minutes; load adds a notional 30 minutes per due
 * obligation and 45 per hard deadline so a day with six things due but nothing booked still reads as busy. Unavailable
 * constraints shrink the available day.
 */
export function dayStatus(scheduledMin: number, dueCount: number, hardDeadlines: number, unavailableMin: number): DayBundle['status'] {
  const load = scheduledMin + dueCount * 30 + hardDeadlines * 45
  const available = Math.max(4 * 60, 12 * 60 - unavailableMin) // a waking working day of ~12 h, never less than 4 h
  const ratio = load / available
  if (load === 0) return 'light'
  if (ratio < 0.3) return 'light'
  if (ratio < 0.6) return 'normal'
  if (ratio < 0.9) return 'busy'
  return 'overloaded'
}

/** Minutes of unavailable constraint windows inside the day. Standing (rrule) constraints are expanded by the caller into concrete windows. */
export function unavailableMinutes(constraints: Constraint[], startUtc: string, endUtc: string): number {
  const ds = DateTime.fromISO(startUtc, { zone: 'utc' }).toMillis()
  const de = DateTime.fromISO(endUtc, { zone: 'utc' }).toMillis()
  let total = 0
  for (const c of constraints) {
    if (c.kind !== 'unavailable' || !c.starts_at || !c.ends_at) continue
    const s = Math.max(ds, DateTime.fromISO(c.starts_at, { zone: 'utc' }).toMillis())
    const e = Math.min(de, DateTime.fromISO(c.ends_at, { zone: 'utc' }).toMillis())
    if (e > s) total += e - s
  }
  return Math.round(total / 60_000)
}

export function assembleDay(inp: DayInputs): DayBundle {
  const { startUtc, endUtc } = dayWindow(inp.date, inp.zone)
  const schedule = expandEvents(inp.events, startUtc, endUtc)
  const open = inp.items.filter((i) => i.status === 'open' && !i.is_suggestion)
  const dueToday = open.filter((i) => i.due_at_utc && i.due_at_utc >= startUtc && i.due_at_utc < endUtc && i.kind !== 'waiting')
  const overdue = open.filter((i) => i.due_at_utc && i.due_at_utc < startUtc && i.kind !== 'waiting')
  const completed = inp.items.filter((i) => i.status === 'done' && i.completed_at && i.completed_at >= startUtc && i.completed_at < endUtc)
  // Priorities: what actually matters on this day — hard deadlines and commitments due, then overdue things (today only),
  // then high-importance due items. Deterministic, at most five.
  const weight = (i: Item): number => (i.kind === 'commitment' ? 4 : 0) + (i.hardness === 'hard' ? 3 : 0) + (i.kind === 'deadline' ? 2 : 0) + (i.importance != null ? 3 - Math.min(3, i.importance) : 0)
  const priorityPool = [...dueToday, ...(isToday(inp.date, inp.zone, inp.nowUtc) ? overdue : [])]
  const priorities = priorityPool
    .filter((i) => i.kind === 'commitment' || i.hardness === 'hard' || i.kind === 'deadline' || (i.importance != null && i.importance <= 1) || overdue.includes(i))
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 5)
  const reminders = inp.reminders.filter((r) => r.fire_at_utc >= startUtc && r.fire_at_utc < endUtc && r.state !== 'cancelled')
  const waiting = inp.waiting.filter((w) => w.status === 'open' && (!w.due_at_utc || w.due_at_utc < endUtc))
  const happenings = inp.happenings.filter((h) => h.started_at < endUtc && (h.state === 'running' || (h.ends_at ?? h.started_at) >= startUtc))
  const notes = inp.notes.filter((n) => n.target_type === 'date' && n.target_id === inp.date)
  const constraints = inp.constraints.filter((c) => c.starts_at && c.ends_at && c.starts_at < endUtc && c.ends_at > startUtc)
  const scheduled = scheduledMinutes(schedule, startUtc, endUtc)
  const hard = dueToday.filter((i) => i.hardness === 'hard' || i.kind === 'deadline').length
  return {
    date: inp.date,
    status: dayStatus(scheduled, dueToday.length, hard, unavailableMinutes(constraints, startUtc, endUtc)),
    scheduled_minutes: scheduled,
    priorities,
    due: dueToday.sort((a, b) => weight(b) - weight(a)),
    schedule,
    reminders,
    waiting,
    happenings,
    notes,
    completed,
    constraints
  }
}
