import { DateTime } from 'luxon'
import type { Activity, CalendarEvent, Constraint, DayBundle, DayNote, DayStatus, DaySummary, EventOccurrence, Happening, Item, Note, PriorityEntry, Reminder } from '../../shared/types'
import { expandEvents, scheduledMinutes } from './occurrences'

/**
 * The Day View Model (spec §8 6a). Platform-independent: given the raw records for a window, assemble the complete
 * state of one local date. One function, consumed by every view — Day directly, Week as seven, Month as `summary`,
 * Agenda chronologically. Nothing is copied or created; every entry references an existing row.
 *
 * Four objects stay four shapes (invariant 5): a task due Thursday is `unscheduled`; "Thursday 6–8pm, case study" is a
 * work block in `scheduled`; "remind me Thursday at 5" is in `reminders`; "application due Thursday 5pm" is an item with
 * hardness in `unscheduled` (and in `priorities`). None is converted into another to make it appear.
 *
 * Everything here is deterministic. No model is ever consulted for priorities, load or conflicts.
 */

export interface DayInputs {
  /** Local calendar date "YYYY-MM-DD". */
  date: string
  zone: string
  nowUtc: string
  /** Event series that could touch the day (the caller may over-fetch; expansion filters). */
  events: CalendarEvent[]
  /** Items due on the day, completed/cancelled on the day, plus open items due earlier (the caller over-fetches). */
  items: Item[]
  /** Reminders whose fire time falls on the day, any state except cancelled. */
  reminders: Reminder[]
  /** Notes on the date itself plus notes on items/events that could appear. */
  notes: Note[]
  /** Titles for note targets (item id → title, event id → title) so a note can say what it is on. */
  titles: Record<string, string>
  happenings: Happening[]
  /** Concrete constraint windows (standing rules already expanded by the caller). */
  constraints: Constraint[]
  waiting: Item[]
  /** Open blockers per item id (computed from links by the caller — never stored). */
  blockedIds: Set<string>
  /** Projects referenced by the day's items, with their open-part counts. */
  projects: { project: Item; open_parts: number }[]
  /** Which project each item belongs to (item id → project id). */
  parentOf: Record<string, string>
  /** Activities recorded on the day (history). */
  activities: Activity[]
  /** Rough effort per due item when nothing better is known (minutes). */
  defaultEffortMinutes?: number
}

export function dayWindow(date: string, zone: string): { startUtc: string; endUtc: string } {
  const start = DateTime.fromISO(date, { zone }).startOf('day')
  return { startUtc: start.toUTC().toISO()!, endUtc: start.plus({ days: 1 }).toUTC().toISO()! }
}

const CLOSED = new Set(['done', 'cancelled', 'archived'])

/**
 * Descriptive workload (spec 6d), deterministic. Load = scheduled minutes + estimated due effort (+45 per hard deadline).
 * Capacity = a ~12 h waking day minus unavailable windows, never below 4 h. Never a score; four words.
 */
export function dayStatus(scheduledMin: number, dueEffortMin: number, hardDeadlines: number, availableMin: number): DayStatus {
  const load = scheduledMin + dueEffortMin + hardDeadlines * 45
  if (load === 0) return 'light'
  const ratio = load / Math.max(1, availableMin)
  if (ratio < 0.3) return 'light'
  if (ratio < 0.6) return 'normal'
  if (ratio < 0.9) return 'busy'
  return 'overloaded'
}

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

/** Pairs of timed occurrences that overlap — a genuine double booking. */
export function countConflicts(occ: EventOccurrence[]): number {
  const timed = occ.filter((o) => !o.all_day && o.occurrence_end_utc)
  let n = 0
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) if (timed[i].occurrence_start_utc < timed[j].occurrence_end_utc! && timed[j].occurrence_start_utc < timed[i].occurrence_end_utc!) n++
  return n
}

/** How an occurrence relates to the viewed day: single, starts, continues, ends (spec 6a "multi-day things"). */
export function spanFor(o: EventOccurrence, startUtc: string, endUtc: string): EventOccurrence['span'] {
  const s = o.occurrence_start_utc
  const e = o.occurrence_end_utc ?? s
  const startsToday = s >= startUtc && s < endUtc
  const endsToday = e > startUtc && e <= endUtc
  if (startsToday && endsToday) return 'single'
  if (startsToday) return 'starts'
  if (endsToday) return 'ends'
  return 'continues'
}

