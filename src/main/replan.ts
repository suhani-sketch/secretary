/**
 * Replanning glue (Phase 7f): builds the proposal `core/replan.ts` describes — which sessions would be cleared, which
 * new ones (along the plan's own cadence) would replace them — grading every candidate with the same deterministic
 * `planning.assessSlot` used by 7e, and never even proposing a slot that would land on a hard conflict (invariant 10).
 * Building the proposal writes nothing. Only `commitReplan`, called after the user says yes, touches the database —
 * and it commits EXACTLY the ids the proposal named, never a fresh re-query, so nothing can drift between asking and doing.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { generateSessionSlots } from '../core/plans'
import { assessSlot, constraintWindows } from './planning'
import { describeReplanDone, describeReplanQuestion, planReplan, type GradedSlot, type ReplanProposal, type ReplanSessionRef } from '../core/replan'
import type { CalendarEvent, Constraint, Plan } from '../shared/types'

const minutesOf = (e: CalendarEvent): number => (e.ends_at_utc ? Math.max(0, Math.round((new Date(e.ends_at_utc).getTime() - new Date(e.starts_at_utc).getTime()) / 60_000)) : 0)

/**
 * Candidate slots along the plan's own cadence (not a free-form search — a study plan on Mon/Wed/Fri should get more
 * Mon/Wed/Fri, not a scattered week), each graded; a slot graded 'hard' is skipped and counted, never proposed.
 */
function findReplacementSlots(plan: Plan, clockLocal: string, zone: string, fromUtc: string, need: number, ignoreEventIds: string[]): { slots: GradedSlot[]; skippedHard: number } {
  const slots: GradedSlot[] = []
  let skippedHard = 0
  let cursor = fromUtc
  let guard = 0
  while (slots.length < need && guard < 8) {
    guard++
    const stillNeed = need - slots.length
    // Ask for a little more than we still need, since some candidates will be skipped as hard conflicts.
    const batch = generateSessionSlots({ ...plan, target_minutes: null }, clockLocal, zone, { fromUtc: cursor, max: stillNeed + 3 })
    if (!batch.length) break
    for (const s of batch) {
      if (slots.length >= need) break
      // The sessions this replan would clear are STILL on the calendar at preview time — never mistake one of them for
      // a conflict with its own replacement (this was a real bug: every candidate landed on the very row it was
      // replacing, so nothing but "hard" ever came back).
      const a = assessSlot(s.startUtc, s.endUtc, ignoreEventIds)
      if (a.level === 'hard') {
        skippedHard++
        continue
      }
      slots.push({ startUtc: s.startUtc, level: a.level })
    }
    const last = batch[batch.length - 1]
    if (last.endUtc <= cursor) break // safety: never spin if the generator stops advancing
    cursor = last.endUtc
  }
  return { slots, skippedHard }
}

/** Read-only: works out what a replan would do. Nothing is written. */
export function buildReplanProposal(plan: Plan, fromDateLocal?: string, nowUtc = new Date().toISOString()): ReplanProposal {
  const zone = DateTime.local().zoneName
  const fromUtc = fromDateLocal ? DateTime.fromISO(fromDateLocal, { zone }).startOf('day').toUTC().toISO()! : nowUtc
  const existing = repo.sessionsForPlan(plan.id)
  const removing: ReplanSessionRef[] = existing
    .filter((s) => (s.session_state === 'planned' || s.session_state === 'moved') && s.starts_at_utc >= fromUtc)
    .map((s) => ({ id: s.id, startUtc: s.starts_at_utc }))
  const doneMinutes = existing.filter((s) => s.session_state === 'done').reduce((n, s) => n + minutesOf(s), 0)
  const sessionMinutes = plan.session_minutes ?? 60
  const sample = existing.find((s) => s.starts_at_utc)
  const clock = sample ? DateTime.fromISO(sample.starts_at_utc, { zone: 'utc' }).setZone(zone).toFormat('HH:mm') : repo.getPreference('default_session_time', '17:00').value

  let adding: GradedSlot[] = []
  let skippedHard = 0
  if (removing.length && plan.status === 'active' && plan.rrule && plan.session_minutes) {
    const found = findReplacementSlots(
      plan,
      clock,
      zone,
      fromUtc,
      removing.length,
      removing.map((s) => s.id)
    )
    adding = found.slots
    skippedHard = found.skippedHard
  }
  return planReplan({ planTitle: plan.title, removing, adding, sessionMinutes, doneMinutes, targetMinutes: plan.target_minutes, skippedHardConflicts: skippedHard })
}

const whenLocal = (iso: string): string => DateTime.fromISO(iso, { zone: 'utc' }).setZone(DateTime.local().zoneName).toFormat('ccc d LLL HH:mm')

export const replanQuestion = (p: ReplanProposal): string => describeReplanQuestion(p, whenLocal)
export const replanDoneText = (p: ReplanProposal): string => describeReplanDone(p, whenLocal)

/**
 * 7f trigger: "availability changes". After a new `unavailable` constraint is created, which active plans now have a
 * future session sitting inside it? Never moves anything — just names what a replan would need to fix, so the user can
 * ask for one. Expanded over a 90-day horizon so a recurring constraint ("busy every Tuesday 2–5") is caught too.
 */
export function plansAffectedByConstraint(c: Constraint, nowUtc = new Date().toISOString()): { plan: Plan; count: number }[] {
  const horizonUtc = DateTime.fromISO(nowUtc).plus({ days: 90 }).toISO()!
  const windows = constraintWindows(c, nowUtc, horizonUtc)
  if (!windows.length) return []
  const out: { plan: Plan; count: number }[] = []
  for (const plan of repo.listPlans()) {
    const sessions = repo.sessionsForPlan(plan.id).filter((s) => (s.session_state === 'planned' || s.session_state === 'moved') && s.starts_at_utc >= nowUtc)
    const count = sessions.filter((s) => windows.some((w) => s.starts_at_utc < w.endUtc && w.startUtc < (s.ends_at_utc ?? s.starts_at_utc))).length
    if (count) out.push({ plan, count })
  }
  return out
}

/** Commit EXACTLY what the proposal named — the caller passes back the same `ReplanProposal` it showed the user. */
export function commitReplan(plan: Plan, p: ReplanProposal): void {
  for (const s of p.removing) repo.deleteEventRow(s.id)
  for (const s of p.adding) {
    repo.insertEvent({
      title: plan.title,
      startsAtUtc: s.startUtc,
      endsAtUtc: DateTime.fromISO(s.startUtc, { zone: 'utc' })
        .plus({ minutes: plan.session_minutes ?? 60 })
        .toISO()!,
      allDay: false,
      tz: DateTime.local().zoneName,
      kind: 'session',
      planId: plan.id,
      sessionState: 'planned',
      projectId: plan.project_id
    })
  }
}
