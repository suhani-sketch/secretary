/**
 * Day-status descriptor unit test (`src/core/calendar/aggregate.ts#dayStatus`) — run with plain Node:
 *   node tests/dayStatus.test.ts
 * Covers: "light" is a promise that nothing needs attention, so an overdue item, a hard deadline or a
 * high-importance obligation floors the result at "normal" even when the raw time estimate is tiny — but the ratio
 * is still free to escalate further to busy/overloaded when the load is genuinely heavy, not just present.
 *
 * aggregate.ts imports core/calendar/occurrences.ts by the same extensionless relative specifier every core/*.ts
 * file uses — correct for the real build, but Node's own type-stripping won't resolve it unassisted when running
 * this file directly. See tests/_ts_ext_loader.mjs for why (same fix already used by tests/weekplan.test.ts).
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
register(new URL('./_ts_ext_loader.mjs', import.meta.url))
const { dayStatus } = await import('../src/core/calendar/aggregate.ts')

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const AVAILABLE = 12 * 60 // a full 12 h waking day, no constraints

// ---- a genuinely empty day stays light ----
check('nothing scheduled, nothing due, nothing overdue, nothing important → light', () => {
  assert.equal(dayStatus(0, 0, 0, AVAILABLE), 'light')
})
check('a small amount of ordinary due effort with no urgency signal can still be light', () => {
  assert.equal(dayStatus(0, 30, 0, AVAILABLE, 0, 0), 'light')
})

// ---- the actual bug report: "light" next to overdue/hard-deadline/important items is a false promise ----
check('a single overdue item floors the day at normal, even though the raw time estimate is tiny', () => {
  // 30 min due-effort (the overdue item's own default estimate) — by ratio alone this would be "light" (30/720 ≈ 0.04).
  assert.equal(dayStatus(0, 30, 0, AVAILABLE, 1, 0), 'normal')
})
check('a hard deadline alone floors the day at normal, even at a low ratio', () => {
  assert.equal(dayStatus(0, 30, 1, AVAILABLE, 0, 0), 'normal')
})
check('a high-importance item alone floors the day at normal, even at a low ratio', () => {
  assert.equal(dayStatus(0, 30, 0, AVAILABLE, 0, 1), 'normal')
})
check('the exact real-world case that prompted this fix: one overdue + one hard deadline + one high-importance item, otherwise-empty calendar', () => {
  // Matches the 8a briefing scenario: three unscheduled items (30 min default each) + no calendar events.
  const result = dayStatus(0, 90, 1, AVAILABLE, 1, 1)
  assert.notEqual(result, 'light')
})

// ---- the floor never suppresses genuine escalation — busy/overloaded still win over the normal floor ----
check('a heavy load with urgency signals present escalates past the normal floor to busy/overloaded, never gets capped at normal', () => {
  const busy = dayStatus(6 * 60, 0, 1, AVAILABLE, 1, 0) // 6 h scheduled, ratio 0.5 → busy
  assert.equal(busy, 'busy')
  const overloaded = dayStatus(10 * 60, 0, 1, AVAILABLE, 1, 0) // 10 h scheduled, ratio ~0.83 → overloaded
  assert.equal(overloaded, 'overloaded')
})

// ---- an empty day (load === 0) is the one true "light", and the floor rule cannot apply to it since it never has
//      an urgency signal by construction (an overdue/hard/important count > 0 always contributes >0 load itself) ----
check('load === 0 short-circuits to light before the floor rule is even considered', () => {
  assert.equal(dayStatus(0, 0, 0, AVAILABLE, 0, 0), 'light')
})

// ---- capacity never drops below the 4 h floor the caller already enforces; dayStatus itself just divides ----
check('a very small availableMinutes still classifies sensibly (division, not a crash) — the 4 h floor is the caller\'s job', () => {
  assert.equal(dayStatus(0, 0, 0, 0), 'light') // load 0 → light regardless of availableMin, matches the load===0 shortcut
  assert.equal(dayStatus(60, 0, 0, 1), 'overloaded') // any real load against ~0 capacity is overloaded
})

console.log(`\n${passed} checks passed`)
