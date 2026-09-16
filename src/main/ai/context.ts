import { DateTime } from 'luxon'
import * as repo from '../repo'
import { formatClock, formatDue } from '../../shared/format'
import { describeConstraint } from '../planning'
import { occurrencesBetween } from '../calendar'
import { describeProgress, planProgress } from '../../core/plans'
import type { Item, Reminder } from '../../shared/types'

/** Short id the model uses to refer to rows. Resolved back with repo.resolveItemId / resolveReminderId. */
export const shortId = (id: string): string => id.slice(0, 8)

/** In-memory focus stack: the last few items touched and what was done to them (spec §4 "Reference resolution"). */
export interface FocusEntry {
  itemId: string
  title: string
  action: string
  at: string
  /** Items by default; calendar events also take focus so "move it to 4" can mean the meeting just created. */
  kind?: 'item' | 'event'
}
const focus: FocusEntry[] = []
export function pushFocus(itemId: string, title: string, action: string, kind: 'item' | 'event' = 'item'): void {
  const i = focus.findIndex((f) => f.itemId === itemId)
  if (i >= 0) focus.splice(i, 1)
  focus.unshift({ itemId, title, action, at: new Date().toISOString(), kind })
  if (focus.length > 5) focus.length = 5
}
export function getFocus(): FocusEntry[] {
  return [...focus]
}

/** A standing offer the assistant just made ("Want a reminder?") that a plain "yes" answers. */
export type Offer =
  | { kind: 'reminder'; itemId: string }
  /** "Is X the same as your existing project Y?" — a plain yes/no answers it. */
  | { kind: 'project_match'; existingId: string; proposedTitle: string }
  /** "Add a list for the things I need to do" — the next "add A, B and C" goes onto this project's checklist. */
  | { kind: 'checklist_target'; projectId: string }
  /** A booking refused for clashing with availability; "yes" / "book it anyway" replays it with override_conflicts. */
  | { kind: 'conflict_override'; toolName: string; args: Record<string, unknown> }
  /** Micro-ritual (Phase 5): "Want a 5-minute steep timer?" for an open-ended happening. "yes" times it; "no" is remembered per kind. */
  | { kind: 'ritual'; happeningId: string | null; happeningKind: string; minutes: number; label: string; metaphor: string | null }
let offer: Offer | null = null
export const setOffer = (o: Offer): void => {
  offer = o
}
export const getOffer = (): Offer | null => offer
export const clearOffer = (): void => {
  offer = null
}

