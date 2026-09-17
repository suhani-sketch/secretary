/**
 * Deadline intelligence unit test (Phase 7b core, `src/core/deadline.ts`) — run with plain Node (type stripping):
 *   node tests/deadline.test.ts
 * Covers: feasibility bands (no_deadline/complete/passed/unknown/comfortable/tight/infeasible and the two distinct
 * routes into "tight"), the bottleneck priority order (a gating wait > a gating step > the largest piece), waits never
 * counted as "parts", open-vs-done blockers, contradictions, and the never-present-an-assumption-as-fact rule.
 */
import assert from 'node:assert/strict'
import { assessDeadline, describeAssessment, hoursText, waitLabel, type DeadlineComponent, type DeadlineInput } from '../src/core/deadline.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const mkComp = (over: Partial<DeadlineComponent> = {}): DeadlineComponent => ({
  id: 'c1',
  title: 'Step',
  kind: 'task',
  status: 'open',
  effort_minutes: null,
  blocked_by: [],
  is_wait: false,
  waiting_on: null,
  expected_utc: null,
  scheduled_minutes: 0,
  ...over
})

const mkInput = (over: Partial<DeadlineInput> = {}): DeadlineInput => ({
  target: { id: 't', title: 'Thing', kind: 'project', due_at_utc: '2026-09-25T18:30:00.000Z', due_precision: 'day' },
  components: [],
  nowUtc: '2026-09-18T10:00:00.000Z',
  capacityMinutes: 600,
  daysLeft: 7,
  ...over
})

// ---- hoursText ----
check('hoursText: minutes under an hour, exact hours, and half-hours', () => {
  assert.equal(hoursText(30), '30 min')
  assert.equal(hoursText(60), '1 h')
  assert.equal(hoursText(90), '1.5 h')
  assert.equal(hoursText(120), '2 h')
  assert.equal(hoursText(45), '45 min')
})

// ---- waitLabel ----
check('waitLabel: a wait is named by who owes the reply, a step by its own title', () => {
  assert.equal(waitLabel(mkComp({ is_wait: true, waiting_on: 'Bob' })), 'the reply from Bob')
  assert.equal(waitLabel(mkComp({ is_wait: true, waiting_on: null })), 'the reply from someone')
  assert.equal(waitLabel(mkComp({ title: 'Attach the document' })), 'Attach the document')
})

// ---- degenerate cases ----
check('no deadline set → feasibility no_deadline, and says so in one sentence', () => {
  const a = assessDeadline(mkInput({ target: { id: 't', title: 'Thing', kind: 'project', due_at_utc: null, due_precision: null } }))
  assert.equal(a.feasibility, 'no_deadline')
  assert.equal(describeAssessment(a), '"Thing" has no deadline set, so there is nothing to reason back from.')
})
check('no components at all → never invents one; says so and asks for the pieces', () => {
  const a = assessDeadline(mkInput({ components: [] }))
  assert.equal(a.total, 0)
  const text = describeAssessment(a, { dueText: 'Fri, 25 Sept' })
  assert.match(text, /no parts listed yet, so I cannot say what is left — tell me the pieces and I will track them\.$/)
})
check('everything done → feasibility complete', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ id: 'a', status: 'done' }), mkComp({ id: 'b', status: 'done' })] }))
  assert.equal(a.feasibility, 'complete')
  assert.equal(describeAssessment(a, { dueText: 'Fri, 25 Sept' }), '"Thing" (Fri, 25 Sept, 7 days left): all 2 listed parts are done.')
})
check('deadline already passed with work still open → feasibility passed, names what is still open', () => {
  const a = assessDeadline(
    mkInput({
      target: { id: 't', title: 'Thing', kind: 'project', due_at_utc: '2026-09-10T00:00:00.000Z', due_precision: 'day' },
      components: [mkComp({ id: 'a', title: 'Finish it', status: 'open' })]
    })
  )
  assert.equal(a.feasibility, 'passed')
  assert.match(a.reasons[0], /the deadline has passed with 1 of 1 still open/)
  assert.match(describeAssessment(a), /The date has passed with Finish it still open\./)
})
check('everything left is a wait → feasibility unknown, never guesses when', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ id: 'w', is_wait: true, waiting_on: 'Priya' })] }))
  assert.equal(a.feasibility, 'unknown')
  assert.deepEqual(a.reasons, ["everything left is in someone else's hands"])
})

