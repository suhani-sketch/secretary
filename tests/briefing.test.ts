/**
 * Morning briefing unit test (Phase 8a core, `src/core/briefing.ts`) — run with plain Node:
 *   node tests/briefing.test.ts
 * Covers: the empty day never invents an "all clear"-style line, load status is named, priorities are capped with an
 * honest "+N more" instead of dumping the whole list, the first timed event of the day is named with its count, and
 * the greeting word follows the hour actually passed in (never a fixed "good morning" regardless of when it fires).
 */
import assert from 'node:assert/strict'
import { describeBriefing } from '../src/core/briefing.ts'
import type { DayBundle, PriorityEntry, EventOccurrence } from '../src/shared/types.ts'

let passed = 0
const check = (name: string, fn: () => void): void => {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const priority = (title: string, reasons: string[] = []): PriorityEntry => ({ item: { title } as PriorityEntry['item'], score: 0, reasons, overdue: false, blocked: false, scheduled: false })
const occurrence = (title: string, startUtc: string, allDay = false): EventOccurrence =>
  ({ title, occurrence_start_utc: startUtc, all_day: allDay ? 1 : 0 } as unknown as EventOccurrence)
const bundle = (over: Partial<DayBundle> = {}): DayBundle =>
  ({
    priorities: [],
    scheduled: [],
    summary: { status: 'light' },
    ...over
  }) as unknown as DayBundle

const opts = (hourLocal: number) => ({ dateLabel: 'Friday, 18 September', hourLocal, when: (iso: string) => iso.slice(11, 16) })

// ---- honesty: an empty day says so, never a manufactured "all clear" ----
check('an empty day (no priorities, no timed events) says so plainly', () => {
  const text = describeBriefing(bundle({ priorities: [], scheduled: [] }), opts(8))
  assert.equal(text, 'Good morning — Friday, 18 September. Nothing pressing today.')
})

// ---- greeting word follows the hour, not a fixed string ----
check('greeting word is morning before noon', () => {
  assert.match(describeBriefing(bundle({ priorities: [priority('X')] }), opts(9)), /^Good morning —/)
})
check('greeting word is afternoon from noon to 6pm', () => {
  assert.match(describeBriefing(bundle({ priorities: [priority('X')] }), opts(14)), /^Good afternoon —/)
})
check('greeting word is evening from 6pm', () => {
  assert.match(describeBriefing(bundle({ priorities: [priority('X')] }), opts(20)), /^Good evening —/)
})

// ---- day status is named when present ----
check('a busy day names it', () => {
  const text = describeBriefing(bundle({ priorities: [priority('Report')], summary: { status: 'busy' } as DayBundle['summary'] }), opts(8))
  assert.match(text, /Today looks busy\./)
})

// ---- priorities: capped, with an honest "+N more" rather than a full dump ----
check('priorities beyond the cap are summarised as "+N more", never silently dropped', () => {
  const many = [priority('A', ['overdue']), priority('B', ['hard deadline']), priority('C', ['high importance']), priority('D'), priority('E')]
  const text = describeBriefing(bundle({ priorities: many }), opts(8))
  assert.match(text, /Top of mind: "A" \(overdue\); "B" \(hard deadline\); "C" \(high importance\), \+2 more\./)
})
check('three or fewer priorities are all named, no "+N more"', () => {
  const text = describeBriefing(bundle({ priorities: [priority('A', ['overdue']), priority('B')] }), opts(8))
  assert.match(text, /Top of mind: "A" \(overdue\); "B"\./)
  assert.ok(!text.includes('more'))
})
check('a priority with no reason is still named, just without a parenthetical', () => {
  const text = describeBriefing(bundle({ priorities: [priority('Quiet task')] }), opts(8))
  assert.match(text, /Top of mind: "Quiet task"\./)
})

// ---- the first timed event of the day, named with its count ----
check('the first timed event is named, all-day events are excluded from "first up"', () => {
  const scheduled = [occurrence('Conference', '2026-09-18T00:00:00.000Z', true), occurrence('Team meeting', '2026-09-18T09:00:00.000Z'), occurrence('Call', '2026-09-18T13:00:00.000Z')]
  const text = describeBriefing(bundle({ scheduled }), opts(8))
  assert.match(text, /First up: "Team meeting" at 09:00 \(2 on the calendar today\)\./)
})
check('a single timed event does not add a redundant count', () => {
  const text = describeBriefing(bundle({ scheduled: [occurrence('Call', '2026-09-18T13:00:00.000Z')] }), opts(8))
  assert.match(text, /First up: "Call" at 13:00\.$/)
})
check('scheduled events sort chronologically for "first up", regardless of input order', () => {
  const scheduled = [occurrence('Later', '2026-09-18T15:00:00.000Z'), occurrence('Earlier', '2026-09-18T09:00:00.000Z')]
  const text = describeBriefing(bundle({ scheduled }), opts(8))
  assert.match(text, /First up: "Earlier" at 09:00/)
})

// ---- priorities and schedule combine into one coherent message ----
check('a day with both priorities and a schedule names both, in order', () => {
  const text = describeBriefing(bundle({ priorities: [priority('Finish report', ['hard deadline'])], scheduled: [occurrence('Standup', '2026-09-18T09:00:00.000Z')], summary: { status: 'normal' } as DayBundle['summary'] }), opts(8))
  assert.equal(text, 'Good morning — Friday, 18 September. Today looks normal. Top of mind: "Finish report" (hard deadline). First up: "Standup" at 09:00.')
})

// ---- coming-up deadlines: a heads-up for something soon but not today, never lost when today is otherwise empty ----
check('a deadline coming up soon is mentioned even when today itself is empty', () => {
  const text = describeBriefing(bundle({ priorities: [], scheduled: [] }), { ...opts(8), comingUp: [{ title: 'Visa application', dueLabel: 'Mon 21 Sep' }] })
  assert.equal(text, 'Good morning — Friday, 18 September. Today looks light. Coming up: "Visa application" (Mon 21 Sep).')
  assert.ok(!text.includes('Nothing pressing')) // it is NOT an empty day once something is coming up
})
check('coming-up entries beyond the cap are summarised as "+N more"', () => {
  const comingUp = [
    { title: 'Visa application', dueLabel: 'Mon 21 Sep' },
    { title: 'Rent', dueLabel: 'Tue 22 Sep' },
    { title: 'Conference talk', dueLabel: 'Wed 23 Sep' }
  ]
  const text = describeBriefing(bundle({ priorities: [] }), { ...opts(8), comingUp })
  assert.match(text, /Coming up: "Visa application" \(Mon 21 Sep\); "Rent" \(Tue 22 Sep\), \+1 more\.$/)
})
check('coming-up sits after today\'s own priorities and schedule, never ahead of them', () => {
  const text = describeBriefing(bundle({ priorities: [priority('Finish report', ['hard deadline'])] }), { ...opts(8), comingUp: [{ title: 'Visa application', dueLabel: 'Mon 21 Sep' }] })
  assert.ok(text.indexOf('Top of mind') < text.indexOf('Coming up'))
})
check('no comingUp option at all behaves exactly like an empty array', () => {
  assert.equal(describeBriefing(bundle({ priorities: [], scheduled: [] }), opts(8)), 'Good morning — Friday, 18 September. Nothing pressing today.')
})

console.log(`\n${passed} checks passed`)
