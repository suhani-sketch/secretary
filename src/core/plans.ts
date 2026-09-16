import { DateTime } from 'luxon'
import { nextOccurrenceUtc } from './recurrence'
import type { CalendarEvent, Plan } from '../shared/types'

/**
 * Plans (spec §8 6f). Platform-independent. A plan is a multi-day intention — "study econometrics two hours every Monday,
 * Wednesday and Friday until October 15" — that generates SESSIONS: ordinary `events` rows with kind='session' and a
 * plan_id. Sessions are moved, skipped and completed one at a time; the plan itself is never rewritten by any of that.
 * Progress is hours done against target — planning information, never a streak or a score.
 */

export interface SessionSlot {
  startUtc: string
  endUtc: string
}

/**
 * Where the plan's sessions fall: every occurrence of its cadence from `starts_on` at `clockLocal`, until `ends_on` (inclusive)
 * or until the target effort is covered, whichever comes first. Capped so a runaway rule cannot flood the calendar.
 */
export function generateSessionSlots(plan: Plan, clockLocal: string, tz: string, opts: { fromUtc?: string; max?: number } = {}): SessionSlot[] {
  if (!plan.rrule || !plan.session_minutes) return []
  const anchorLocal = `${plan.starts_on}T${clockLocal}`
  const series = { rrule: plan.rrule, anchorLocal, tz }
  const endLimit = plan.ends_on ? DateTime.fromISO(plan.ends_on, { zone: tz }).endOf('day').toUTC().toISO()! : null
  const max = opts.max ?? 120
  const out: SessionSlot[] = []
  let cursor = opts.fromUtc ?? DateTime.fromISO(anchorLocal, { zone: tz }).minus({ minutes: 1 }).toUTC().toISO()!
  let coveredMin = 0
  for (let i = 0; i < max; i++) {
    const next = nextOccurrenceUtc(series, cursor, true)
    if (!next) break
    if (endLimit && next > endLimit) break
    if (plan.target_minutes && coveredMin >= plan.target_minutes) break
    out.push({ startUtc: next, endUtc: DateTime.fromISO(next, { zone: 'utc' }).plus({ minutes: plan.session_minutes }).toISO()! })
    coveredMin += plan.session_minutes
    cursor = DateTime.fromISO(next, { zone: 'utc' }).plus({ minutes: 1 }).toISO()!
  }
  return out
}

export interface PlanProgress {
  target_minutes: number | null
  done_minutes: number
  planned_minutes: number
  missed_minutes: number
  moved: number
  sessions: { planned: number; done: number; missed: number; total: number }
  /** Target minus done; null when there is no target. Never negative. */
  shortfall_minutes: number | null
  /** Planned-but-not-yet-happened minutes that would still be needed beyond what is scheduled; 0 when the remaining sessions cover the shortfall. */
  unplanned_shortfall_minutes: number | null
  next_session_utc: string | null
  ends_on: string | null
}

const minutesOf = (e: CalendarEvent): number => (e.ends_at_utc ? Math.max(0, Math.round((new Date(e.ends_at_utc).getTime() - new Date(e.starts_at_utc).getTime()) / 60_000)) : 0)

export function planProgress(plan: Plan, sessions: CalendarEvent[], nowUtc: string): PlanProgress {
  const done = sessions.filter((s) => s.session_state === 'done')
  const missed = sessions.filter((s) => s.session_state === 'missed')
  const planned = sessions.filter((s) => s.session_state === 'planned' || s.session_state === 'moved')
  const doneMin = done.reduce((n, s) => n + minutesOf(s), 0)
  const plannedMin = planned.filter((s) => s.starts_at_utc >= nowUtc).reduce((n, s) => n + minutesOf(s), 0)
  const missedMin = missed.reduce((n, s) => n + minutesOf(s), 0)
  const shortfall = plan.target_minutes !== null ? Math.max(0, plan.target_minutes - doneMin) : null
  const next = planned.filter((s) => s.starts_at_utc >= nowUtc).sort((a, b) => a.starts_at_utc.localeCompare(b.starts_at_utc))[0]?.starts_at_utc ?? null
  return {
    target_minutes: plan.target_minutes,
    done_minutes: doneMin,
    planned_minutes: plannedMin,
    missed_minutes: missedMin,
    moved: sessions.filter((s) => s.session_state === 'moved').length,
    sessions: { planned: planned.length, done: done.length, missed: missed.length, total: sessions.length },
    shortfall_minutes: shortfall,
    unplanned_shortfall_minutes: shortfall !== null ? Math.max(0, shortfall - plannedMin) : null,
    next_session_utc: next,
    ends_on: plan.ends_on
  }
}

/** Planned sessions whose end passed more than `graceMinutes` ago without being marked done — they were missed. */
export function sessionsToMarkMissed(sessions: CalendarEvent[], nowUtc: string, graceMinutes = 120): CalendarEvent[] {
  const cutoff = DateTime.fromISO(nowUtc, { zone: 'utc' }).minus({ minutes: graceMinutes }).toISO()!
  return sessions.filter((s) => (s.session_state === 'planned' || s.session_state === 'moved') && (s.ends_at_utc ?? s.starts_at_utc) < cutoff)
}

export const hours = (min: number): string => `${Math.round(min / 6) / 10} h`

/** "6 h done of 30 h · 2 sessions missed · 24 h to go, 20 h of it scheduled" — words, not a bar. */
export function describeProgress(p: PlanProgress): string {
  const bits: string[] = []
  bits.push(p.target_minutes !== null ? `${hours(p.done_minutes)} done of ${hours(p.target_minutes)}` : `${hours(p.done_minutes)} done`)
  if (p.sessions.missed) bits.push(`${p.sessions.missed} session${p.sessions.missed === 1 ? '' : 's'} missed`)
  if (p.shortfall_minutes !== null) {
    if (p.shortfall_minutes === 0) bits.push('target reached')
    else bits.push(`${hours(p.shortfall_minutes)} to go${p.planned_minutes ? `, ${hours(Math.min(p.planned_minutes, p.shortfall_minutes))} of it scheduled` : ''}${p.unplanned_shortfall_minutes ? ` — ${hours(p.unplanned_shortfall_minutes)} not yet placed` : ''}`)
  } else if (p.planned_minutes) bits.push(`${hours(p.planned_minutes)} still scheduled`)
  return bits.join(' · ')
}