// ---- feasibility thresholds ----
check('small workload against a lot of free time → comfortable', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ effort_minutes: 60 })], capacityMinutes: 600 }))
  assert.equal(a.feasibility, 'comfortable')
  assert.match(a.reasons[0], /about 1 h of work left, roughly 10 h free before then/)
})
check('needed minutes over the ratio-0.6 line, no dependency chain → tight, via the ratio reason', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a', effort_minutes: 150 }), mkComp({ id: 'b', effort_minutes: 150 }), mkComp({ id: 'c', effort_minutes: 150 })],
      capacityMinutes: 600
    })
  )
  assert.equal(a.feasibility, 'tight')
  assert.match(a.reasons[0], /about 7\.5 h of work left against roughly 10 h free before then/)
})
check('more needed than free → infeasible, says so plainly', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ effort_minutes: 780 })], capacityMinutes: 600 }))
  assert.equal(a.feasibility, 'infeasible')
  assert.match(a.reasons[0], /about 13 h of work left against roughly 10 h free before then/)
})
check('a long dependent chain takes priority over the plain ratio, with its own distinct reason', () => {
  // A (60 min) blocks B (350 min): the chain alone is 410 min, over 80% of a 500 min capacity — even though the ratio
  // (410/500 = 0.82) also exceeds 0.6, the chain-specific branch must be the one that actually fires, and say so.
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a', title: 'A', effort_minutes: 60 }), mkComp({ id: 'b', title: 'B', effort_minutes: 350, blocked_by: ['a'] })],
      capacityMinutes: 500
    })
  )
  assert.equal(a.feasibility, 'tight')
  assert.equal(a.critical_path_minutes, 410)
  assert.match(a.reasons[0], /the dependent chain alone is/)
})

// ---- blocked / startable / unscheduled ----
check('a blocker that is already done no longer blocks anything', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'd', status: 'done' }), mkComp({ id: 's', title: 'Follow-up', blocked_by: ['d'] })]
    })
  )
  assert.equal(a.blocked.length, 0)
  assert.deepEqual(a.startable.map((c) => c.id), ['s'])
})
check('an open blocker keeps its dependent out of "startable" and into "blocked"', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'd', title: 'Do first' }), mkComp({ id: 's', title: 'Follow-up', blocked_by: ['d'] })]
    })
  )
  assert.deepEqual(a.startable.map((c) => c.id), ['d'])
  assert.equal(a.blocked.length, 1)
  assert.deepEqual(a.blocked[0].blockers.map((b) => b.id), ['d'])
})
check('unscheduled: an open, unblocked step with no time set aside shows up; one that has time does not', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a', title: 'No time yet', scheduled_minutes: 0 }), mkComp({ id: 'b', title: 'Already booked', scheduled_minutes: 60 })]
    })
  )
  assert.deepEqual(a.unscheduled.map((c) => c.id), ['a'])
})
check('waits are never counted as "parts": total/done come from steps only', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a', status: 'done' }), mkComp({ id: 'b', status: 'open' }), mkComp({ id: 'w', is_wait: true, status: 'open' })]
    })
  )
  assert.equal(a.total, 2)
  assert.equal(a.done, 1)
})

