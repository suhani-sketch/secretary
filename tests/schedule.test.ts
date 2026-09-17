/**
 * Smart scheduling gap-finder unit test (Phase 7e core, `src/core/schedule.ts`) — run with plain Node:
 *   node tests/schedule.test.ts
 * Everything in the 'utc' zone for portability. Covers: a clean workable day, a meeting splitting it, the duration
 * filter vs. the always-on total/longest accounting, merging overlapping busy windows, the `precededByBusy` flag,
 * truncating the first/last day to the actual search boundary, the `max` cap on returned windows (vs. unbounded
 * totals), a day fully consumed by one meeting, and an overnight event that starts before the workable window.
 */
import assert from 'node:assert/strict'
import { findFreeWindows, type FreeSearchInput } from '../src/core/schedule.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const base = (over: Partial<FreeSearchInput> = {}): FreeSearchInput => ({
  fromUtc: '2026-09-18T00:00:00.000Z',
  untilUtc: '2026-09-19T00:00:00.000Z',
  zone: 'utc',
  busy: [],
  workStartHour: 9,
  workEndHour: 17,
  durationMinutes: 60,
  ...over
})

check('a clean workable day with no busy windows is one gap covering the whole 9–17', () => {
  const r = findFreeWindows(base())
  assert.deepEqual(r.windows, [{ startUtc: '2026-09-18T09:00:00.000Z', endUtc: '2026-09-18T17:00:00.000Z', precededByBusy: false }])
  assert.equal(r.totalFreeMinutes, 480)
  assert.equal(r.longestGapMinutes, 480)
})

check('a meeting in the middle splits the day into two gaps, chronological, correctly totalled', () => {
  const r = findFreeWindows(base({ busy: [{ startUtc: '2026-09-18T12:00:00.000Z', endUtc: '2026-09-18T13:00:00.000Z' }] }))
  assert.equal(r.windows.length, 2)
  assert.deepEqual(
    r.windows.map((w) => [w.startUtc, w.endUtc]),
    [
      ['2026-09-18T09:00:00.000Z', '2026-09-18T12:00:00.000Z'],
      ['2026-09-18T13:00:00.000Z', '2026-09-18T17:00:00.000Z']
    ]
  )
  assert.equal(r.totalFreeMinutes, 420) // 180 + 240
  assert.equal(r.longestGapMinutes, 240)
})

check('precededByBusy: false for the day-opening gap, true for a gap right after a meeting', () => {
  const r = findFreeWindows(base({ busy: [{ startUtc: '2026-09-18T12:00:00.000Z', endUtc: '2026-09-18T13:00:00.000Z' }] }))
  assert.equal(r.windows[0].precededByBusy, false)
  assert.equal(r.windows[1].precededByBusy, true)
})

check('the duration filter only affects which gaps are RETURNED — totals and the longest gap still count every minute', () => {
  const r = findFreeWindows(base({ busy: [{ startUtc: '2026-09-18T12:00:00.000Z', endUtc: '2026-09-18T13:00:00.000Z' }], durationMinutes: 200 }))
  // The 180 min morning gap is too short for a 200 min ask and is dropped from `windows`…
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].startUtc, '2026-09-18T13:00:00.000Z')
  // …but it was NOT thrown away when working out how much free time exists at all, or the biggest single block.
  assert.equal(r.totalFreeMinutes, 420)
  assert.equal(r.longestGapMinutes, 240)
})

check('overlapping busy windows are merged before gaps are computed — no phantom negative micro-gap', () => {
  const r = findFreeWindows(
    base({
      busy: [
        { startUtc: '2026-09-18T09:00:00.000Z', endUtc: '2026-09-18T10:00:00.000Z' },
        { startUtc: '2026-09-18T09:30:00.000Z', endUtc: '2026-09-18T11:00:00.000Z' } // overlaps the first
      ]
    })
  )
  assert.deepEqual(r.windows, [{ startUtc: '2026-09-18T11:00:00.000Z', endUtc: '2026-09-18T17:00:00.000Z', precededByBusy: true }])
  assert.equal(r.totalFreeMinutes, 360)
  assert.equal(r.longestGapMinutes, 360)
})

check('a search starting mid-day is bounded by fromUtc, not by workStartHour', () => {
  const r = findFreeWindows(base({ fromUtc: '2026-09-18T10:00:00.000Z' }))
  assert.deepEqual(r.windows, [{ startUtc: '2026-09-18T10:00:00.000Z', endUtc: '2026-09-18T17:00:00.000Z', precededByBusy: false }])
  assert.equal(r.totalFreeMinutes, 420)
})

check('a search ending mid-day is bounded by untilUtc, not by workEndHour', () => {
  const r = findFreeWindows(base({ untilUtc: '2026-09-18T14:00:00.000Z' }))
  assert.deepEqual(r.windows, [{ startUtc: '2026-09-18T09:00:00.000Z', endUtc: '2026-09-18T14:00:00.000Z', precededByBusy: false }])
  assert.equal(r.totalFreeMinutes, 300)
})

check('a day entirely consumed by one meeting contributes nothing — the next day still does', () => {
  const r = findFreeWindows(
    base({
      untilUtc: '2026-09-20T00:00:00.000Z', // two days: the 18th and the 19th
      busy: [{ startUtc: '2026-09-18T09:00:00.000Z', endUtc: '2026-09-18T17:00:00.000Z' }] // exactly the 18th's whole workable window
    })
  )
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].startUtc, '2026-09-19T09:00:00.000Z')
  assert.equal(r.totalFreeMinutes, 480) // only the 19th
  assert.equal(r.longestGapMinutes, 480)
})

check('an overnight event that starts before the workable window still truncates today\'s start correctly', () => {
  const r = findFreeWindows(base({ busy: [{ startUtc: '2026-09-17T22:00:00.000Z', endUtc: '2026-09-18T10:00:00.000Z' }] }))
  assert.deepEqual(r.windows, [{ startUtc: '2026-09-18T10:00:00.000Z', endUtc: '2026-09-18T17:00:00.000Z', precededByBusy: true }])
  assert.equal(r.totalFreeMinutes, 420)
})

check('`max` caps how many windows come back, but never caps the total/longest accounting behind it', () => {
  const r = findFreeWindows(base({ untilUtc: '2026-09-21T00:00:00.000Z', max: 2 })) // three full 480-min days (18th, 19th, 20th)
  assert.equal(r.windows.length, 2)
  assert.equal(r.totalFreeMinutes, 1440) // all three days counted, even though only two windows were returned
  assert.equal(r.longestGapMinutes, 480)
})

console.log(`\n${passed} checks passed`)
