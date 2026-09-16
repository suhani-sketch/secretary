/**
 * Deadline intelligence (spec §8 Phase 7b) — platform-independent, no Electron, no SQLite.
 *
 * Reason BACKWARDS from a deadline over the components the user actually stated and the `blocks` links between them:
 * what remains, what blocks what, which component is the bottleneck, and whether the trajectory is still feasible given
 * the capacity left. Everything here is computed; the assistant only phrases the result (and `describeAssessment` already
 * does that in code, so answering costs no model call at all).
 *
 * Two rules it never breaks:
 *  - It never invents a component. The list is exactly the parts the user gave; an incomplete list is reported as such.
 *  - An estimate the user did not give is labelled as assumed, never presented as their figure (invariant 2).
 */
import { DateTime } from 'luxon'

export interface DeadlineComponent {
  id: string
  title: string
  kind: string
  status: string
  /** The user's own figure, if they gave one. */
  effort_minutes: number | null
  /** Ids of OPEN components (or waits) that must finish before this one can start. */
  blocked_by: string[]
  /** A waiting item: someone else owes a reply / a delivery. */
  is_wait: boolean
  waiting_on: string | null
  /** Expected reply date for a wait, if known. */
  expected_utc: string | null
  /** Minutes of future work blocks already set aside for this component. */
  scheduled_minutes: number
}

export interface DeadlineInput {
  target: { id: string; title: string; kind: string; due_at_utc: string | null; due_precision: string | null }
  components: DeadlineComponent[]
  nowUtc: string
  /** Free working minutes between now and the deadline, computed by the caller from the calendar. */
  capacityMinutes: number
  /** Whole days between now and the deadline (today counts). */
  daysLeft: number
  /** What to assume for a component with no stated effort. */
  assumedEffortMinutes?: number
}

export type Feasibility = 'comfortable' | 'tight' | 'infeasible' | 'unknown' | 'passed' | 'complete' | 'no_deadline'

export interface Bottleneck {
  component: DeadlineComponent
  /** Plain-language reason, computed: "waiting on Priya gates 2 steps", "3 steps depend on it", "the biggest piece left". */
  why: string
  kind: 'wait' | 'gate' | 'largest'
  gates: number
}

export interface DeadlineAssessment {
  target: DeadlineInput['target']
  days_left: number
  total: number
  done: number
  remaining: DeadlineComponent[]
  blocked: { component: DeadlineComponent; blockers: DeadlineComponent[] }[]
  waits: DeadlineComponent[]
  startable: DeadlineComponent[]
  unscheduled: DeadlineComponent[]
  bottleneck: Bottleneck | null
  /** Longest chain of dependent work, in minutes (stated + assumed). */
  critical_path_minutes: number
  needed_minutes: { stated: number; assumed: number; assumed_count: number; total: number }
  capacity_minutes: number
  feasibility: Feasibility
  reasons: string[]
}

export const DEFAULT_ASSUMED_EFFORT_MIN = 60

/** A wait is spoken of by who owes the reply, never by its long row title. */
export const waitLabel = (c: DeadlineComponent): string => (c.is_wait ? `the reply from ${c.waiting_on ?? 'someone'}` : c.title)

const isOpen = (c: DeadlineComponent): boolean => c.status === 'open' || c.status === 'in_progress' || c.status === 'blocked' || c.status === 'waiting'
const isDone = (c: DeadlineComponent): boolean => c.status === 'done'