// ---- bottleneck priority: a gating wait beats a gating step beats the largest piece ----
check('bottleneck: a wait that gates a step wins, and says it has no expected date', () => {
  const a = assessDeadline(
    mkInput({
      components: [
        mkComp({ id: 'w', is_wait: true, waiting_on: 'Priya' }),
        mkComp({ id: 's', title: 'Follow up', blocked_by: ['w'] }),
        mkComp({ id: 't', title: 'Unrelated big piece', effort_minutes: 500 })
      ]
    })
  )
  assert.equal(a.bottleneck?.kind, 'wait')
  assert.equal(a.bottleneck?.component.id, 'w')
  assert.equal(a.bottleneck?.why, 'it gates one step and has no expected date')
})
check('bottleneck: the same wait, but with an expected date, drops that clause', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'w', is_wait: true, waiting_on: 'Priya', expected_utc: '2026-09-19T00:00:00.000Z' }), mkComp({ id: 's', blocked_by: ['w'] })]
    })
  )
  assert.equal(a.bottleneck?.why, 'it gates one step')
})
check('bottleneck: no waits — a step that gates two others wins over an unrelated bigger piece', () => {
  const a = assessDeadline(
    mkInput({
      components: [
        mkComp({ id: 'a', title: 'Gate' }),
        mkComp({ id: 'b', blocked_by: ['a'] }),
        mkComp({ id: 'c', blocked_by: ['a'] }),
        mkComp({ id: 'd', title: 'Big lone piece', effort_minutes: 500 })
      ]
    })
  )
  assert.equal(a.bottleneck?.kind, 'gate')
  assert.equal(a.bottleneck?.component.id, 'a')
  assert.equal(a.bottleneck?.why, '2 steps wait on it')
})
check('bottleneck: no waits, no dependencies at all — the largest STATED piece wins', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ id: 'a', effort_minutes: 60 }), mkComp({ id: 'b', effort_minutes: 180 })] }))
  assert.equal(a.bottleneck?.kind, 'largest')
  assert.equal(a.bottleneck?.component.id, 'b')
  assert.equal(a.bottleneck?.why, 'the biggest piece left (3 h, your figure)')
})
check('bottleneck: with no dependencies and no stated efforts, there is nothing to name — stays null', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ id: 'a' }), mkComp({ id: 'b' })] }))
  assert.equal(a.bottleneck, null)
})
check('bottleneck: a single remaining piece with nothing gating it is never called a "bottleneck" of one', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ id: 'a', effort_minutes: 120 })] }))
  assert.equal(a.bottleneck, null)
})

// ---- estimates: never presented as the user's own figure when assumed ----
check('a mix of stated and assumed effort: the reasons say how much is assumed, never claim it as given', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a', effort_minutes: 120 }), mkComp({ id: 'b', effort_minutes: null })],
      capacityMinutes: 1000
    })
  )
  assert.equal(a.needed_minutes.stated, 120)
  assert.equal(a.needed_minutes.assumed, 60) // DEFAULT_ASSUMED_EFFORT_MIN
  assert.match(a.reasons[a.reasons.length - 1], /1 h of that is assumed at 60 min a piece — give me your own figures/)
})
check('when every remaining piece is assumed, the reason says "all of that", not a fraction', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ effort_minutes: null })], capacityMinutes: 1000 }))
  assert.match(a.reasons[a.reasons.length - 1], /^all of that is assumed at 60 min a piece/)
})

// ---- contradictions: said first, in every mode, never silently dropped ----
check('a contradiction is voiced before the bottleneck, in full mode', () => {
  const a = assessDeadline(
    mkInput({
      components: [mkComp({ id: 'a' }), mkComp({ id: 'b', blocked_by: ['a'] }), mkComp({ id: 'c', blocked_by: ['a'] })],
      contradictions: ['a note on it says the deadline is really the 20th']
    })
  )
  const text = describeAssessment(a)
  const iContra = text.indexOf('Careful: a note on it says the deadline is really the 20th — which is right?')
  const iBottleneck = text.indexOf('Bottleneck:')
  assert.ok(iContra >= 0 && iBottleneck >= 0 && iContra < iBottleneck)
})
check('a contradiction still appears in bare mode (used inline in get_project)', () => {
  const a = assessDeadline(mkInput({ components: [mkComp()], contradictions: ['it says something else'] }))
  const text = describeAssessment(a, { bare: true })
  assert.match(text, /^Careful: it says something else — which is right?/)
})

// ---- short vs bare: same tail, bare drops only the leading name/progress sentence ----
check('short includes the name+progress line; bare omits only that, keeping everything else', () => {
  const a = assessDeadline(mkInput({ components: [mkComp({ effort_minutes: 700 })], capacityMinutes: 600 }))
  const short = describeAssessment(a, { short: true, dueText: 'Fri, 25 Sept' })
  const bare = describeAssessment(a, { bare: true, dueText: 'Fri, 25 Sept' })
  assert.match(short, /^"Thing" \(Fri, 25 Sept, 7 days left\): 0 of 1 part done\./)
  assert.ok(!bare.startsWith('"Thing"'))
  assert.equal(short.replace(/^.*?parts? done\.\s*/, ''), bare)
})

console.log(`\n${passed} checks passed`)
