/**
 * "What should I do right now?" unit test (Phase 7c core, `src/core/now.ts`) — run with plain Node (type stripping):
 *   node tests/now.test.ts
 * Everything runs in the 'utc' zone so results never depend on the machine's own timezone (recurrence.test.ts's
 * lesson). Covers: ranking order (overdue > promise > plain), blockers, attendance/fixed-time exclusion, the free-
 * window-before-the-next-thing rules, time-of-day and low-energy weighting, and the "nothing can start" honesty path.
 */
import assert from 'node:assert/strict'
import { bandFor, describeRecommendation, recommendNow, type NowCandidate, type NowInput } from '../src/core/now.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const mk = (over: Partial<NowCandidate> = {}): NowCandidate => ({
  id: 'x',
  title: 'Task',
  kind: 'task',
  importance: 2,
  hardness: null,
  due_at_utc: null,
  due_precision: null,
  effort_minutes: null,
  blocked_by: [],
  committed_to: null,
  unblocks: 0,
  scheduled_now: false,
  project: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over
})

const input = (over: Partial<NowInput> = {}): NowInput => ({
  nowUtc: '2026-09-18T14:00:00.000Z', // Friday 14:00 UTC → band 'day' — no time-of-day weighting to account for
  zone: 'utc',
  candidates: [],
  freeMinutes: null,
  nextBusy: null,
  inEvent: null,
  context: { energyLow: false, texts: [] },
  ...over
})

// ---- bandFor ----
check('bandFor: the four bands split on the documented UTC hours', () => {
  assert.equal(bandFor('2026-01-01T06:59:00.000Z', 'utc'), 'night')
  assert.equal(bandFor('2026-01-01T07:00:00.000Z', 'utc'), 'morning')
  assert.equal(bandFor('2026-01-01T11:59:00.000Z', 'utc'), 'morning')
  assert.equal(bandFor('2026-01-01T12:00:00.000Z', 'utc'), 'day')
  assert.equal(bandFor('2026-01-01T17:59:00.000Z', 'utc'), 'day')
  assert.equal(bandFor('2026-01-01T18:00:00.000Z', 'utc'), 'evening')
  assert.equal(bandFor('2026-01-01T20:59:00.000Z', 'utc'), 'evening')
  assert.equal(bandFor('2026-01-01T21:00:00.000Z', 'utc'), 'night')
})
check('bandFor: a zone conversion is actually applied, not just the UTC hour', () => {
  // 14:00 UTC is 19:30 IST (Asia/Kolkata, UTC+5:30) — evening there, day here.
  assert.equal(bandFor('2026-01-01T14:00:00.000Z', 'utc'), 'day')
  assert.equal(bandFor('2026-01-01T14:00:00.000Z', 'Asia/Kolkata'), 'evening')
})