function describeItem(it: Item, reminders: Reminder[]): string {
  const bits = [`[${shortId(it.id)}] ${it.kind} "${it.title}"`]
  if (it.status !== 'open') bits.push(`status=${it.status}`)
  if (it.due_at_utc) bits.push(`due ${formatDue(it.due_at_utc, it.due_precision)} (${it.due_precision} precision)`)
  if (it.importance !== 2) bits.push(`importance=${it.importance}`)
  if (it.waiting_on) bits.push(`waiting on ${it.waiting_on}${it.due_at_utc ? `, expected ${formatDue(it.due_at_utc, it.due_precision)}` : ''} since ${it.created_at.slice(0, 10)}`)
  if (it.kind === 'commitment') bits.push(`COMMITMENT to ${it.committed_to ?? 'someone'} — they are expecting it`)
  if (it.kind === 'waiting') {
    const fu = repo.conditionalRemindersOn(it.id)
    if (fu.length) bits.push(`follow-up ${fu.map((f) => `[${shortId(f.id)}] ${formatClock(f.fire_at_utc)}`).join(', ')} unless resolved`)
  }
  if (it.is_suggestion) bits.push('SUGGESTION — not confirmed by the user')
  if (it.details) bits.push(`— ${it.details.slice(0, 120)}`)
  const notes = repo.notesFor('item', it.id)
  if (notes.length) bits.push(`notes: ${notes.slice(0, 3).map((n) => `[${shortId(n.id)}] "${n.body.slice(0, 80)}"`).join('; ')}${notes.length > 3 ? ` (+${notes.length - 3})` : ''}`)
  if (it.hardness) bits.push(it.hardness === 'hard' ? 'hard deadline' : 'soft target')
  if (it.kind !== 'project') {
    const parent = repo.parentProjectOf(it.id)
    if (parent) bits.push(`part of [${shortId(parent.id)}] "${parent.title}"`)
  }
  const blockers = repo.blockersOf(it.id)
  if (blockers.length) bits.push(`BLOCKED by ${blockers.map((b) => `[${shortId(b.id)}] "${b.title}"`).join(', ')}`)
  const rs = reminders.filter((r) => r.target_type === 'item' && r.target_id === it.id)
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
  const constraints = repo.activeConstraints()
  const happenings = repo.runningHappenings()
  const todayCtx = repo.todayContext()
  const commitments = repo.openCommitments()
  const plans = repo.listPlans().map((p) => {
    const sessions = repo.sessionsForPlan(p.id)
    const prog = planProgress(p, sessions, nowUtc)
    const upcoming = sessions.filter((s) => (s.session_state === 'planned' || s.session_state === 'moved') && s.starts_at_utc >= nowUtc).slice(0, 3)
    return `- [${shortId(p.id)}] "${p.title}" (${p.status}): ${describeProgress(prog)}${upcoming.length ? ` · next sessions: ${upcoming.map((s) => `[${shortId(s.id)}] ${formatClock(s.starts_at_utc)}`).join(', ')}` : ''}`
  })
  const dateNotes = repo.dateNotesBetween(now.minus({ days: 1 }).toISODate()!, now.plus({ days: 14 }).toISODate()!)
  const events = occurrencesBetween(now.startOf('day').toUTC().toISO()!, now.plus({ days: 14 }).endOf('day').toUTC().toISO()!)
  const offer = getOffer()

  const section = (title: string, items: Item[]): string =>
    items.length ? `${title}:\n${items.map((i) => describeItem(i, reminders)).join('\n')}` : `${title}: none`

  // Things: always listed in full with their parts, so mentions resolve to the existing project (spec §8 3a).
  const projects = repo.openProjects(30)
  const projectLines = projects.map((p) => {
    const parts = repo.projectParts(p.id).filter((c) => c.status !== 'cancelled' && c.status !== 'archived')
    const open = parts.filter((c) => c.status !== 'done')
    const last = repo.activitiesForProject(p.id, 1)[0]
    const describePart = (c: Item): string =>
      c.kind === 'checklist_item' ? `${c.status === 'done' ? '☑' : '☐'} [${shortId(c.id)}] ${c.title}` : `[${shortId(c.id)}] ${c.kind} ${c.title}${c.status !== 'open' ? ` (${c.status})` : ''}`
    return (
      `- [${shortId(p.id)}] "${p.title}"` +
      (p.due_at_utc ? ` · due ${formatDue(p.due_at_utc, p.due_precision)}${p.hardness === 'hard' ? ' (hard)' : ''}` : '') +
      ` · ${parts.length ? `${open.length} open of ${parts.length} parts: ${parts.map(describePart).join(', ')}` : 'no parts yet'}` +
      (last ? ` · last: ${last.summary}` : '')
    )
  })

  return [
    `Current local time: ${now.toFormat('cccc d LLLL yyyy, HH:mm')} (${now.zoneName}). Tomorrow is ${now.plus({ days: 1 }).toFormat('cccc d LLLL yyyy')}.`,
    ``,
    focusList.length
      ? `Recently touched in this conversation (most recent first — "it"/"that" usually means the first):\n${focusList
          .map((f) => `- [${shortId(f.itemId)}] "${f.title}" — ${f.action}`)
          .join('\n')}`
      : `Recently touched in this conversation: nothing yet.`,
    ``,
    projects.length ? `Projects / Things you are tracking (use these ids; never create a second one for the same Thing):\n${projectLines.join('\n')}` : `Projects / Things you are tracking: none yet.`,
    ``,
    section('Items just touched (full detail)', focused),
    section('Overdue open items', overdue),
    section('Due in the next 14 days', dueSoon),
    section('Open waiting-on items', waiting),
    section('Items matching words in the message', keyword),
    section('Other items modified in the last 7 days', recent),
    ``,
    events.length
      ? `Calendar, next 14 days (events occupy time; refer to them by id for update_event / delete_event):\n${events
          .map((e) => `- [${shortId(e.id)}] "${e.title}" ${e.all_day ? formatDue(e.occurrence_start_utc, 'day') : `${formatClock(e.occurrence_start_utc)}${e.occurrence_end_utc ? `–${formatClock(e.occurrence_end_utc).replace(/^.*? at /, '')}` : ''}`}${e.kind ? ` (${e.kind})` : ''}${e.is_recurring_instance ? ' ↻ series' : ''}`)
          .join('\n')}`
      : `Calendar, next 14 days: nothing.`,
    constraints.length
      ? `Availability constraints (the app checks these when a time is booked; you do not need to):\n${constraints.map((c) => `- [${shortId(c.id)}] ${c.kind}: ${describeConstraint(c)} [${c.source}]`).join('\n')}`
      : `Availability constraints: none recorded.`,
    todayCtx.length
      ? `Today's context (expires tonight; shapes what you recommend today; NEVER store it anywhere):\n${todayCtx.map((c) => `- ${c.kind}: ${c.text} (${c.at.slice(11, 16)}Z)`).join('\n')}`
      : `Today's context: nothing stated.`,
    commitments.length
      ? `Open commitments (promises to a named person — they weigh more than plain tasks):\n${commitments.map((c) => `- [${shortId(c.id)}] "${c.title}" to ${c.committed_to ?? 'someone'}${c.due_at_utc ? ` · ${formatDue(c.due_at_utc, c.due_precision)}` : ''}`).join('\n')}`
      : `Open commitments: none.`,
    plans.length
      ? `Plans (multi-day; sessions are events with kind session — mark_session by the session id, get_plan by the plan id):\n${plans.join('\n')}`
      : `Plans: none.`,
    happenings.length
      ? `Happening right now (living activities — never tasks, never history):\n${happenings
          .map((h) => `- [${shortId(h.id)}] ${h.label}${h.ends_at ? ` · ends ${formatClock(h.ends_at)}` : ' · open-ended'}${h.metaphor ? ` (${h.metaphor})` : ''}`)
          .join('\n')}`
      : `Happening right now: nothing.`,
    dateNotes.length
      ? `Notes on upcoming days (inform planning; not tasks):\n${dateNotes.map((n) => `- ${n.target_id}: [${shortId(n.id)}] ${n.body}`).join('\n')}`
      : `Notes on upcoming days: none.`,
    offer
      ? offer.kind === 'reminder'
        ? `Standing offer: you just asked whether to add a reminder for [${shortId(offer.itemId)}]; a plain "yes" means create it.`
        : offer.kind === 'project_match'
          ? `Standing question: you asked whether "${offer.proposedTitle}" is the same Thing as project [${shortId(offer.existingId)}]. "yes" → create_project with use_existing_id; "no"/"different" → create_project with force_new=true.`
          : offer.kind === 'checklist_target'
            ? `Standing context: the user just asked for a checklist on project [${shortId(offer.projectId)}]; items they list next belong on it (add_checklist_item).`
            : offer.kind === 'ritual'
              ? offer.happeningId
                ? `Standing offer: you offered a ${offer.minutes}-minute timer for the running "${offer.label}" [${shortId(offer.happeningId)}]. "yes" → time_happening with that id and minutes (or the minutes they name); "no" → decline_ritual with kind "${offer.happeningKind}" (the app then never offers it for that kind again).`
                : `Standing offer: the user said they are making ${offer.label}; you offered a ${offer.minutes}-minute timer and nothing was created. "yes" → start_happening {label "${offer.label}", minutes ${offer.minutes}}; "no" → decline_ritual with kind "${offer.happeningKind}". Anything else → drop it silently.`
              : `Standing question: a booking was refused because it clashes with the user's availability. If they say to book it anyway, call ${offer.toolName} again with the same arguments plus override_conflicts=true; if they pick another time, book that instead.`
      : '',
    ``,
    prefs.length
      ? `User preferences:\n${prefs.map((p) => `- ${p.key} = ${p.value} (${p.source})`).join('\n')}`
      : `User preferences: none recorded (default reminder time for day-only reminders is 09:00).`
  ].join('\n')
}
