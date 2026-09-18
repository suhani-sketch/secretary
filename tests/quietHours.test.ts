/**
 * Quiet hours unit test (Phase 8d core, `src/core/quietHours.ts`) — run with plain Node:
 *   node tests/quietHours.test.ts
 * Covers: unset boundaries mean no quiet hours at all (opt-in, never inferred); a same-day window; a window
 * spanning midnight; the boundary edges themselves (start is inclusive, end is exclusive); a zero-width window
 * is never "quiet".
 */
import assert from 'node:assert/strict'
import { isWithinQuietHours } from '../src/core/quietHours.ts'
import type { QuietHoursWindow } from '../src/core/quietHours.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const HHMM = (h: number, m = 0): number => h * 60 + m

// ---- opt-in: unset boundaries mean no quiet hours, never inferred ----
check('both boundaries unset → never quiet, at any hour', () => {
  const w: QuietHoursWindow = { start: null, end: null }
  assert.equal(isWithinQuietHours(HHMM(23), w), false)
  assert.equal(isWithinQuietHours(HHMM(3), w), false)
})
check('only start set, end unset → never quiet (a half-configured window is not a window)', () => {
  assert.equal(isWithinQuietHours(HHMM(23), { start: '22:00', end: null }), false)
})
check('only end set, start unset → never quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(3), { start: null, end: '08:00' }), false)
})

// ---- a same-day window (does not cross midnight) ----
check('a same-day window: inside it is quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(13, 30), { start: '13:00', end: '14:00' }), true)
})
check('a same-day window: before or after it is not quiet', () => {
  const w: QuietHoursWindow = { start: '13:00', end: '14:00' }
  assert.equal(isWithinQuietHours(HHMM(12, 59), w), false)
  assert.equal(isWithinQuietHours(HHMM(14, 1), w), false)
})

// ---- a window spanning midnight (the realistic "don't disturb after 10" case) ----
check('a midnight-spanning window: late evening is quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(23), { start: '22:00', end: '08:00' }), true)
})
check('a midnight-spanning window: after midnight, before the end, is still quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(3), { start: '22:00', end: '08:00' }), true)
})
check('a midnight-spanning window: the middle of the day is not quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(14), { start: '22:00', end: '08:00' }), false)
})

// ---- boundary edges: start is inclusive, end is exclusive ----
check('the exact start minute counts as quiet (inclusive)', () => {
  assert.equal(isWithinQuietHours(HHMM(22), { start: '22:00', end: '08:00' }), true)
})
check('the exact end minute does NOT count as quiet (exclusive — quiet hours are over)', () => {
  assert.equal(isWithinQuietHours(HHMM(8), { start: '22:00', end: '08:00' }), false)
})
check('one minute before the end is still quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(7, 59), { start: '22:00', end: '08:00' }), true)
})

// ---- a zero-width window is never quiet, regardless of the hour ----
check('start === end (zero-width window) is never quiet', () => {
  assert.equal(isWithinQuietHours(HHMM(22), { start: '22:00', end: '22:00' }), false)
})

console.log(`\n${passed} checks passed`)