export function assessDeadline(inp: DeadlineInput): DeadlineAssessment {
  const assumed = inp.assumedEffortMinutes ?? DEFAULT_ASSUMED_EFFORT_MIN
  const live = inp.components.filter((c) => c.status !== 'cancelled' && c.status !== 'archived')
  const byId = new Map(live.map((c) => [c.id, c]))
  const remaining = live.filter(isOpen)
  const openIds = new Set(remaining.map((c) => c.id))
  const steps = live.filter((c) => !c.is_wait)
  const doneCount = steps.filter(isDone).length
  const effortOf = (c: DeadlineComponent): number => (c.is_wait ? 0 : c.effort_minutes ?? assumed)

  // Blocked = has at least one OPEN blocker among the components (a finished blocker no longer blocks).
  const blocked = remaining
    .filter((c) => !c.is_wait)
    .map((c) => ({ component: c, blockers: c.blocked_by.filter((id) => openIds.has(id)).map((id) => byId.get(id)!).filter(Boolean) }))
    .filter((b) => b.blockers.length)
  const blockedIds = new Set(blocked.map((b) => b.component.id))
  const waits = remaining.filter((c) => c.is_wait)
  const startable = remaining.filter((c) => !c.is_wait && !blockedIds.has(c.id))
  const unscheduled = remaining.filter((c) => !c.is_wait && !blockedIds.has(c.id) && c.scheduled_minutes === 0)

  // Downstream reach: how many open components each one (transitively) gates.
  const dependents = new Map<string, Set<string>>()
  for (const c of remaining) for (const b of c.blocked_by) if (openIds.has(b)) (dependents.get(b) ?? dependents.set(b, new Set()).get(b)!).add(c.id)
  const reach = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of dependents.get(id) ?? []) if (!seen.has(d)) {
      seen.add(d)
      reach(d, seen)
    }
    return seen
  }
  const gates = new Map(remaining.map((c) => [c.id, reach(c.id).size]))

  // Critical path: longest chain of effort through the blocks graph (waits weigh nothing but still order the chain).
  const memo = new Map<string, number>()
  const longestFrom = (id: string, stack = new Set<string>()): number => {
    if (memo.has(id)) return memo.get(id)!
    if (stack.has(id)) return 0 // a cycle cannot exist (the tool layer refuses them) — guard anyway
    stack.add(id)
    const c = byId.get(id)!
    let best = 0
    for (const d of dependents.get(id) ?? []) best = Math.max(best, longestFrom(d, stack))
    stack.delete(id)
    const v = effortOf(c) + best
    memo.set(id, v)
    return v
  }
  const criticalPath = remaining.length ? Math.max(...remaining.map((c) => longestFrom(c.id))) : 0

  // Bottleneck: a wait that gates work beats a gating step beats the biggest remaining piece. Never invented — always one
  // of the user's own components.
  let bottleneck: Bottleneck | null = null
  const gatingWaits = waits.filter((w) => (gates.get(w.id) ?? 0) > 0).sort((a, b) => (gates.get(b.id) ?? 0) - (gates.get(a.id) ?? 0))
  if (gatingWaits.length) {
    const w = gatingWaits[0]
    const n = gates.get(w.id) ?? 0
    bottleneck = { component: w, kind: 'wait', gates: n, why: `it gates ${n === 1 ? 'one step' : `${n} steps`}${w.expected_utc ? '' : ' and has no expected date'}` }
  } else {
    const gating = remaining.filter((c) => !c.is_wait && (gates.get(c.id) ?? 0) > 0).sort((a, b) => (gates.get(b.id) ?? 0) - (gates.get(a.id) ?? 0) || effortOf(b) - effortOf(a))
    if (gating.length) {
      const g = gating[0]
      const n = gates.get(g.id) ?? 0
      bottleneck = { component: g, kind: 'gate', gates: n, why: `${n === 1 ? 'one step waits' : `${n} steps wait`} on it${blockedIds.has(g.id) ? ' and it is itself blocked' : ''}` }
    } else if (remaining.filter((c) => !c.is_wait).length > 1) {
      const largest = [...remaining.filter((c) => !c.is_wait)].sort((a, b) => effortOf(b) - effortOf(a))[0]
      if (largest.effort_minutes) bottleneck = { component: largest, kind: 'largest', gates: 0, why: `the biggest piece left (${hoursText(largest.effort_minutes)}, your figure)` }
    }
  }

  const stated = remaining.filter((c) => !c.is_wait && c.effort_minutes).reduce((s, c) => s + (c.effort_minutes ?? 0), 0)
  const assumedCount = remaining.filter((c) => !c.is_wait && !c.effort_minutes).length
  const needed = { stated, assumed: assumedCount * assumed, assumed_count: assumedCount, total: stated + assumedCount * assumed }

  const reasons: string[] = []
  let feasibility: Feasibility
  const now = DateTime.fromISO(inp.nowUtc)
  const due = inp.target.due_at_utc ? DateTime.fromISO(inp.target.due_at_utc) : null
  if (!due) feasibility = 'no_deadline'
  else if (!remaining.length) feasibility = 'complete'
  else if (due < now) {
    feasibility = 'passed'
    reasons.push(`the deadline has passed with ${remaining.filter((c) => !c.is_wait).length} of ${steps.length} still open`)
  } else if (remaining.every((c) => c.is_wait)) {
    feasibility = 'unknown'
    reasons.push('everything left is in someone else\'s hands')
  } else {
    const ratio = inp.capacityMinutes > 0 ? needed.total / inp.capacityMinutes : Infinity
    if (needed.total > inp.capacityMinutes) {
      feasibility = 'infeasible'
      reasons.push(`about ${hoursText(needed.total)} of work left against roughly ${hoursText(inp.capacityMinutes)} free before then`)
    } else if (criticalPath > inp.capacityMinutes * 0.8 && blocked.length) {
      feasibility = 'tight'
      reasons.push(`the dependent chain alone is ${hoursText(criticalPath)}, close to the ${hoursText(inp.capacityMinutes)} free`)
    } else if (ratio > 0.6) {
      feasibility = 'tight'
      reasons.push(`about ${hoursText(needed.total)} of work left against roughly ${hoursText(inp.capacityMinutes)} free before then`)
    } else {
      feasibility = 'comfortable'
      reasons.push(`about ${hoursText(needed.total)} of work left, roughly ${hoursText(inp.capacityMinutes)} free before then`)
    }
    if (gatingWaits.length && !gatingWaits[0].expected_utc) reasons.push(`${waitLabel(gatingWaits[0])} has no expected date, so the step behind it cannot be timed`)
    if (needed.assumed_count) reasons.push(`${needed.assumed_count === remaining.filter((c) => !c.is_wait).length ? 'all of that' : `${hoursText(needed.assumed)} of that`} is assumed at ${assumed} min a piece — give me your own figures and I will use those`)
  }

  return {
    target: inp.target,
    days_left: inp.daysLeft,
    total: steps.length,
    done: doneCount,
    remaining,
    blocked,
    waits,
    startable,
    unscheduled,
    bottleneck,
    critical_path_minutes: criticalPath,
    needed_minutes: needed,
    capacity_minutes: inp.capacityMinutes,
    feasibility,
    reasons
  }
}