// ---- basic ranking order ----
check('an overdue item outranks a non-overdue critical one', () => {
  const overdue = mk({ id: 'a', title: 'Overdue thing', due_at_utc: '2026-09-17T09:00:00.000Z', due_precision: 'exact' })
  const critical = mk({ id: 'b', title: 'Critical thing', importance: 0 })
  const r = recommendNow(input({ candidates: [overdue, critical] }))
  assert.equal(r.pick?.candidate.id, 'a')
  assert.equal(r.pick!.score, 50) // overdue +50 only — day band, no other modifiers apply
  assert.match(r.pick!.reasons[0], /^overdue \(was/)
})
check('a promise (commitment) scores 30 and names who it is to', () => {
  const c = mk({ kind: 'commitment', committed_to: 'Priya' })
  const r = recommendNow(input({ candidates: [c] }))
  assert.equal(r.pick!.score, 30)
  assert.ok(r.pick!.reasons.includes('promised to Priya'))
})
check('an idea IS ranked (unlike a project/wait/note) but actively penalised, and a plain task still wins', () => {
  const idea = mk({ id: 'idea', kind: 'idea' })
  const rSolo = recommendNow(input({ candidates: [idea] }))
  assert.equal(rSolo.pick!.score, -25) // penalised, but still a candidate — never silently dropped
  const plain = mk({ id: 'plain' })
  const r = recommendNow(input({ candidates: [idea, plain] }))
  assert.equal(r.pick?.candidate.id, 'plain')
})
check('projects, waits and notes never enter the ranking at all (not "possible" work to start)', () => {
  const r = recommendNow(
    input({
      candidates: [mk({ id: 'p', kind: 'project' }), mk({ id: 'w', kind: 'waiting' }), mk({ id: 'n', kind: 'note' })]
    })
  )
  assert.equal(r.pick, null)
  assert.deepEqual(r.excluded, [])
  assert.equal(r.none_reason, 'Nothing you can start right now: .') // no excluded reasons either — they were never candidates
})
check('unblocks: capped at 3 even when it gates more than three other things', () => {
  const few = mk({ id: 'few', unblocks: 1 })
  const many = mk({ id: 'many', unblocks: 7 })
  const rFew = recommendNow(input({ candidates: [few] }))
  const rMany = recommendNow(input({ candidates: [many] }))
  assert.equal(rFew.pick!.score, 8)
  assert.equal(rMany.pick!.score, 24) // min(3, 7) * 8 for the SCORE — the wording still reports the true count
  assert.ok(rMany.pick!.reasons.includes('unblocks 7 other things'))
})

// ---- blockers ----
check('a blocked item is set aside, never picked, and its reason says what it waits on', () => {
  const blocked = mk({ id: 'b', title: 'Blocked thing', blocked_by: ['the reply from Priya'] })
  const open = mk({ id: 'o', title: 'Open thing' })
  const r = recommendNow(input({ candidates: [blocked, open] }))
  assert.equal(r.pick?.candidate.id, 'o')
  assert.deepEqual(
    r.excluded.map((e) => e.why),
    ['waits on the reply from Priya']
  )
})
check('everything blocked → no pick, and the honest reason lists every blocker', () => {
  const a = mk({ id: 'a', title: 'A', blocked_by: ['X'] })
  const b = mk({ id: 'b', title: 'B', blocked_by: ['Y'] })
  const r = recommendNow(input({ candidates: [a, b] }))
  assert.equal(r.pick, null)
  assert.equal(r.none_reason, 'Nothing you can start right now: A waits on X; B waits on Y.')
})

// ---- attendance / fixed-time exclusion ----
check('an attendance-style title is excluded as "not work to start", however soon it is', () => {
  const meeting = mk({ title: 'Team meeting with Bob', due_at_utc: '2026-09-18T14:20:00.000Z', due_precision: 'exact' })
  const r = recommendNow(input({ candidates: [meeting] }))
  assert.equal(r.pick, null)
  assert.match(r.excluded[0].why, /^is something you attend \(.*\), not work to start$/)
})
check('a plain (non-attendance) task fixed more than two hours out is excluded as fixed, not offered', () => {
  const c = mk({ title: 'Submit the visa form', due_at_utc: '2026-09-18T17:00:00.000Z', due_precision: 'exact' }) // 3h out
  const r = recommendNow(input({ candidates: [c] }))
  assert.equal(r.pick, null)
  assert.match(r.excluded[0].why, /^is fixed for/)
})
check('a plain task fixed within two hours is NOT excluded by the fixed-time rule', () => {
  const c = mk({ title: 'Submit the visa form', due_at_utc: '2026-09-18T15:30:00.000Z', due_precision: 'exact' }) // 90 min out
  const r = recommendNow(input({ candidates: [c] }))
  assert.equal(r.pick?.candidate.id, 'x')
})
check('day-precision due dates are never treated as "fixed", however the words read', () => {
  const c = mk({ title: 'A meeting prep note', due_at_utc: '2026-09-18T00:00:00.000Z', due_precision: 'day' })
  const r = recommendNow(input({ candidates: [c] }))
  // "meeting" is in the title, so ATTENDANCE still excludes it — use a clean title to isolate the due_precision rule.
  assert.equal(r.excluded[0]?.why.startsWith('is something you attend'), true)
  const c2 = mk({ title: 'Prep notes', due_at_utc: '2026-09-18T00:00:00.000Z', due_precision: 'day' })
  const r2 = recommendNow(input({ candidates: [c2] }))
  assert.equal(r2.pick?.candidate.id, 'x')
})

// ---- inside an event ----
check('inside a meeting: only a genuinely tiny thing (<=10 min) can start', () => {
  const tiny = mk({ id: 'tiny', effort_minutes: 5 })
  const big = mk({ id: 'big', effort_minutes: 30 })
  const r = recommendNow(input({ candidates: [tiny, big], inEvent: { title: 'Faculty meeting', endsUtc: null } }))
  assert.equal(r.pick?.candidate.id, 'tiny')
  assert.equal(r.excluded.length, 1)
  assert.equal(r.excluded[0].why, 'you\'re in "Faculty meeting" right now')
})
check('none can start inside the meeting → the none_reason names the meeting, not just the excluded list', () => {
  const big = mk({ effort_minutes: 60 })
  const r = recommendNow(input({ candidates: [big], inEvent: { title: 'Faculty meeting', endsUtc: null } }))
  assert.equal(r.pick, null)
  assert.match(r.none_reason!, /^Nothing to start right now — you're in "Faculty meeting"/)
})

// ---- the free window before the next fixed thing ----
check('free window under 15 min: something that cannot even start is set aside with the exact wait quoted', () => {
  const c = mk({ effort_minutes: 30 })
  const r = recommendNow(input({ candidates: [c], freeMinutes: 10, nextBusy: { title: 'Call with Priya', startsUtc: '2026-09-18T14:10:00.000Z' } }))
  assert.equal(r.pick, null)
  assert.equal(r.excluded[0].why, 'needs about 30 min and "Call with Priya" starts in 10 min')
})
check('free window under 15 min: something that DOES fit gets a "fits in" reason and a small bonus', () => {
  const c = mk({ effort_minutes: 5 })
  const r = recommendNow(input({ candidates: [c], freeMinutes: 10, nextBusy: { title: 'Call with Priya', startsUtc: '2026-09-18T14:10:00.000Z' } }))
  assert.equal(r.pick?.score, 8)
  assert.ok(r.pick!.reasons.some((x) => x.includes('fits in the 10 min before "Call with Priya"')))
})
check('free window of 20 min, a 30 min job: allowed (not under the 15 min hard cutoff) but penalised, not excluded', () => {
  const c = mk({ effort_minutes: 30 })
  const r = recommendNow(input({ candidates: [c], freeMinutes: 20, nextBusy: { title: 'Call with Priya', startsUtc: '2026-09-18T14:20:00.000Z' } }))
  assert.equal(r.pick?.candidate.id, 'x')
  assert.equal(r.pick!.score, -12)
  assert.ok(r.pick!.reasons.some((x) => x.includes("won't finish before \"Call with Priya\"")))
})
check('a long free window (>180 min) never bothers mentioning "fits in" — that would just be noise', () => {
  const c = mk({ effort_minutes: 30 })
  const r = recommendNow(input({ candidates: [c], freeMinutes: 200, nextBusy: { title: 'Dinner', startsUtc: '2026-09-18T17:20:00.000Z' } }))
  assert.equal(r.pick!.score, 8)
  assert.ok(!r.pick!.reasons.some((x) => x.includes('fits in')))
})

// ---- time of day ----
check('night band: a >45 min job is penalised, a <=20 min job is promoted with "it\'s late"', () => {
  const big = mk({ id: 'big', effort_minutes: 60 })
  const small = mk({ id: 'small', effort_minutes: 15 })
  const r = recommendNow(input({ nowUtc: '2026-09-18T22:00:00.000Z', candidates: [big, small] })) // 22:00 UTC → night
  assert.equal(r.pick?.candidate.id, 'small')
  assert.equal(r.pick!.score, 10)
  assert.ok(r.pick!.reasons.includes("it's late — a small one"))
})
check('morning band: a big, important job gets a small nudge up ("a big one for a fresh morning")', () => {
  const c = mk({ effort_minutes: 90, importance: 1 })
  const r = recommendNow(input({ nowUtc: '2026-09-18T08:00:00.000Z', candidates: [c] })) // 08:00 UTC → morning
  assert.equal(r.pick!.score, 15 + 6) // importance=1 → +15, morning nudge → +6
  assert.ok(r.pick!.reasons.includes('a big one for a fresh morning'))
})
check('evening band: anything over 2 hours is quietly penalised', () => {
  const c = mk({ effort_minutes: 150 })
  const r = recommendNow(input({ nowUtc: '2026-09-18T19:00:00.000Z', candidates: [c] })) // 19:00 UTC → evening
  assert.equal(r.pick!.score, -8)
})

// ---- low energy ----
check('low energy: a >=45 min job is penalised and the reply explains why it is still the pick', () => {
  const c = mk({ effort_minutes: 60 })
  const r = recommendNow(input({ candidates: [c], context: { energyLow: true, texts: ['exhausted'] } }))
  assert.equal(r.pick!.score, -20)
  const text = describeRecommendation(r)
  assert.match(text, /You said you're low today — this is the smallest thing that's actually open/)
})
check('low energy: a <=20 min job is promoted and named as light', () => {
  const c = mk({ effort_minutes: 15 })
  const r = recommendNow(input({ candidates: [c], context: { energyLow: true, texts: [] } }))
  assert.equal(r.pick!.score, 10)
  assert.ok(r.pick!.reasons.includes('light enough for a low day'))
})

// ---- a running work block always wins ----
check('a work block already running for it outranks everything else, including an overdue item', () => {
  const running = mk({ id: 'run', scheduled_now: true })
  const overdue = mk({ id: 'od', due_at_utc: '2026-09-01T00:00:00.000Z', due_precision: 'exact' })
  const r = recommendNow(input({ candidates: [running, overdue] }))
  assert.equal(r.pick?.candidate.id, 'run')
  assert.ok(r.pick!.reasons.includes('you set this time aside for it'))
})

// ---- alternatives ----
check('a close runner-up (within 12 points) is offered as an alternative; a distant one is not', () => {
  const pick = mk({ id: 'pick', title: 'Pick', importance: 0 }) // +30
  const close = mk({ id: 'close', title: 'Close', unblocks: 3 }) // +24 — 6 points off pick, within the 12-point window
  const far = mk({ id: 'far', title: 'Far' }) // +0 — 30 points off, well outside it
  const r = recommendNow(input({ candidates: [pick, close, far] }))
  assert.equal(r.pick?.candidate.id, 'pick')
  assert.deepEqual(
    r.alternatives.map((a) => a.candidate.id),
    ['close']
  )
  const text = describeRecommendation(r)
  assert.match(text, /If not that: Close \(/)
})

// ---- describeRecommendation: the honest "nothing" paths ----
check('describeRecommendation: nothing open at all', () => {
  const r = recommendNow(input({ candidates: [] }))
  assert.equal(describeRecommendation(r), 'Nothing open at all.')
})
check('describeRecommendation: nothing open at night adds the "no push" line', () => {
  const r = recommendNow(input({ nowUtc: '2026-09-18T22:00:00.000Z', candidates: [] }))
  assert.equal(describeRecommendation(r), "Nothing open at all. It's late — nothing here needs tonight.")
})
check('describeRecommendation: an assumed effort is never presented as the user\'s own figure', () => {
  const withFigure = mk({ effort_minutes: 45 })
  const assumed = mk({ effort_minutes: null })
  const rf = recommendNow(input({ candidates: [withFigure] }))
  const ra = recommendNow(input({ candidates: [assumed] }))
  assert.match(describeRecommendation(rf), /It's about 45 min, your figure\./)
  assert.ok(!describeRecommendation(ra).includes('your figure'))
})

console.log(`\n${passed} checks passed`)
