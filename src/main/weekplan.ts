/**
 * Conversational planning glue (Phase 7g): holds the ONE evolving draft across turns ("Plan my week" → "nothing
 * Tuesday" → "I have a presentation Thursday" → "keep Saturday free" → "okay do it"), recomputing it fresh from the
 * real calendar every time — never a second, competing plan. Building and refining the draft writes nothing at all;
 * only `commitWeekPlan`, reachable only once the user says so, touches the database (invariant 10).
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { assessSlot, blockingConflicts, conflictsFor } from './planning'
import { WORK_END_HOUR, WORK_START_HOUR } from './schedule'
import { DEFAULT_ASSUMED_EFFORT_MIN } from '../core/deadline'
import { planWeek, summarizeWeekPlan, describeWeekPlan, type FixedCommitment, type GradedPlacement, type Obligation, type WeekPlanSummary } from '../core/weekplan'
import type { Item } from '../shared/types'

interface DraftState {
  fromUtc: string
  untilUtc: string
  excludedDays: string[]
  fixed: FixedCommitment[]
  /** Captured once at "plan my week" so the target list doesn't drift mid-conversation; each item's own current due
   *  date/effort/title is re-read fresh on every recompute, in case the user updated one of them along the way. */
  obligationIds: string[]
}

let draft: DraftState | null = null

export const hasActiveWeekPlan = (): boolean => draft !== null
export const discardWeekPlan = (): boolean => {
  const had = draft !== null
  draft = null
  return had
}

function weekStartSetting(): number {
  const v = repo.getSettingValue('calendar.weekStart')
  const n = v !== null ? Number(v) : 1
  return Number.isFinite(n) && n >= 0 && n <= 6 ? n : 1
}

/** The end of the calendar week containing `nowUtc`, per the user's own week-start setting (matches the Week view). */
function endOfThisWeekUtc(nowUtc: string, zone: string): string {
  const now = DateTime.fromISO(nowUtc, { zone: 'utc' }).setZone(zone)
  const weekStartDow = weekStartSetting()
  const todayDow = now.weekday % 7 // luxon: 1=Mon..7=Sun → %7 gives 0=Sun..6=Sat, matching the setting's own convention
  let daysToNextStart = (weekStartDow - todayDow + 7) % 7
  if (daysToNextStart === 0) daysToNextStart = 7 // today IS a week-start day — this is the first day of a fresh week
  return now.plus({ days: daysToNextStart - 1 }).endOf('day').toUTC().toISO()!
}

// A day-only (or looser) due date is stored as that day's local MIDNIGHT — its start, not its end (spec §2 honest
// precision). For SEARCH purposes that means "by end of day", not "before the day has even begun" — using the raw
// timestamp as a search cutoff would exclude the entire due day itself, which briefly happened here.
const effectiveDueUtc = (item: Item): string | null => {
  if (!item.due_at_utc) return null
  if (item.due_precision === 'exact') return item.due_at_utc
  return DateTime.fromISO(item.due_at_utc, { zone: 'utc' }).setZone(DateTime.local().zoneName).endOf('day').toUTC().toISO()!
}

const toObligation = (item: Item): Obligation => ({
  id: item.id,
  title: item.title,
  minutes: item.effort_minutes ?? DEFAULT_ASSUMED_EFFORT_MIN,
  minutesAssumed: !item.effort_minutes,
  dueUtc: effectiveDueUtc(item),
  duePrecision: item.due_precision
})

function gradedFromDraft(d: DraftState): GradedPlacement[] {
  const zone = DateTime.local().zoneName
  const calendarBusy = blockingConflicts(conflictsFor(d.fromUtc, d.untilUtc)).map((c) => c.window)
  const obligations = d.obligationIds
    .map((id) => repo.getItem(id))
    .filter((i): i is Item => !!i && i.status === 'open')
    .map(toObligation)
    .sort((a, b) => (a.dueUtc ?? '9999').localeCompare(b.dueUtc ?? '9999'))
  const { placements } = planWeek({ fromUtc: d.fromUtc, untilUtc: d.untilUtc, zone, workStartHour: WORK_START_HOUR, workEndHour: WORK_END_HOUR, calendarBusy, excludedDays: d.excludedDays, fixed: d.fixed, obligations })
  return placements.map((p) => ({ obligation: p.obligation, slot: p.slot ? { ...p.slot, level: assessSlot(p.slot.startUtc, p.slot.endUtc).level as 'clear' | 'tight' | 'poor' } : null }))
}