export const hoursText = (minutes: number): string => {
  if (minutes < 60) return `${Math.round(minutes)} min`
  const h = Math.round((minutes / 60) * 2) / 2
  return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)} h`
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The whole assessment as prose, computed — this is the reply. `short` gives the one-line version for context/summaries. */
export function describeAssessment(a: DeadlineAssessment, opts: { short?: boolean; bare?: boolean; dueText?: string | null } = {}): string {
  const name = `"${a.target.title}"`
  const when = opts.dueText ? ` (${opts.dueText}${a.days_left >= 0 && a.feasibility !== 'passed' ? `, ${a.days_left === 0 ? 'today' : `${a.days_left} day${a.days_left === 1 ? '' : 's'} left`}` : ''})` : ''
  if (a.feasibility === 'no_deadline') return `${name} has no deadline set, so there is nothing to reason back from.`
  if (!a.total) return `${name}${when}: no parts listed yet, so I cannot say what is left — tell me the pieces and I will track them.`
  if (a.feasibility === 'complete') return `${name}${when}: all ${a.total} listed parts are done.`
  const progress = `${a.done} of ${a.total} ${a.total === 1 ? 'part' : 'parts'} done`
  const left = a.remaining.filter((c) => !c.is_wait)
  const bits: string[] = []
  if (!opts.bare) bits.push(`${name}${when}: ${progress}.`)
  if (a.feasibility === 'passed') bits.push(`The date has passed with ${list(left.map((c) => c.title))} still open.`)
  if (a.bottleneck) bits.push(`Bottleneck: ${a.bottleneck.kind === 'wait' ? waitLabel(a.bottleneck.component) : `"${a.bottleneck.component.title}"`} — ${a.bottleneck.why}.`)
  if (opts.short || opts.bare) {
    const f = a.feasibility === 'comfortable' ? 'on track' : a.feasibility === 'tight' ? 'tight' : a.feasibility === 'infeasible' ? 'NOT feasible as it stands' : a.feasibility === 'unknown' ? 'depends on others' : ''
    if (f) bits.push(`${f[0].toUpperCase()}${f.slice(1)}${a.reasons.length && a.feasibility !== 'unknown' ? ` — ${a.reasons[0]}` : ''}.`)
    return bits.join(' ')
  }
  if (a.startable.length) bits.push(`Can start now: ${list(a.startable.map((c) => c.title))}.`)
  if (a.blocked.length) bits.push(`Blocked: ${a.blocked.map((b) => `${b.component.title} (after ${list(b.blockers.map((x) => (x.is_wait ? `${x.waiting_on ?? 'someone'} replies` : x.title)))})`).join('; ')}.`)
  if (a.waits.length && a.bottleneck?.kind !== 'wait') bits.push(`Waiting on ${list(a.waits.map((w) => w.waiting_on ?? 'someone'))}.`)
  if (a.feasibility !== 'passed') {
    const verdict =
      a.feasibility === 'comfortable' ? 'Still comfortably feasible' : a.feasibility === 'tight' ? 'Feasible but tight' : a.feasibility === 'infeasible' ? 'Not feasible as it stands' : 'Feasibility depends on others'
    bits.push(`${verdict}: ${a.reasons.join('; ')}.`)
  }
  if (a.unscheduled.length && a.feasibility !== 'comfortable') bits.push(`No time set aside yet for ${list(a.unscheduled.map((c) => c.title))}.`)
  bits.push(`That is everything you have listed — tell me if there are more parts.`)
  return bits.join(' ')
}
