/**
 * Replanning unit test (Phase 7f core, `src/core/replan.ts`) — run with plain Node:
 *   node tests/replan.test.ts
 * Covers: the shortfall-before/after arithmetic, the "nothing to replan" and "no actual change" short-circuits (both
 * must skip asking for approval — there is nothing consequential to approve), the still-short-afterwards flag, and
 * that the confirmation question and the "what happened" sentence both name real times and never claim a slot was
 * booked when the search found nowhere workable.
 */
import assert from 'node:assert/strict'
import { describeReplanDone, describeReplanQuestion, planReplan, type GradedSlot, type ReplanInput, type ReplanSessionRef } from '../src/core/replan.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const ref = (startUtc: string, id = startUtc): ReplanSessionRef => ({ id, startUtc })
const slot = (startUtc: string, level: GradedSlot['level'] = 'clear'): GradedSlot => ({ startUtc, level })
const input = (over: Partial<ReplanInput> = {}): ReplanInput => ({
  planTitle: 'Study econometrics',
  removing: [],
  adding: [],
  sessionMinutes: 120,
  doneMinutes: 0,
  targetMinutes: 1800, // 30 h
  skippedHardConflicts: 0,
  ...over
})
// A trivial "when" formatter so assertions can just check for the raw ISO substring rather than locale formatting.
const when = (iso: string): string => iso

// ---- shortfall arithmetic ----
check('shortfall before/after: covers exactly what the new sessions add up to', () => {
  const p = planReplan(input({ removing: [ref('a'), ref('b')], adding: [slot('x'), slot('y')], doneMinutes: 600 }))
  assert.equal(p.shortfall_before, 1200) // 1800 - 600
  assert.equal(p.covers_minutes, 240) // 2 sessions * 120 min
  assert.equal(p.shortfall_after, 960) // 1200 - 240
  assert.equal(p.still_short, true)
})
check('shortfall_after never goes negative even if more is added than owed', () => {
  const p = planReplan(input({ removing: [ref('a')], adding: [slot('x'), slot('y'), slot('z')], doneMinutes: 1700 }))
  assert.equal(p.shortfall_before, 100)
  assert.equal(p.covers_minutes, 360)
  assert.equal(p.shortfall_after, 0)
  assert.equal(p.still_short, false)
})
check('no target set at all → shortfall fields are null, never a false zero', () => {
  const p = planReplan(input({ targetMinutes: null, removing: [ref('a')], adding: [slot('x')] }))
  assert.equal(p.shortfall_before, null)
  assert.equal(p.shortfall_after, null)
  assert.equal(p.still_short, false)
})

// ---- the two "nothing to approve" short-circuits ----
check('no future sessions at all → nothing_to_replan, and the question says so without asking', () => {
  const p = planReplan(input({ removing: [] }))
  assert.equal(p.nothing_to_replan, true)
  assert.equal(describeReplanQuestion(p, when), '"Study econometrics" has nothing ahead to replan — every future session is already in place.')
})
check('the recomputed cadence lands on exactly the same times → no_change, no approval needed', () => {
  const p = planReplan(input({ removing: [ref('2026-09-23T11:30:00.000Z'), ref('2026-09-25T11:30:00.000Z')], adding: [slot('2026-09-23T11:30:00.000Z'), slot('2026-09-25T11:30:00.000Z')] }))
  assert.equal(p.no_change, true)
  assert.match(describeReplanQuestion(p, when), /nothing would actually move, so there is nothing to approve\.$/)
})
check('same COUNT but different actual times is NOT a no-op — it must still ask', () => {
  const p = planReplan(input({ removing: [ref('2026-09-23T11:30:00.000Z')], adding: [slot('2026-09-24T11:30:00.000Z')] }))
  assert.equal(p.no_change, false)
})
check('fewer sessions added than removed (some slots had nowhere to go) is NOT a no-op', () => {
  const p = planReplan(input({ removing: [ref('2026-09-23T11:30:00.000Z'), ref('2026-09-25T11:30:00.000Z')], adding: [slot('2026-09-23T11:30:00.000Z')] }))
  assert.equal(p.no_change, false)
})

// ---- the question and the done-text name real times, and are honest about a slot that found nowhere to go ----
check('the question lists the exact times on both sides and asks before anything happens', () => {
  const p = planReplan(input({ removing: [ref('2026-09-23T11:30:00.000Z')], adding: [slot('2026-09-24T11:30:00.000Z', 'tight')] }))
  const text = describeReplanQuestion(p, when)
  assert.match(text, /2026-09-23T11:30:00\.000Z/)
  assert.match(text, /2026-09-24T11:30:00\.000Z \(tight\)/)
  assert.match(text, /Nothing moves until you say so — shall I go ahead\?$/)
})
check('nowhere workable found for any replacement: says so plainly, never implies something was booked', () => {
  const p = planReplan(input({ removing: [ref('a'), ref('b')], adding: [] }))
  const text = describeReplanQuestion(p, when)
  assert.match(text, /with nowhere workable found to put them instead\./)
  assert.ok(!text.includes('replaced with')) // never implies a booking happened when none did
})
check('skipped hard conflicts are named, and never silently dropped', () => {
  const p = planReplan(input({ removing: [ref('a')], adding: [slot('x')], skippedHardConflicts: 2 }))
  const text = describeReplanQuestion(p, when)
  assert.match(text, /2 slots that would have landed on something already on your calendar were skipped rather than booked over it\./)
})
check('describeReplanDone: names what was cleared and what replaced it, past tense, after the fact', () => {
  const p = planReplan(input({ removing: [ref('2026-09-23T11:30:00.000Z')], adding: [slot('2026-09-24T11:30:00.000Z')], doneMinutes: 0 }))
  const text = describeReplanDone(p, when)
  assert.match(text, /^Replanned "Study econometrics": cleared 1 session \(2026-09-23T11:30:00\.000Z\) and put 1 new one in their place: 2026-09-24T11:30:00\.000Z\./)
})
check('describeReplanDone still names an unresolved shortfall so it is never quietly hidden after the fact', () => {
  const p = planReplan(input({ removing: [ref('a')], adding: [], doneMinutes: 0, targetMinutes: 1800 }))
  assert.match(describeReplanDone(p, when), /Still 30 h short before the plan ends/)
})

console.log(`\n${passed} checks passed`)