/**
 * Priority score — the reasons travel with the number so a view can say why. Overdue-and-unresolved is always pressing.
 * Blocked things rank lower (they cannot be done yet); already-scheduled things rank lower (time is set aside).
 */
export function scoreItem(i: Item, ctx: { overdue: boolean; blocked: boolean; scheduled: boolean; daysToDue: number | null }): PriorityEntry {
  const reasons: string[] = []
  let score = 0
  if (ctx.overdue) {
    score += 50
    reasons.push('overdue')
  }
  if (i.kind === 'commitment') {
    score += 30
    reasons.push(`promised to ${i.committed_to ?? 'someone'}`)
  }
  if (i.hardness === 'hard' || i.kind === 'deadline') {
    score += 25
    reasons.push('hard deadline')
  }
  const imp = i.importance ?? 2
  if (imp <= 0) {
    score += 30
    reasons.push('critical')
  } else if (imp === 1) {
    score += 15
    reasons.push('high importance')
  } else if (imp >= 3) score -= 5
  if (ctx.daysToDue !== null) {
    if (ctx.daysToDue <= 0) score += 10
    else if (ctx.daysToDue === 1) score += 6
    else if (ctx.daysToDue <= 3) score += 3
  }
  if (ctx.blocked) {
    score -= 20
    reasons.push('blocked')
  }
  if (ctx.scheduled) {
    score -= 10
    reasons.push('time set aside')
  }
  return { item: i, score, reasons, overdue: ctx.overdue, blocked: ctx.blocked, scheduled: ctx.scheduled }
}

