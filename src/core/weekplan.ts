/**
 * Conversational planning (spec §8 Phase 7g) — platform-independent, no Electron, no SQLite, no model.
 *
 * "Plan my week" starts ONE evolving proposal, not a new plan on every message: this module only computes WHERE things
 * would go, given the week's real availability plus whatever the conversation has added since ("nothing Tuesday", "I
 * have a presentation Thursday"). Nothing here writes anything — the glue layer (`src/main/weekplan.ts`) holds the
 * evolving draft across turns and is the only place that ever commits, and only once the user approves (invariant 10).
 *
 * Placement is a simple greedy pass — most urgent obligation first, earliest free slot, reserve it, move on — using
 * the same day-by-day gap search as 7e (`core/schedule.ts#findFreeWindows`). Grading a placement against buffers and
 * neighbours (clear/tight/poor) is `planning.assessSlot`'s job in the glue layer, exactly as in 7e/7f — duplicating it
 * here would be the "computation in the wrong place" mistake spec §8 warns against.
 */
import { DateTime } from 'luxon'
import { findFreeWindows, type BusyWindow } from './schedule'

export interface Obligation {
  id: string
  title: string
  minutes: number
  minutesAssumed: boolean
  dueUtc: string | null
  duePrecision: string | null
}

/** Something the conversation added this session ("I have a presentation Thursday") — not yet a real event. */
export interface FixedCommitment {
  title: string
  startUtc: string
  endUtc: string
  /** True when the user gave no time — this occupies the whole day rather than guessing a slot within it. */
  allDay: boolean
}

export interface PlacedSlot {
  startUtc: string
  endUtc: string
}

export interface Placement {
  obligation: Obligation
  /** null = nowhere workable was found for it, given everything else already placed/excluded/fixed. */
  slot: PlacedSlot | null
}

export interface PlanWeekInput {
  fromUtc: string
  untilUtc: string
  zone: string
  workStartHour: number
  workEndHour: number
  /** The real calendar's own hard-busy windows (events + unavailable constraints), already expanded. */
  calendarBusy: BusyWindow[]
  /** This conversation's own additions on top of the real calendar, cleared if the plan is discarded. */
  excludedDays: string[]
  fixed: FixedCommitment[]
  /** Most urgent first — the caller sorts (due soonest, then created earliest). */
  obligations: Obligation[]
}

export interface PlanWeekResult {
  placements: Placement[]
  /** Same order as `obligations`, so the caller can zip them back with per-slot grading. */
}

function dayBusy(dayLocalIso: string, zone: string): BusyWindow {
  const d = DateTime.fromISO(dayLocalIso, { zone })
  return { startUtc: d.startOf('day').toUTC().toISO()!, endUtc: d.endOf('day').toUTC().toISO()! }
}

/** Compute the whole draft placement from scratch — cheap enough to just redo after every modification (no diffing). */
export function planWeek(inp: PlanWeekInput): PlanWeekResult {
  let busy: BusyWindow[] = [...inp.calendarBusy, ...inp.fixed.map((f) => ({ startUtc: f.startUtc, endUtc: f.endUtc })), ...inp.excludedDays.map((d) => dayBusy(d, inp.zone))]
  const placements: Placement[] = []
  for (const ob of inp.obligations) {
    // Never search past this obligation's own deadline (if it has one) — placing it "on time" after its due date isn't
    // placing it at all.
    const until = ob.dueUtc && ob.dueUtc < inp.untilUtc ? ob.dueUtc : inp.untilUtc
    if (ob.dueUtc && ob.dueUtc <= inp.fromUtc) {
      placements.push({ obligation: ob, slot: null }) // already overdue — nothing "this week" can fix that
      continue
    }
    const { windows } = findFreeWindows({ fromUtc: inp.fromUtc, untilUtc: until, zone: inp.zone, busy, workStartHour: inp.workStartHour, workEndHour: inp.workEndHour, durationMinutes: ob.minutes, max: 1 })
    if (!windows.length) {
      placements.push({ obligation: ob, slot: null })
      continue
    }
    const startUtc = windows[0].startUtc
    const endUtc = DateTime.fromISO(startUtc, { zone: 'utc' }).plus({ minutes: ob.minutes }).toISO()!
    placements.push({ obligation: ob, slot: { startUtc, endUtc } })
    busy = [...busy, { startUtc, endUtc }] // reserve it so the next obligation can't land on the same time
  }
  return { placements }
}

export type SlotLevel = 'clear' | 'tight' | 'poor'

export interface GradedPlacement {
  obligation: Obligation
  /** null = nowhere workable found. Grading (tight/poor, from buffers/neighbours) is added by the glue layer. */
  slot: (PlacedSlot & { level: SlotLevel }) | null
}

export interface WeekPlanSummary {
  placed: GradedPlacement[]
  unplaced: Obligation[]
  excludedDayCount: number
  fixedCount: number
}

export function summarizeWeekPlan(graded: GradedPlacement[], excludedDayCount: number, fixedCount: number): WeekPlanSummary {
  return { placed: graded.filter((g) => g.slot), unplaced: graded.filter((g) => !g.slot).map((g) => g.obligation), excludedDayCount, fixedCount }
}

const hoursText = (m: number): string => (m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 2) / 2} h`)
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * The whole evolving proposal, as prose. `committed: true` writes it in the past tense for the "do it" reply; the
 * default (false) is the live "here's the plan so far, tell me what to change or say do it" version. Neither ever
 * implies anything happened until `committed` is actually true.
 */
export function describeWeekPlan(s: WeekPlanSummary, when: (iso: string) => string, opts: { committed?: boolean } = {}): string {
  if (!s.placed.length && !s.unplaced.length && !s.fixedCount) {
    return opts.committed ? 'Nothing to commit — there was nothing to place.' : 'Nothing needs placing this week — every open obligation already has time set aside, or there simply is not one.'
  }
  const verb = opts.committed ? 'Booked' : 'Proposed'
  const bits: string[] = []
  if (s.placed.length)
    bits.push(
      `${verb} ${plural(s.placed.length, 'session')}: ${s.placed
        .map((p) => `"${p.obligation.title}" ${when(p.slot!.startUtc)}${p.slot!.level !== 'clear' ? ` (${p.slot!.level})` : ''}${p.obligation.minutesAssumed ? '' : `, ${hoursText(p.obligation.minutes)}`}`)
        .join('; ')}.`
    )
  if (s.unplaced.length) bits.push(`Could not fit ${list(s.unplaced.map((o) => `"${o.title}"`))} in anywhere this week.`)
  if (s.excludedDayCount) bits.push(`Keeping ${plural(s.excludedDayCount, 'day')} free, as asked.`)
  if (s.fixedCount) bits.push(`${plural(s.fixedCount, 'thing')} you mentioned ${opts.committed ? 'went on the calendar too' : 'will go on the calendar too'}.`)
  if (!opts.committed) bits.push('Say what to change, or "do it" to commit — nothing is booked yet.')
  return bits.join(' ')
}
