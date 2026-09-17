/**
 * Conversational planning unit test (Phase 7g core, `src/core/weekplan.ts`) — run with plain Node:
 *   node tests/weekplan.test.ts
 * Covers: the greedy placement (earliest free slot, each one reserved so the next never double-books it), a due date
 * bounding the search to before it (never placed "on time" after the fact), an obligation already overdue never being
 * searched for at all, excluded days and fixed commitments both keeping their windows genuinely clear, and that the
 * proposal/committed sentence never implies a booking that did not happen.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { Obligation, PlanWeekInput, GradedPlacement, FixedCommitment } from '../src/core/weekplan.ts'

// core/weekplan.ts imports core/schedule.ts by the same extensionless relative specifier every core/*.ts file already
// uses — correct for the real build, but Node's own type-stripping (unlike a bundler) won't resolve it unassisted
// when running this file directly. See tests/_ts_ext_loader.mjs for why only this one test file needs this.
register(new URL('./_ts_ext_loader.mjs', import.meta.url))
const { planWeek, summarizeWeekPlan, describeWeekPlan } = await import('../src/core/weekplan.ts')

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const ob = (over: Partial<Obligation> = {}): Obligation => ({
  id: 'x',
  title: 'Task',
  minutes: 60,
  minutesAssumed: false,
  dueUtc: null,
  duePrecision: null,
  ...over
})
const input = (over: Partial<PlanWeekInput> = {}): PlanWeekInput => ({
  fromUtc: '2026-09-18T00:00:00.000Z',
  untilUtc: '2026-09-20T00:00:00.000Z', // Fri 18th + Sat 19th
  zone: 'utc',
  workStartHour: 8,
  workEndHour: 22,
  calendarBusy: [],
  excludedDays: [],
  fixed: [],
  obligations: [],
  ...over
})

// ---- basic placement ----
check('one obligation, nothing else on the calendar, lands at the very start of the workable window', () => {
  const r = planWeek(input({ obligations: [ob({ id: 'a', minutes: 60 })] }))
  assert.equal(r.placements.length, 1)
  assert.deepEqual(r.placements[0].slot, { startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T09:00:00.000Z' })
})
check('two obligations never land on the same time — the second reserves after the first', () => {
  const r = planWeek(input({ obligations: [ob({ id: 'a', minutes: 60 }), ob({ id: 'b', minutes: 60 })] }))
  assert.equal(r.placements[0].slot!.startUtc, '2026-09-18T08:00:00.000Z')
  assert.equal(r.placements[1].slot!.startUtc, '2026-09-18T09:00:00.000Z') // right after the first, not overlapping it
})
check('an obligation bigger than one day spills correctly onto the next workable day', () => {
  // 14 h of workable time on the 18th (08:00-22:00); a 10 h then a 6 h obligation can't both fit on day one.
  const r = planWeek(input({ obligations: [ob({ id: 'a', minutes: 600 }), ob({ id: 'b', minutes: 360 })] }))
  assert.equal(r.placements[0].slot!.startUtc, '2026-09-18T08:00:00.000Z') // 10 h: 08:00-18:00, fits day one
  assert.equal(r.placements[1].slot!.startUtc, '2026-09-19T08:00:00.000Z') // the remaining 4 h on day one isn't enough for 6 h
})

// ---- due dates bound the search ----
check('an obligation due partway through the window is never placed after its own deadline', () => {
  const r = planWeek(
    input({
      calendarBusy: [{ startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T19:00:00.000Z' }], // busy until 19:00, well inside the 08:00-22:00 work day
      obligations: [ob({ id: 'a', minutes: 30, dueUtc: '2026-09-18T19:30:00.000Z' })] // due 30 min after the day's only gap opens
    })
  )
  assert.deepEqual(r.placements[0].slot, { startUtc: '2026-09-18T19:00:00.000Z', endUtc: '2026-09-18T19:30:00.000Z' })
})
check('an obligation whose deadline has already passed is never searched for at all', () => {
  const r = planWeek(input({ fromUtc: '2026-09-18T12:00:00.000Z', obligations: [ob({ id: 'a', minutes: 60, dueUtc: '2026-09-18T10:00:00.000Z' })] }))
  assert.equal(r.placements[0].slot, null)
})
check('nowhere workable before the deadline → correctly reported as unplaced, not pushed past it', () => {
  const r = planWeek(
    input({
      calendarBusy: [{ startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T22:00:00.000Z' }], // the 18th is entirely full
      obligations: [ob({ id: 'a', minutes: 60, dueUtc: '2026-09-18T23:00:00.000Z' })] // due before the 19th even opens
    })
  )
  assert.equal(r.placements[0].slot, null)
})

// ---- excluded days and fixed commitments genuinely keep their windows clear ----
check('an excluded day is never used, even when it would otherwise be the earliest option', () => {
  const r = planWeek(input({ excludedDays: ['2026-09-18'], obligations: [ob({ id: 'a', minutes: 60 })] }))
  assert.equal(r.placements[0].slot!.startUtc, '2026-09-19T08:00:00.000Z')
})
check('a fixed commitment blocks exactly its own window and nothing more', () => {
  const fixed: FixedCommitment = { title: 'Presentation', startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T09:00:00.000Z', allDay: false }
  const r = planWeek(input({ fixed: [fixed], obligations: [ob({ id: 'a', minutes: 60 })] }))
  assert.equal(r.placements[0].slot!.startUtc, '2026-09-18T09:00:00.000Z') // right after the fixed commitment, same day
})
check('an all-day fixed commitment (no time known) clears the whole day, same as excluding it', () => {
  const fixed: FixedCommitment = { title: 'Conference', startUtc: '2026-09-18T00:00:00.000Z', endUtc: '2026-09-18T23:59:59.000Z', allDay: true }
  const r = planWeek(input({ fixed: [fixed], obligations: [ob({ id: 'a', minutes: 60 })] }))
  assert.equal(r.placements[0].slot!.startUtc, '2026-09-19T08:00:00.000Z')
})

// ---- summarize + describe: honesty about what did and did not happen ----
check('summarizeWeekPlan splits placed from unplaced correctly', () => {
  const graded: GradedPlacement[] = [
    { obligation: ob({ id: 'a', title: 'Placed' }), slot: { startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T09:00:00.000Z', level: 'clear' } },
    { obligation: ob({ id: 'b', title: 'Homeless' }), slot: null }
  ]
  const s = summarizeWeekPlan(graded, 1, 2)
  assert.deepEqual(
    s.placed.map((p) => p.obligation.title),
    ['Placed']
  )
  assert.deepEqual(
    s.unplaced.map((o) => o.title),
    ['Homeless']
  )
  assert.equal(s.excludedDayCount, 1)
  assert.equal(s.fixedCount, 2)
})
const when = (iso: string): string => iso
check('nothing to place at all → says so, never a false empty "proposed" sentence', () => {
  const s = summarizeWeekPlan([], 0, 0)
  assert.equal(describeWeekPlan(s, when), 'Nothing needs placing this week — every open obligation already has time set aside, or there simply is not one.')
  assert.equal(describeWeekPlan(s, when, { committed: true }), 'Nothing to commit — there was nothing to place.')
})
check('a mixed result names what was placed, what could not fit, and never claims more than that', () => {
  const graded: GradedPlacement[] = [
    { obligation: ob({ id: 'a', title: 'Report', minutes: 90, minutesAssumed: true }), slot: { startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T09:30:00.000Z', level: 'tight' } },
    { obligation: ob({ id: 'b', title: 'Budget' }), slot: null }
  ]
  const s = summarizeWeekPlan(graded, 1, 1)
  const proposed = describeWeekPlan(s, when)
  assert.match(proposed, /^Proposed 1 session: "Report" 2026-09-18T08:00:00\.000Z \(tight\)\./)
  assert.match(proposed, /Could not fit "Budget" in anywhere this week\./)
  assert.match(proposed, /Keeping 1 day free, as asked\./)
  assert.match(proposed, /1 thing you mentioned will go on the calendar too\./)
  assert.match(proposed, /Say what to change, or "do it" to commit — nothing is booked yet\.$/)
  const committed = describeWeekPlan(s, when, { committed: true })
  assert.match(committed, /^Booked 1 session:/)
  assert.ok(!committed.includes('nothing is booked yet')) // past tense once it is real
})
check('an assumed effort is never quoted as the user\'s own figure in the proposal', () => {
  const graded: GradedPlacement[] = [{ obligation: ob({ title: 'Guessed', minutes: 60, minutesAssumed: true }), slot: { startUtc: '2026-09-18T08:00:00.000Z', endUtc: '2026-09-18T09:00:00.000Z', level: 'clear' } }]
  const s = summarizeWeekPlan(graded, 0, 0)
  assert.ok(!describeWeekPlan(s, when).includes(', 1 h')) // the stated-minutes suffix only appears when NOT assumed
})

console.log(`\n${passed} checks passed`)
