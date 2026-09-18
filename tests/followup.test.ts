/**
 * Missed-task / waiting-item follow-up unit test (Phase 8c core, `src/core/followup.ts`) — run with plain Node:
 *   node tests/followup.test.ts
 * Covers: no entries means no message at all (never an empty "nothing to say" line); singular vs plural phrasing
 * for both missed tasks and stale waits; missed tasks and waits combine into one message when both are present;
 * the tone never says "you failed"; overflow beyond the cap is named honestly, never silently dropped.
 */
import assert from 'node:assert/strict'
import { describeFollowUp } from '../src/core/followup.ts'
import type { FollowUpEntry } from '../src/core/followup.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const task = (title: string, whenLabel = 'was due Thu 17 Sep'): FollowUpEntry => ({ title, kind: 'task', whenLabel })
const wait = (title: string, who: string, whenLabel = 'expected Wed 16 Sep'): FollowUpEntry => ({ title, kind: 'waiting', whenLabel, who })

// ---- honesty: nothing to say means no message at all ----
check('no entries → null, never an empty or manufactured line', () => {
  assert.equal(describeFollowUp([], 0), null)
})

// ---- missed tasks: singular vs plural ----
check('a single missed task', () => {
  const text = describeFollowUp([task('Case study')], 0)
  assert.equal(text, '"Case study" didn\'t get done (was due Thu 17 Sep). We still have time — say what to do with it.')
})
check('multiple missed tasks', () => {
  const text = describeFollowUp([task('Case study'), task('Call the bank', 'was due Fri 18 Sep')], 0)
  assert.match(text!, /^A few things didn't get done: "Case study" \(was due Thu 17 Sep\); "Call the bank" \(was due Fri 18 Sep\)\./)
  assert.match(text!, /with these\.$/)
})

// ---- stale waits: singular vs plural, named by who ----
check('a single stale wait', () => {
  const text = describeFollowUp([wait('the mailing list', 'Priya')], 0)
  assert.equal(text, 'Still no word from Priya on "the mailing list" (expected Wed 16 Sep). We still have time — say what to do with it.')
})
check('multiple stale waits from different people', () => {
  const text = describeFollowUp([wait('the transcript', 'Priya'), wait('budget sign-off', 'the department')], 0)
  assert.match(text!, /^Still waiting to hear from Priya and the department: "the transcript" \(expected Wed 16 Sep\); "budget sign-off" \(expected Wed 16 Sep\)\./)
})
check('a wait with no named person falls back to "them"', () => {
  const text = describeFollowUp([{ title: 'the reply', kind: 'waiting', whenLabel: 'expected Mon' }], 0)
  assert.match(text!, /^Still no word from them on "the reply"/)
})

// ---- missed tasks and stale waits combine into ONE message ----
check('missed tasks and stale waits both present combine into one coherent message, missed first', () => {
  const text = describeFollowUp([task('Case study'), wait('the mailing list', 'Priya')], 0)
  assert.ok(text!.indexOf('Case study') < text!.indexOf('mailing list'))
  assert.match(text!, /didn't get done.*Still no word from Priya/s)
})

// ---- tone: never "you failed", never a guilt line ----
check('the message never contains blame language', () => {
  const text = describeFollowUp([task('Case study'), wait('the transcript', 'Priya')], 2)!
  for (const bad of ['you failed', 'should have', 'broke your streak', "you didn't"]) {
    assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `should not contain "${bad}"`)
  }
  assert.match(text, /We still have time/)
})

// ---- overflow beyond the cap: named honestly, never silently dropped ----
check('overflow beyond the cap is stated, not silently dropped', () => {
  const text = describeFollowUp([task('Case study')], 3)
  assert.match(text!, /3 more are sitting quietly for another day, not forgotten\.$/)
})
check('a single overflow item uses singular grammar', () => {
  const text = describeFollowUp([task('Case study')], 1)
  assert.match(text!, /1 more is sitting quietly for another day, not forgotten\.$/)
})
check('zero overflow adds no trailing overflow sentence', () => {
  const text = describeFollowUp([task('Case study')], 0)
  assert.ok(!text!.includes('sitting quietly'))
})

console.log(`\n${passed} checks passed`)
