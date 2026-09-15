import { DateTime } from 'luxon'
import * as repo from '../repo'
import { formatClock, formatDue } from '../../shared/format'
import type { Item, Reminder } from '../../shared/types'

/** Short id the model uses to refer to rows. Resolved back with repo.resolveItemId / resolveReminderId. */
export const shortId = (id: string): string => id.slice(0, 8)

/** In-memory focus stack: the last few items touched and what was done to them (spec §4 "Reference resolution"). */
export interface FocusEntry {
  itemId: string
  title: string
  action: string
  at: string
}
const focus: FocusEntry[] = []
export function pushFocus(itemId: string, title: string, action: string): void {
  const i = focus.findIndex((f) => f.itemId === itemId)
  if (i >= 0) focus.splice(i, 1)
  focus.unshift({ itemId, title, action, at: new Date().toISOString() })
  if (focus.length > 5) focus.length = 5
}
export function getFocus(): FocusEntry[] {
  return [...focus]
}

function describeItem(it: Item, reminders: Reminder[]): string {
  const bits = [`[${shortId(it.id)}] ${it.kind} "${it.title}"`]
  if (it.status !== 'open') bits.push(`status=${it.status}`)
  if (it.due_at_utc) bits.push(`due ${formatDue(it.due_at_utc, it.due_precision)} (${it.due_precision} precision)`)
  if (it.importance !== 2) bits.push(`importance=${it.importance}`)
  if (it.waiting_on) bits.push(`waiting on ${it.waiting_on}`)
  if (it.is_suggestion) bits.push('SUGGESTION — not confirmed by the user')
  if (it.details) bits.push(`— ${it.details.slice(0, 120)}`)
  const rs = reminders.filter((r) => r.item_id === it.id)
  for (const r of rs) bits.push(`reminder [${shortId(r.id)}] ${r.state} ${formatClock(r.fire_at_utc)}`)
  if (rs.length === 0) bits.push('no reminder')
  return '- ' + bits.join(' · ')
}

/**
 * Assemble the context block for one request (spec §4). Never the whole database.
 * Budgeted by count; oldest-modified items are dropped first when over budget.
 */
export function assembleContext(userText: string): string {
  const now = DateTime.local()
  const nowUtc = now.toUTC().toISO()!
  const in14 = now.plus({ days: 14 }).toUTC().toISO()!
  const since7 = now.minus({ days: 7 }).toUTC().toISO()!

  const seen = new Set<string>()
  const pick = (list: Item[]): Item[] => list.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))

  // Focus-stack items always ride along so "it"/"that" can be resolved even if otherwise out of budget.
  const focusList = getFocus()
  const focused = pick(focusList.map((f) => repo.getItem(f.itemId)).filter((i): i is Item => !!i))
  const overdue = pick(repo.openItemsOverdue(nowUtc))
  const dueSoon = pick(repo.itemsDueBetween(nowUtc, in14))
  const waiting = pick(repo.openWaitingItems())
  const keyword = pick(repo.searchItems(userText))
  let recent = pick(repo.itemsModifiedSince(since7))

  const BUDGET = 60
  const fixed = focused.length + overdue.length + dueSoon.length + waiting.length + keyword.length
  if (fixed + recent.length > BUDGET) recent = recent.slice(0, Math.max(0, BUDGET - fixed))

  const all = [...focused, ...overdue, ...dueSoon, ...waiting, ...keyword, ...recent]
  const reminders = repo.pendingRemindersForItems(all.map((i) => i.id))
  const prefs = repo.listPreferences()

  const section = (title: string, items: Item[]): string =>
    items.length ? `${title}:\n${items.map((i) => describeItem(i, reminders)).join('\n')}` : `${title}: none`

  return [
    `Current local time: ${now.toFormat('cccc d LLLL yyyy, HH:mm')} (${now.zoneName}). Tomorrow is ${now.plus({ days: 1 }).toFormat('cccc d LLLL yyyy')}.`,
    ``,
    focusList.length
      ? `Recently touched in this conversation (most recent first — "it"/"that" usually means the first):\n${focusList
          .map((f) => `- [${shortId(f.itemId)}] "${f.title}" — ${f.action}`)
          .join('\n')}`
      : `Recently touched in this conversation: nothing yet.`,
    ``,
    section('Items just touched (full detail)', focused),
    section('Overdue open items', overdue),
    section('Due in the next 14 days', dueSoon),
    section('Open waiting-on items', waiting),
    section('Items matching words in the message', keyword),
    section('Other items modified in the last 7 days', recent),
    ``,
    prefs.length
      ? `User preferences:\n${prefs.map((p) => `- ${p.key} = ${p.value} (${p.source})`).join('\n')}`
      : `User preferences: none recorded (default reminder time for day-only reminders is 09:00).`
  ].join('\n')
}
