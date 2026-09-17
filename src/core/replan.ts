/**
 * Replanning (spec §8 Phase 7f) — platform-independent, no Electron, no SQLite, no model.
 *
 * When work is missed, a deadline moves, availability changes or a plan falls behind: compute remaining workload
 * against remaining capacity, work out exactly what would move, and say so — but change NOTHING here. This module only
 * describes a proposal; the glue layer (`src/main/replan.ts`) gates the actual write on the user saying yes
 * (invariant 10 — an existing commitment, and a plan's own sessions, are never moved without approval).
 *
 * The candidate replacement slots are computed by the caller (glue), which already has the plan's cadence
 * (`core/plans.ts#generateSessionSlots`) and the calendar's own conflict grading (`planning.assessSlot`) — duplicating
 * either here would be the "computation in the wrong place" mistake spec §8 warns against. This module only turns
 * "these sessions would go, these would come instead" into the workload-vs-capacity arithmetic and the sentence.
 */
export interface ReplanSessionRef {
  id: string
  startUtc: string
}

export interface GradedSlot {
  startUtc: string
  /** A slot graded 'hard' is never passed in here at all — the caller skips it rather than proposing it (invariant 10). */
  level: 'clear' | 'tight' | 'poor'
}

export interface ReplanInput {
  planTitle: string
  /** Future planned/moved sessions that would be cleared, chronological. Done and missed sessions are never touched. */
  removing: ReplanSessionRef[]
  /** New candidate slots found along the plan's own cadence, in the vacated time, already conflict-graded. */
  adding: GradedSlot[]
  /** Minutes each session runs. */
  sessionMinutes: number
  /** Hours already banked (done sessions) as of right now — untouched by this proposal either way. */
  doneMinutes: number
  targetMinutes: number | null
  /** How many further candidate slots were found but skipped because they would have landed on a hard conflict. */
  skippedHardConflicts: number
}

export interface ReplanProposal {
  plan_title: string
  removing: ReplanSessionRef[]
  adding: GradedSlot[]
  covers_minutes: number
  shortfall_before: number | null
  shortfall_after: number | null
  /** After this proposal, would the plan still be short with nothing left to place? */
  still_short: boolean
  any_tight_or_poor: boolean
  skipped_hard_conflicts: number
  /** Nothing to do — the plan has no future sessions to clear (already fully placed, or already over). */
  nothing_to_replan: boolean
  /** The recomputed cadence landed on exactly the same times as before — genuinely nothing would move. */
  no_change: boolean
}

/** Compute the proposal. Read-only in every sense: no side effect, no database, nothing committed. */
export function planReplan(inp: ReplanInput): ReplanProposal {
  const shortfallBefore = inp.targetMinutes !== null ? Math.max(0, inp.targetMinutes - inp.doneMinutes) : null
  const coversMinutes = inp.adding.length * inp.sessionMinutes
  const shortfallAfter = shortfallBefore !== null ? Math.max(0, shortfallBefore - coversMinutes) : null
  const removedTimes = new Set(inp.removing.map((s) => s.startUtc))
  const addedTimes = new Set(inp.adding.map((s) => s.startUtc))
  const noChange = inp.removing.length > 0 && removedTimes.size === addedTimes.size && [...removedTimes].every((t) => addedTimes.has(t))
  return {
    plan_title: inp.planTitle,
    removing: inp.removing,
    adding: inp.adding,
    covers_minutes: coversMinutes,
    shortfall_before: shortfallBefore,
    shortfall_after: shortfallAfter,
    still_short: shortfallAfter !== null && shortfallAfter > 0,
    any_tight_or_poor: inp.adding.some((a) => a.level !== 'clear'),
    skipped_hard_conflicts: inp.skippedHardConflicts,
    nothing_to_replan: inp.removing.length === 0,
    no_change: noChange
  }
}

const hoursText = (m: number): string => (m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 2) / 2} h`)
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/** The confirmation question — computed, asked once, and nothing has happened yet when the user reads it. */
export function describeReplanQuestion(p: ReplanProposal, when: (iso: string) => string): string {
  if (p.nothing_to_replan) return `"${p.plan_title}" has nothing ahead to replan — every future session is already in place.`
  if (p.no_change) return `Recomputing "${p.plan_title}"'s cadence lands on exactly the same times as before — nothing would actually move, so there is nothing to approve.`
  let text = `Replanning "${p.plan_title}": ${plural(p.removing.length, 'session')} ahead — ${list(p.removing.map((s) => when(s.startUtc)))} — would be cleared`
  text += p.adding.length
    ? ` and replaced with ${plural(p.adding.length, 'new session')}: ${list(p.adding.map((s) => `${when(s.startUtc)}${s.level !== 'clear' ? ` (${s.level})` : ''}`))}.`
    : ', with nowhere workable found to put them instead.'
  if (p.covers_minutes) text += ` That's ${hoursText(p.covers_minutes)}${p.shortfall_before !== null ? ` of the ${hoursText(p.shortfall_before)} still owed` : ''}.`
  if (p.still_short && p.shortfall_after !== null) text += ` Even so, it would still be ${hoursText(p.shortfall_after)} short before the plan ends.`
  if (p.skipped_hard_conflicts)
    text += ` ${plural(p.skipped_hard_conflicts, 'slot')} that would have landed on something already on your calendar ${p.skipped_hard_conflicts === 1 ? 'was' : 'were'} skipped rather than booked over it.`
  text += ' Nothing moves until you say so — shall I go ahead?'
  return text
}

/** What actually happened — said only after the write has committed. */
export function describeReplanDone(p: ReplanProposal, when: (iso: string) => string): string {
  if (p.nothing_to_replan) return `Nothing to replan for "${p.plan_title}" — every future session was already in place.`
  if (p.no_change) return `Nothing changed for "${p.plan_title}" — the recomputed cadence landed on exactly the same times as before.`
  let text = `Replanned "${p.plan_title}": cleared ${plural(p.removing.length, 'session')} (${list(p.removing.map((s) => when(s.startUtc)))}) and put ${
    p.adding.length ? `${plural(p.adding.length, 'new one')} in their place: ${list(p.adding.map((s) => when(s.startUtc)))}` : 'nothing back — no workable time was found'
  }.`
  if (p.covers_minutes) text += ` That covers ${hoursText(p.covers_minutes)}.`
  if (p.still_short && p.shortfall_after !== null) text += ` Still ${hoursText(p.shortfall_after)} short before the plan ends — say if you'd like more sessions or a new date.`
  if (p.skipped_hard_conflicts) text += ` ${plural(p.skipped_hard_conflicts, 'slot')} that would have clashed with something on your calendar ${p.skipped_hard_conflicts === 1 ? 'was' : 'were'} skipped.`
  return text
}
