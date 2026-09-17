/**
 * Smart scheduling glue (Phase 7e): finds real candidate times, grades each against buffers and neighbours with
 * `planning.assessSlot` (already deterministic), and writes the proposal as prose. Never books anything — a separate
 * deterministic confirm step (router `slot_proposal` offer) does that, only once the user says so (invariant 10).
 */
import { DateTime } from 'luxon'
import { blockingConflicts, conflictsFor, assessSlot, DEFAULT_BUFFER_MIN, type ConflictLevel } from './planning'
import { findFreeWindows } from '../core/schedule'
import { formatDue } from '../shared/format'

export const WORK_START_HOUR = 8
export const WORK_END_HOUR = 22
const LEVEL_RANK: Record<ConflictLevel, number> = { clear: 0, poor: 1, tight: 2, hard: 3 }

export interface SlotCandidate {
  startUtc: string
  endUtc: string
  level: Exclude<ConflictLevel, 'hard'>
  reasons: string[]
}

export interface SlotProposal {
  title: string
  duration_minutes: number
  deadline_utc: string | null
  deadline_precision: string | null
  feasibility: 'feasible' | 'tight' | 'infeasible'
  pick: SlotCandidate | null
  alternatives: SlotCandidate[]
  total_free_minutes: number
  longest_free_minutes: number
  deadline_passed: boolean
}

export function proposeSlot(opts: { title: string; minutes: number; deadlineUtc: string | null; deadlinePrecision: string | null; nowUtc?: string }): SlotProposal {
  const zone = DateTime.local().zoneName
  const now = opts.nowUtc ?? new Date().toISOString()
  const base: Omit<SlotProposal, 'feasibility' | 'pick' | 'alternatives' | 'total_free_minutes' | 'longest_free_minutes' | 'deadline_passed'> = {
    title: opts.title,
    duration_minutes: opts.minutes,
    deadline_utc: opts.deadlineUtc,
    deadline_precision: opts.deadlinePrecision
  }
  if (opts.deadlineUtc && opts.deadlineUtc <= now) {
    return { ...base, feasibility: 'infeasible', pick: null, alternatives: [], total_free_minutes: 0, longest_free_minutes: 0, deadline_passed: true }
  }
  // No deadline stated: search a two-week horizon rather than forever, and say so in the phrasing.
  const untilUtc = opts.deadlineUtc ?? DateTime.fromISO(now).plus({ days: 14 }).toISO()!
  const fromUtc = now

  const hardConflicts = blockingConflicts(conflictsFor(fromUtc, untilUtc))
  const busy = hardConflicts.map((c) => c.window)

  const { windows, totalFreeMinutes, longestGapMinutes } = findFreeWindows({
    fromUtc,
    untilUtc,
    zone,
    busy,
    workStartHour: WORK_START_HOUR,
    workEndHour: WORK_END_HOUR,
    durationMinutes: opts.minutes,
    max: 12
  })

  const candidates: SlotCandidate[] = []
  for (const w of windows) {
    // A gap bounded by a real preceding event, with room to spare, gets a soft buffer nudge so the proposal doesn't
    // manufacture its own "straight after X" tightness when the gap was actually generous.
    const spare = (new Date(w.endUtc).getTime() - new Date(w.startUtc).getTime()) / 60_000 - opts.minutes
    const nudge = w.precededByBusy && spare >= DEFAULT_BUFFER_MIN ? DEFAULT_BUFFER_MIN : 0
    const startUtc = DateTime.fromISO(w.startUtc, { zone: 'utc' }).plus({ minutes: nudge }).toISO()!
    const endUtc = DateTime.fromISO(startUtc, { zone: 'utc' }).plus({ minutes: opts.minutes }).toISO()!
    const a = assessSlot(startUtc, endUtc)
    if (a.level === 'hard') continue // a real gap should never re-hit a hard conflict; skip defensively if it somehow does
    candidates.push({ startUtc, endUtc, level: a.level, reasons: a.reasons })
  }
  candidates.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.startUtc.localeCompare(b.startUtc))

  const pick = candidates[0] ?? null
  const alternatives: SlotCandidate[] = []
  for (const c of candidates.slice(1)) {
    if (alternatives.length >= 2) break
    const pickDay = pick ? DateTime.fromISO(pick.startUtc, { zone: 'utc' }).setZone(zone).toISODate() : null
    const cDay = DateTime.fromISO(c.startUtc, { zone: 'utc' }).setZone(zone).toISODate()
    if (cDay !== pickDay) alternatives.push(c)
  }

  const feasibility: SlotProposal['feasibility'] = !pick ? 'infeasible' : pick.level === 'tight' ? 'tight' : 'feasible'
  return { ...base, feasibility, pick, alternatives, total_free_minutes: totalFreeMinutes, longest_free_minutes: longestGapMinutes, deadline_passed: false }
}

