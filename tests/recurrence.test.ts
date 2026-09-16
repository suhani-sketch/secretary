/**
 * Recurrence unit test — run with plain Node (type stripping): `node tests/recurrence.test.ts`
 * Covers: DST boundary (spec §9), snooze not drifting the series, first-occurrence seeding, phrase parsing.
 */
import assert from 'node:assert/strict'
import { firstOccurrence, nextOccurrenceUtc, parseRecurrencePhrase } from '../src/main/recurrence.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

// ---- DST: Europe/London leaves BST on Sun 25 Oct 2026 (clocks go back at 02:00). A 09:00 daily reminder must stay 09:00 local.
check('daily 09:00 London stays 09:00 local across the autumn DST change', () => {
  const s = { rrule: 'FREQ=DAILY', anchorLocal: '2026-10-23T09:00', tz: 'Europe/London' }
  const fri = nextOccurrenceUtc(s, '2026-10-23T08:00:00.000Z', true)! // Fri 23 Oct 09:00 BST = 08:00Z (inclusive: the anchor itself)
  const sat = nextOccurrenceUtc(s, fri, false)!
  const sun = nextOccurrenceUtc(s, sat, false)!
  const mon = nextOccurrenceUtc(s, sun, false)!
  assert.equal(fri, '2026-10-23T08:00:00.000Z')
  assert.equal(sat, '2026-10-24T08:00:00.000Z') // still BST → 08:00Z
  assert.equal(sun, '2026-10-25T09:00:00.000Z') // GMT now → 09:00 local is 09:00Z (UTC shifted, local did not)
  assert.equal(mon, '2026-10-26T09:00:00.000Z')
})

check('spring forward: 09:00 New York stays 09:00 local across 8 Mar 2026', () => {
  const s = { rrule: 'FREQ=DAILY', anchorLocal: '2026-03-07T09:00', tz: 'America/New_York' }
  const sat = nextOccurrenceUtc(s, '2026-03-07T13:00:00.000Z', true)!
  const sun = nextOccurrenceUtc(s, sat, false)!
  assert.equal(sat, '2026-03-07T14:00:00.000Z') // EST: 09:00 = 14:00Z
  assert.equal(sun, '2026-03-08T13:00:00.000Z') // EDT: 09:00 = 13:00Z
})

// ---- Snooze must not drift the series: the anchor, not the last (snoozed) fire time, drives the next occurrence.
check('weekly Sunday 17:00 Kolkata: after a snoozed firing the next occurrence is still Sunday 17:00', () => {
  const s = { rrule: 'FREQ=WEEKLY;BYDAY=SU', anchorLocal: '2026-09-20T17:00', tz: 'Asia/Kolkata' }
  // Delivered late (snoozed to 17:25 that Sunday). "after" is the later of now and the slot: 17:25 Sunday.
  const next = nextOccurrenceUtc(s, '2026-09-20T11:55:00.000Z', false)! // 17:25 IST
  assert.equal(next, '2026-09-27T11:30:00.000Z') // Sun 27 Sep 17:00 IST
})

// ---- First occurrence seeding: "every sunday at 5" asked on Wed 16 Sep 14:10 IST → Sun 20 Sep 17:00 IST.
check('firstOccurrence picks the coming Sunday at the requested clock', () => {
  const f = firstOccurrence('FREQ=WEEKLY;BYDAY=SU', '17:00', 'Asia/Kolkata', '2026-09-16T08:40:00.000Z')!
  assert.equal(f.anchorLocal, '2026-09-20T17:00')
  assert.equal(f.fireAtUtc, '2026-09-20T11:30:00.000Z')
})
check('firstOccurrence for daily at a clock already passed today → tomorrow', () => {
  const f = firstOccurrence('FREQ=DAILY', '08:00', 'Asia/Kolkata', '2026-09-16T08:40:00.000Z')! // it is 14:10 IST
  assert.equal(f.anchorLocal, '2026-09-17T08:00')
})
check('firstOccurrence for weekdays asked on a Friday evening → Monday', () => {
  const f = firstOccurrence('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '09:00', 'Asia/Kolkata', '2026-09-18T15:00:00.000Z')! // Fri 20:30 IST
  assert.equal(f.anchorLocal, '2026-09-21T09:00')
})

// ---- Phrase parsing
const p = (t: string): string | null => parseRecurrencePhrase(t)?.rrule ?? null
check('phrases → rrule', () => {
  assert.equal(p('water the plants every sunday at 5'), 'FREQ=WEEKLY;BYDAY=SU')
  assert.equal(p('take meds every day at 8'), 'FREQ=DAILY')
  assert.equal(p('take meds daily'), 'FREQ=DAILY')
  assert.equal(p('stretch every morning'), 'FREQ=DAILY')
  assert.equal(parseRecurrencePhrase('stretch every morning')?.clockHint, '09:00')
  assert.equal(p('call mum every weekday at 9'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  assert.equal(p('gym on mondays and thursdays'), 'FREQ=WEEKLY;BYDAY=MO,TH')
  assert.equal(p('review budget every other week'), 'FREQ=WEEKLY;INTERVAL=2')
  assert.equal(p('backup every 3 days'), 'FREQ=DAILY;INTERVAL=3')
  assert.equal(p('pay rent monthly'), 'FREQ=MONTHLY')
  assert.equal(p('call the bank sunday at 5'), null) // a single date, not a recurrence
  assert.equal(parseRecurrencePhrase('water the plants every sunday at 5')?.stripped, 'water the plants at 5')
})

console.log(`\n${passed} checks passed`)