const whenLocal = (iso: string): string => DateTime.fromISO(iso, { zone: 'utc' }).setZone(DateTime.local().zoneName).toFormat('ccc d LLL HH:mm')

/** "Plan my week" — always a FRESH draft; superseding whatever draft (if any) was already open. */
export function startWeekPlan(nowUtc = new Date().toISOString()): WeekPlanSummary {
  const zone = DateTime.local().zoneName
  const horizon = DateTime.fromISO(nowUtc).plus({ days: 14 }).toISO()!
  const obligationIds = repo
    .unscheduledObligations(60)
    .filter((i) => i.due_at_utc && i.due_at_utc <= horizon)
    .map((i) => i.id)
  draft = { fromUtc: nowUtc, untilUtc: endOfThisWeekUtc(nowUtc, zone), excludedDays: [], fixed: [], obligationIds }
  return summarizeWeekPlan(gradedFromDraft(draft), 0, 0)
}

export interface RefineOp {
  excludeDayLocal?: string
  addFixed?: { title: string; startsAtUtc: string; endsAtUtc: string; allDay: boolean }
}

/** One modification to the ACTIVE draft. Returns null if there is no draft to refine. */
export function refineWeekPlan(op: RefineOp): WeekPlanSummary | null {
  if (!draft) return null
  if (op.excludeDayLocal && !draft.excludedDays.includes(op.excludeDayLocal)) draft.excludedDays.push(op.excludeDayLocal)
  if (op.addFixed) draft.fixed.push({ title: op.addFixed.title, startUtc: op.addFixed.startsAtUtc, endUtc: op.addFixed.endsAtUtc, allDay: op.addFixed.allDay })
  return summarizeWeekPlan(gradedFromDraft(draft), draft.excludedDays.length, draft.fixed.length)
}

export const weekPlanText = (s: WeekPlanSummary, committed = false): string => describeWeekPlan(s, whenLocal, { committed })

export interface CommitResult {
  summary: WeekPlanSummary
  createdEvents: number
}

/** Only reachable once the user says so. Re-grades everything fresh (minutes may have passed since the last preview,
 *  and something else could have been booked in the meantime) — a placement that is no longer clear/tight/poor is
 *  dropped rather than booked over whatever now occupies it (invariant 10), and counted as unplaced instead. */
export function commitWeekPlan(): CommitResult | null {
  if (!draft) return null
  const zone = DateTime.local().zoneName
  const fresh = gradedFromDraft(draft)
  let createdEvents = 0
  const stillGood: GradedPlacement[] = []
  const droppedAtCommit: Obligation[] = []
  for (const g of fresh) {
    if (!g.slot) {
      stillGood.push(g)
      continue
    }
    const check = assessSlot(g.slot.startUtc, g.slot.endUtc)
    if (check.level === 'hard') {
      droppedAtCommit.push(g.obligation)
      stillGood.push({ obligation: g.obligation, slot: null })
      continue
    }
    repo.insertEvent({ title: g.obligation.title, startsAtUtc: g.slot.startUtc, endsAtUtc: g.slot.endUtc, allDay: false, tz: zone, kind: 'work_block', itemId: g.obligation.id })
    createdEvents++
    stillGood.push(g)
  }
  for (const f of draft.fixed) {
    repo.insertEvent({ title: f.title, startsAtUtc: f.startUtc, endsAtUtc: f.allDay ? null : f.endUtc, allDay: f.allDay, tz: zone })
    createdEvents++
  }
  const summary = summarizeWeekPlan(stillGood, draft.excludedDays.length, draft.fixed.length)
  // Activity logging is the caller's job (tools.ts, via the usual act() helper — same precedent as commitReplan in 7f):
  // this module only writes the rows; it doesn't know the calling actor.
  draft = null
  return { summary, createdEvents }
}