const when = (iso: string): string => {
  const d = DateTime.fromISO(iso, { zone: 'utc' }).toLocal()
  return d.hasSame(DateTime.local(), 'day') ? `today ${d.toFormat('HH:mm')}` : d.toFormat('ccc d LLL HH:mm')
}
const hoursText = (m: number): string => (m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 2) / 2} h`)
const slotText = (c: SlotCandidate): string => `${when(c.startUtc)}–${DateTime.fromISO(c.endUtc, { zone: 'utc' }).toLocal().toFormat('HH:mm')}`

/** The proposal as prose — computed here, no model call. */
export function describeProposal(p: SlotProposal): string {
  const deadlineText = p.deadline_utc ? formatDue(p.deadline_utc, p.deadline_precision as never) : null
  const name = `${hoursText(p.duration_minutes)} for "${p.title}"`
  if (p.deadline_passed) return `The deadline for "${p.title}" (${deadlineText}) has already passed — I won't schedule against it. Tell me a new date and I'll look again.`
  if (p.feasibility === 'infeasible') {
    const reason =
      p.total_free_minutes < p.duration_minutes
        ? `there's only ${hoursText(p.total_free_minutes)} free in total${deadlineText ? ` before ${deadlineText}` : ' in the next two weeks'}`
        : `there's ${hoursText(p.total_free_minutes)} free in total, but never ${hoursText(p.duration_minutes)} in one uninterrupted stretch — the longest clear gap is ${hoursText(p.longest_free_minutes)}`
    return `I can't fit ${name}${deadlineText ? ` before ${deadlineText}` : ''}: ${reason}. That's infeasible as it stands — something has to give.`
  }
  const pick = p.pick!
  let text = `${name}: ${slotText(pick)} ${pick.level === 'clear' ? 'is free' : 'works'}${deadlineText ? `, before ${deadlineText}` : ''}.`
  if (pick.level === 'poor') text += ` Note — ${pick.reasons.join('; ')}.`
  if (pick.level === 'tight') text += ` It's tight: ${pick.reasons.join('; ')} — the only ${hoursText(p.duration_minutes)} slot I could find${deadlineText ? ` before ${deadlineText}` : ''}.`
  if (p.alternatives.length) text += ` Other options: ${p.alternatives.map((a) => `${slotText(a)}${a.level !== 'clear' ? ` (${a.level})` : ''}`).join(', or ')}.`
  if (!p.deadline_utc) text += ` (No deadline given — this is the next available time in the next two weeks.)`
  text += ` Say the word and I'll book it.`
  return text
}

/** For the confirm step: the exact create_event args a "book it" should replay. */
export function proposalBookingArgs(p: SlotProposal): { starts_at_local: string; ends_at_local: string } | null {
  if (!p.pick) return null
  const zone = DateTime.local().zoneName
  return {
    starts_at_local: DateTime.fromISO(p.pick.startUtc, { zone: 'utc' }).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"),
    ends_at_local: DateTime.fromISO(p.pick.endUtc, { zone: 'utc' }).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")
  }
}