export function assembleDay(inp: DayInputs): DayBundle {
  const { startUtc, endUtc } = dayWindow(inp.date, inp.zone)
  const today = DateTime.fromISO(inp.nowUtc, { zone: 'utc' }).setZone(inp.zone).toISODate()!
  const isPast = inp.date < today
  const isToday = inp.date === today
  const effort = inp.defaultEffortMinutes ?? 30

  // Time-bound: every occurrence touching the day, with its relation to the day.
  const scheduled = expandEvents(inp.events, startUtc, endUtc).map((o) => ({ ...o, span: spanFor(o, startUtc, endUtc) }))
  const servedItemIds = new Set(scheduled.filter((o) => o.item_id).map((o) => o.item_id!))

  // Date-bound obligations due this day (checklist steps excluded: they live inside their Thing).
  const open = inp.items.filter((i) => !CLOSED.has(i.status) && !i.is_suggestion && i.kind !== 'checklist_item' && i.kind !== 'waiting' && i.kind !== 'note' && i.kind !== 'idea')
  // Unresolved and already overdue NOW, carried into today and every future date until resolved. Something due between
  // today and a future date is not "overdue" on that future date — it is simply still due, and shows on its own day.
  // A past date shows what WAS overdue then only through its history.
  const todayStartUtc = DateTime.fromISO(today, { zone: inp.zone }).startOf('day').toUTC().toISO()!
  // Also overdue: due EARLIER TODAY at an exact time that has passed ("Call Tom at 16:00", viewed at 21:00). The rail
  // calls that overdue and so must the calendar — anything overdue and unresolved is pressing by definition.
  const passedToday = (i: Item): boolean => isToday && i.due_precision === 'exact' && !!i.due_at_utc && i.due_at_utc < inp.nowUtc
  const dueToday = open.filter((i) => i.due_at_utc && i.due_at_utc >= startUtc && i.due_at_utc < endUtc && !passedToday(i))
  const unscheduled = dueToday.filter((i) => !servedItemIds.has(i.id))
  const overdue = isPast ? [] : open.filter((i) => i.due_at_utc && ((i.due_at_utc < startUtc && i.due_at_utc < todayStartUtc) || passedToday(i)))
  // History, never workload: finished (or dropped) on this day, any kind.
  const completed = inp.items.filter((i) => (i.status === 'done' && i.completed_at && i.completed_at >= startUtc && i.completed_at < endUtc) || (i.status === 'cancelled' && i.updated_at >= startUtc && i.updated_at < endUtc))

  const daysToDue = (i: Item): number | null => (i.due_at_utc ? Math.round((DateTime.fromISO(i.due_at_utc, { zone: 'utc' }).setZone(inp.zone).startOf('day').toMillis() - DateTime.fromISO(inp.date, { zone: inp.zone }).toMillis()) / 86_400_000) : null)

  // Priorities: overdue always in; then anything due today that carries weight. Not computed for the past.
  let priorities: PriorityEntry[] = []
  if (!isPast) {
    const pool = [...overdue.map((i) => scoreItem(i, { overdue: true, blocked: inp.blockedIds.has(i.id), scheduled: servedItemIds.has(i.id), daysToDue: daysToDue(i) })), ...dueToday.map((i) => scoreItem(i, { overdue: false, blocked: inp.blockedIds.has(i.id), scheduled: servedItemIds.has(i.id), daysToDue: daysToDue(i) }))]
    priorities = pool.filter((p) => p.overdue || p.reasons.some((r) => r !== 'time set aside' && r !== 'blocked')).sort((a, b) => b.score - a.score || (a.item.due_at_utc ?? '9').localeCompare(b.item.due_at_utc ?? '9'))
  }

  const reminders = inp.reminders.filter((r) => r.fire_at_utc >= startUtc && r.fire_at_utc < endUtc && r.state !== 'cancelled')
  const waiting = isPast ? [] : inp.waiting.filter((w) => w.status === 'open' && (!w.due_at_utc || w.due_at_utc < endUtc))
  const happenings = inp.happenings.filter((h) => h.started_at < endUtc && (h.state === 'running' ? isToday : (h.ends_at ?? h.started_at) >= startUtc))
  const constraints = inp.constraints.filter((c) => c.starts_at && c.ends_at && c.starts_at < endUtc && c.ends_at > startUtc)

  // Notes: on the date itself, and on anything appearing today (items due/overdue/completed, events scheduled).
  const appearingItemIds = new Set([...dueToday, ...overdue, ...completed, ...waiting].map((i) => i.id))
  const appearingEventIds = new Set(scheduled.map((o) => o.id))
  const notes: DayNote[] = inp.notes
    .filter((n) => (n.target_type === 'date' && n.target_id === inp.date) || (n.target_type === 'item' && appearingItemIds.has(n.target_id)) || (n.target_type === 'event' && appearingEventIds.has(n.target_id)))
    .map((n) => ({ note: n, on: n.target_type === 'date' ? 'the date' : (inp.titles[n.target_id] ?? n.target_type), on_kind: n.target_type }))
    .sort((a, b) => (a.on_kind === 'date' ? -1 : 0) - (b.on_kind === 'date' ? -1 : 0))

  // Project context: the Things that today's items belong to.
  const projects = inp.projects
    .map(({ project, open_parts }) => ({ project, open_parts, items_today: [...dueToday, ...overdue].filter((i) => inp.parentOf[i.id] === project.id).map((i) => i.title) }))
    .filter((p) => p.items_today.length)

  const scheduledMin = scheduledMinutes(scheduled, startUtc, endUtc)
  const hardDeadlines = [...dueToday, ...overdue].filter((i) => i.hardness === 'hard' || i.kind === 'deadline').length
  const highImportance = [...dueToday, ...overdue].filter((i) => (i.importance ?? 2) <= 1).length
  const dueEffort = unscheduled.length * effort + overdue.length * effort
  const available = Math.max(4 * 60, 12 * 60 - unavailableMinutes(constraints, startUtc, endUtc))
  const summary: DaySummary = {
    date: inp.date,
    is_past: isPast,
    is_today: isToday,
    priorities: priorities.length,
    due: dueToday.length,
    scheduled: scheduled.filter((o) => o.kind !== 'session' || o.session_state !== 'missed').length,
    reminders: reminders.length,
    overdue: overdue.length,
    completed: completed.length,
    hard_deadlines: hardDeadlines,
    high_importance: highImportance,
    commitments: [...dueToday, ...overdue].filter((i) => i.kind === 'commitment').length,
    scheduled_minutes: scheduledMin,
    due_effort_minutes: dueEffort,
    available_minutes: available,
    conflicts: countConflicts(scheduled),
    status: isPast ? null : dayStatus(scheduledMin, dueEffort, hardDeadlines, available)
  }

  return {
    date: inp.date,
    summary,
    priorities,
    scheduled,
    unscheduled,
    overdue,
    completed,
    reminders,
    waiting,
    happenings,
    notes,
    projects,
    constraints,
    history: isPast || isToday ? inp.activities : []
  }
}
