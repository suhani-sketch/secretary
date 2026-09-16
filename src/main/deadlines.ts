/**
 * SQLite glue for deadline intelligence (Phase 7b). Gathers a deadline's components, links, waits, time set aside and the
 * free capacity left on the calendar, then hands everything to the platform-independent `core/deadline.ts`.
 * Nothing here decides anything; it only collects.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { buildSummaries } from './calendar'
import { assessDeadline, describeAssessment, type DeadlineAssessment, type DeadlineComponent } from '../core/deadline'
import { formatDue } from '../shared/format'
import type { Item } from '../shared/types'

/** Workable minutes in a day before anything is booked — an assumption, stated as one wherever it shows. */
export const WORKABLE_MINUTES_PER_DAY = 6 * 60

function component(i: Item, scheduledMin: number): DeadlineComponent {
  const blockers = repo.blockersOf(i.id)
  return {
    id: i.id,
    title: i.title,
    kind: i.kind,
    status: i.status,
    effort_minutes: i.effort_minutes ?? null,
    blocked_by: blockers.map((b) => b.id),
    is_wait: i.kind === 'waiting',
    waiting_on: i.waiting_on ?? null,
    expected_utc: i.kind === 'waiting' ? i.due_at_utc : null,
    scheduled_minutes: scheduledMin
  }
}

/** Free minutes between now and the deadline: per day, the workable allowance minus what is already booked or blocked. */
export function capacityUntil(dueUtc: string | null, nowUtc = new Date().toISOString()): { minutes: number; days: number } {
  const now = DateTime.fromISO(nowUtc).toLocal()
  if (!dueUtc) return { minutes: 0, days: 0 }
  const due = DateTime.fromISO(dueUtc).toLocal()
  const days = Math.max(0, Math.ceil(due.startOf('day').diff(now.startOf('day'), 'days').days)) + 1
  if (due < now) return { minutes: 0, days: 0 }
  const summaries = buildSummaries(now.toISODate()!, Math.min(days, 42))
  let minutes = 0
  summaries.forEach((s, idx) => {
    let allowance = Math.min(WORKABLE_MINUTES_PER_DAY, s.available_minutes)
    // Today: only the part of the working day still ahead (a 22:00 "today" is worth very little).
    if (idx === 0) allowance = Math.min(allowance, Math.max(0, 22 * 60 - (now.hour * 60 + now.minute)))
    minutes += Math.max(0, allowance - s.scheduled_minutes)
  })
  return { minutes, days: days - 1 }
}

/** Assess one deadline: a project (its parts + waits are the components) or a single dated item (itself + its blockers). */
export function assessTarget(id: string, nowUtc = new Date().toISOString()): DeadlineAssessment | null {
  const target = repo.getItem(id)
  if (!target) return null
  let items: Item[]
  if (target.kind === 'project') {
    items = [...repo.projectParts(target.id).filter((c) => c.status !== 'cancelled' && c.status !== 'archived'), ...repo.openWaitingFor(target.id)]
  } else {
    // A standalone deadline: the item itself plus whatever blocks it (transitively), waits included.
    items = [target]
    const seen = new Set([target.id])
    const queue = [target.id]
    while (queue.length) {
      const cur = queue.shift()!
      for (const b of repo.blockersOf(cur)) if (!seen.has(b.id)) {
        seen.add(b.id)
        items.push(b)
        queue.push(b.id)
      }
    }
  }
  const dedup = [...new Map(items.map((i) => [i.id, i])).values()]
  const components = dedup.map((i) => component(i, repo.futureWorkMinutesFor(i.id, nowUtc)))
  const cap = capacityUntil(target.due_at_utc, nowUtc)
  return assessDeadline({
    target: { id: target.id, title: target.title, kind: target.kind, due_at_utc: target.due_at_utc, due_precision: target.due_precision },
    components,
    nowUtc,
    capacityMinutes: cap.minutes,
    daysLeft: cap.days
  })
}

export function assessmentText(a: DeadlineAssessment, mode: 'full' | 'short' | 'bare' = 'full'): string {
  return describeAssessment(a, { short: mode === 'short', bare: mode === 'bare', dueText: a.target.due_at_utc ? formatDue(a.target.due_at_utc, a.target.due_precision as import('../shared/types').DuePrecision | null) : null })
}

/** Deadlines worth surfacing before they are urgent: dated projects and hard/deadline items due within `withinDays`. */
export function upcomingDeadlineTargets(withinDays = 14, nowUtc = new Date().toISOString()): Item[] {
  const end = DateTime.fromISO(nowUtc).plus({ days: withinDays }).toISO()!
  const projects = repo.openProjects(50).filter((p) => p.due_at_utc && p.due_at_utc <= end)
  const items = repo.itemsDueBetween(nowUtc, end, 60).filter((i) => i.kind === 'deadline' || i.hardness === 'hard')
  return [...new Map([...projects, ...items].map((i) => [i.id, i])).values()]
}

/** One line per deadline that is not comfortably on track — the "surface it before it is urgent" list. */
export function atRiskLines(withinDays = 14): { id: string; title: string; text: string; feasibility: string }[] {
  const out: { id: string; title: string; text: string; feasibility: string }[] = []
  for (const t of upcomingDeadlineTargets(withinDays)) {
    const a = assessTarget(t.id)
    if (!a) continue
    const risky = a.feasibility === 'tight' || a.feasibility === 'infeasible' || a.feasibility === 'passed' || (a.feasibility === 'unknown' && a.remaining.length > 0) || a.bottleneck?.kind === 'wait'
    if (risky) out.push({ id: t.id, title: t.title, text: assessmentText(a, 'short'), feasibility: a.feasibility })
  }
  return out
}
