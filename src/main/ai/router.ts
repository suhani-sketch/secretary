import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'
import * as repo from '../repo'
import { getFocus, getOffer, setOffer } from './context'
import { firstOccurrence, parseRecurrencePhrase } from '../recurrence'
import { log } from '../log'
import type { Item, Reminder } from '../../shared/types'

/**
 * Tier 0 router (spec §4): deterministic, no model call, instant.
 * Handles done / cancel / snooze / move and simple "remind me … <date>" creates.
 * Anything with the slightest ambiguity returns null and falls through to the model.
 * Output is ordinary tool calls — the same validated, transactional path as the model uses.
 */

export interface ToolCallSpec {
  name: string
  args: Record<string, unknown>
}

/** A Tier 0 result that is just words — no tool, no model. The orchestrator replies with `text`. */
export const REPLY = '__reply__'

/** Which project a bare "add A, B and C" belongs to: the standing checklist request, else the most recently touched Thing. */
function checklistTarget(): Item | null {
  const offer = getOffer()
  if (offer?.kind === 'checklist_target') {
    const p = repo.getItem(offer.projectId)
    if (p && p.kind === 'project' && p.status !== 'archived') return p
  }
  for (const f of getFocus()) {
    const it = repo.getItem(f.itemId)
    if (!it) continue
    if (it.kind === 'project') return it
    const parent = repo.parentProjectOf(it.id)
    if (parent) return parent
  }
  return null
}

/** "send first email, follow up, and attach the document" → three titles. */
function splitList(s: string): string[] {
  return s
    .split(/\s*(?:,|;|\band\b|&|\n)\s*/i)
    .map((t) => t.replace(/^(?:and|then|also)\s+/i, '').trim())
    .filter((t) => t.length > 0)
}

const REF_WORDS = /^(it|that|this|that one|this one|the earlier one|the last one)$/

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
const STOP = new Set(['the', 'and', 'for', 'with', 'about', 'that', 'this', 'task', 'thing', 'item', 'reminder'])

/** Unique open item whose title contains every significant word of the phrase; null if none or several. */
function findItemByWords(phrase: string): Item | null {
  const ws = words(phrase)
  if (ws.length === 0) return null
  const hits = repo.openItems(200).filter((i) => {
    const t = i.title.toLowerCase()
    return ws.every((w) => t.includes(w))
  })
  return hits.length === 1 ? hits[0] : null
}

/** "it"/"that" → most recently touched item; otherwise a unique title match. */
function resolveTarget(ref: string | undefined): Item | null {
  const r = norm(ref ?? '')
  if (!r || REF_WORDS.test(r)) {
    const top = getFocus()[0]
    if (!top) return null
    const item = repo.getItem(top.itemId)
    return item && item.status === 'open' ? item : null
  }
  return findItemByWords(r)
}

/** The single live reminder for an item, or null if none / several. */
function liveReminderFor(item: Item): Reminder | null {
  const rs = repo.pendingRemindersForItems([item.id])
  return rs.length === 1 ? rs[0] : null
}

const toLocalDateTime = (d: Date): string => DateTime.fromJSDate(d).toFormat("yyyy-MM-dd'T'HH:mm")
const toLocalDate = (d: Date): string => DateTime.fromJSDate(d).toFormat('yyyy-MM-dd')

interface ParsedWhen {
  text: string
  exact: boolean
  dateTime?: string
  date?: string
  looseness?: 'week'
}

/** chrono result → honest precision. Only hours the user actually stated count as exact. */
function parseWhen(text: string): ParsedWhen | null {
  const results = chrono.casual.parse(text, new Date(), { forwardDate: true })
  if (results.length !== 1) return null
  const r = results[0]
  let d = r.start.date()
  if (r.start.isCertain('hour')) {
    // chrono reads a bare "3" as 03:00. Without am/pm, 1–6 means the afternoon for appointments.
    const h = r.start.get('hour') ?? 0
    if (!r.start.isCertain('meridiem') && h >= 1 && h <= 6 && !/\b\d{1,2}:\d{2}\b/.test(r.text)) {
      d = new Date(d.getTime() + 12 * 3600 * 1000)
    }
    return { text: r.text, exact: true, dateTime: toLocalDateTime(d) }
  }
  // chrono calls "next week" a certain day; the words say otherwise.
  const weekish = /\b(next|this|the coming) week\b|\bsome ?time\b|\bat some point\b/i.test(r.text) || /\bsome ?time\b|\bat some point\b/i.test(text)
  return { text: r.text, exact: false, date: toLocalDate(d), looseness: weekish ? 'week' : undefined }
}

function dueArgs(w: ParsedWhen): Record<string, unknown> {
  return w.exact ? { due_at_local: w.dateTime } : { due_date_local: w.date, ...(w.looseness ? { due_looseness: w.looseness } : {}) }
}
function remindArgs(w: ParsedWhen): Record<string, unknown> {
  return w.exact ? { remind_at_local: w.dateTime } : { remind_date_local: w.date }
}

/**
 * Matching runs on lower-cased text, but titles must keep the user's casing ("TISS mailing", not "Tiss mailing").
 * Find the matched fragment case-insensitively in the original message and return that slice.
 */
let originalText = ''
function restoreCase(fragmentLower: string): string {
  const idx = originalText.toLowerCase().indexOf(fragmentLower.toLowerCase())
  return idx >= 0 ? originalText.slice(idx, idx + fragmentLower.length) : fragmentLower
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Strip the date phrase and a dangling preposition from a title, keeping the user's casing. */
function cleanTitle(raw: string, dateText: string): string {
  let t = restoreCase(raw)
  if (dateText) t = t.replace(new RegExp(escapeRe(dateText), 'i'), ' ')
  t = t.replace(/\s+(on|at|by|for|before|until|till|around|sometime|some time)\s*$/i, '')
  t = t.replace(/^\s*(to|about|that)\s+/i, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const IMPERATIVE =
  /^(call|phone|ring|email|mail|text|message|ping|buy|get|pay|send|submit|finish|book|write|read|clean|pick up|return|renew|order|schedule|meet|go to|visit|check|fix|prepare|print|post|sign|apply|water|feed|study|revise|review|practice|practise|wash|cook|drop off|collect|file|upload|download|update|reply to|follow up)\b/

const UNIT_MIN: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60 }

/** "4", "4pm", "16:30", "4:15 pm" → hour/minute, using the item's existing due to disambiguate a bare number. */
function parseClock(tail: string, existing: Item): { hour: number; minute: number } | null {
  const m = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(tail)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (hour > 23 || minute > 59) return null
  if (m[3] === 'pm' && hour < 12) hour += 12
  else if (m[3] === 'am' && hour === 12) hour = 0
  else if (!m[3] && !m[2] && hour <= 12) {
    // Bare number: afternoon for 1–6; for 7–11 follow the item's current half of the day.
    const existingHour = existing.due_at_utc ? DateTime.fromISO(existing.due_at_utc, { zone: 'utc' }).toLocal().hour : 15
    if (hour <= 6 || (hour < 12 && existingHour >= 12)) hour += 12
  }
  return { hour, minute }
}

/**
 * Chat shorthand chrono does not know. "tom"/"tmrw"/"tmr" mean tomorrow when they sit where a date would:
 * at the end, or right before a time or part of day ("call tom at 3"). "email tom about the report" keeps Tom.
 */
function expandShorthand(s: string): string {
  return s
    .replace(/\b(tom|tmrw|tmr|tomo|2moro|tmw)\b(?=\s*$|\s+(?:at|by|around|before|after|morning|afternoon|evening|night|noon|midday|\d))/g, 'tomorrow')
    .replace(/\btod\b/g, 'today')
    .replace(/\btonite\b/g, 'tonight')
    .replace(/\bnxt\b/g, 'next')
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b(?=\s*$|\s+(?:at|by|around|morning|afternoon|evening|night|\d))/g, (_m, d: string) => DAYS[d] ?? d)
}
const DAYS: Record<string, string> = {
  mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday'
}

export function routeTier0(rawText: string): ToolCallSpec[] | null {
  originalText = rawText.trim().replace(/\s+/g, ' ')
  const text = expandShorthand(norm(rawText))
  if (!text || text.length > 160 || text.includes('\n')) return null
  let m: RegExpExecArray | null

  // ---- undo ----
  if (/^(?:undo|undo that|undo the last change|undo last|revert that|take that back)$/.test(text)) {
    return [{ name: 'undo_last', args: {} }]
  }

  // ---- "yes" / "no" to a standing offer or question ----
  if (/^(?:yes|yes please|yep|yeah|sure|ok|okay|please|do it|go ahead|yes do|same|same thing|yes same)$/.test(text)) {
    const offer = getOffer()
    if (!offer) return null
    if (offer.kind === 'project_match') {
      return [{ name: 'create_project', args: { title: offer.proposedTitle, use_existing_id: offer.existingId } }]
    }
    if (offer.kind !== 'reminder') return null
    const item = repo.getItem(offer.itemId)
    if (!item || !item.due_at_utc || item.status !== 'open') return null
    const due = DateTime.fromISO(item.due_at_utc, { zone: 'utc' }).toLocal()
    return item.due_precision === 'exact'
      ? [{ name: 'create_reminder', args: { item_id: item.id, fire_at_local: due.toFormat("yyyy-MM-dd'T'HH:mm") } }]
      : [{ name: 'create_reminder', args: { item_id: item.id, fire_date_local: due.toFormat('yyyy-MM-dd') } }]
  }

  if (/^(?:no|nope|no,? (?:it'?s |that'?s )?(?:a )?(?:new|different|separate)(?: project| thing| one)?|(?:a )?(?:new|different|separate) (?:project|thing|one)|it'?s (?:a )?(?:new|different) (?:one|project|thing))$/.test(text)) {
    const offer = getOffer()
    if (offer?.kind === 'project_match') return [{ name: 'create_project', args: { title: offer.proposedTitle, force_new: true } }]
    return null
  }

  // ---- waiting (3c): "they replied" / "heard back from TISS" / "the bank got back to me" ----
  if ((m = /^(?:ok,? |so,? |good news,? )?(?:(.+?) (?:replied|responded|got back to me|answered|came back to me|wrote back)|(?:i )?heard back(?: from (.+?))?|(.+?) (?:arrived|came through|came in|has arrived))(?: (?:finally|today|just now|this morning))?$/.exec(text))) {
    const who = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^(?:the |they |she |he |it )/, '').trim()
    const pool = repo.openWaitingItems()
    let target: Item | null = null
    if (pool.length === 1) target = pool[0]
    else if (pool.length > 1) {
      if (who && !/^(they|she|he|it|them)$/.test(who)) {
        const hits = pool.filter((w) => (w.waiting_on ?? '').toLowerCase().includes(who.toLowerCase()))
        if (hits.length === 1) target = hits[0]
      } else {
        // "they replied" with several waits: the one belonging to the Thing in focus, if exactly one.
        const proj = checklistTarget()
        const hits = proj ? pool.filter((w) => repo.parentProjectOf(w.id)?.id === proj.id) : []
        if (hits.length === 1) target = hits[0]
      }
    }
    if (!target) return null // ambiguous or nothing waiting — let the model ask
    return [{ name: 'resolve_waiting', args: { id: target.id, outcome: /arriv|came/.test(text) ? 'received' : 'replied' } }]
  }

  // ---- checklists (3b) ----
  // "add a list for the things I need to do" → acknowledge and remember which Thing the coming items belong to.
  if (/^(?:add|make|create|start|give me|let'?s (?:add|make)) (?:a )?(?:check ?list|list|to-?do list)(?: (?:for|of|with) .*)?$/.test(text)) {
    const target = checklistTarget()
    if (!target) return null
    setOffer({ kind: 'checklist_target', projectId: target.id })
    return [{ name: REPLY, args: { text: `Sure — a checklist on "${target.title}". Tell me the steps and I'll add them in order.` } }]
  }
  // "add send first email, follow up, and attach the document" (with a Thing in focus) → N checklist items.
  if ((m = /^(?:add|put|also add|and|then)[:\s]+(.+)$/.exec(text)) && !/\b(reminder|alarm)\b/.test(m[1])) {
    const target = checklistTarget()
    if (target) {
      const titles = splitList(restoreCase(m[1]))
      if (titles.length >= 1 && titles.every((t) => words(t).length > 0 || t.length >= 3)) {
        return [{ name: 'add_checklist_item', args: { project_id: target.id, titles: titles.map((t) => t.charAt(0).toUpperCase() + t.slice(1)) } }]
      }
    }
  }

  // ---- "X is something I need to deal with" → a Thing (project), never a task named after the sentence ----
  if ((m = /^(.+?) is (?:something|a thing|one thing|a big thing) (?:that )?i(?:'ve| have)? (?:really |also )?(?:need|have|got|want|ought) to (?:deal with|sort out|handle|figure out|look at|work on|get done|get sorted|finish|tackle|do)(?: (?:soon|this week|properly|eventually))?$/.exec(text)) ||
      (m = /^(?:new project|start a project|start tracking|track|let'?s track)[:\s]+(.+)$/.exec(text))) {
    const title = cleanTitle(m[1].replace(/^(?:the|my|this|that)\s+/i, ''), '')
    if (!title || words(title).length === 0) return null
    return [{ name: 'create_project', args: { title } }]
  }

  // ---- pause / resume the reminder ----
  if ((m = /^(pause|resume|unpause) (?:the |that |this |my )?(?:reminder|alarm)(?: (?:for|on|about) (?:the |that |this )?(.+))?$/.exec(text))) {
    const item = resolveTarget(m[2])
    if (!item) return null
    const rs = repo.pendingRemindersForItems([item.id])
    const rem = rs.length === 1 ? rs[0] : null
    return rem ? [{ name: 'pause_reminder', args: { id: rem.id, resume: m[1] !== 'pause' } }] : null
  }

  // ---- done ----
  if ((m = /^(?:ok(?:ay)?,? )?(?:i(?:'ve| have)? )?(?:done|finished|completed|did)(?: it| that| this)?(?: with)?(?: (?:the |that |this )?(.+))?$/.exec(text))) {
    const item = resolveTarget(m[1])
    return item ? [{ name: 'complete_item', args: { id: item.id } }] : null
  }
  if ((m = /^(.+?) (?:is|'s) done$/.exec(text))) {
    const item = resolveTarget(m[1])
    return item ? [{ name: 'complete_item', args: { id: item.id } }] : null
  }

  // ---- cancel the reminder (item stays) ----
  if ((m = /^(?:cancel|remove|delete|kill|scrap|stop|drop) (?:the |that |this |my )?(?:reminder|alarm)(?: (?:for|on|about) (?:the |that |this )?(.+))?$/.exec(text))) {
    const item = resolveTarget(m[1])
    const rem = item && liveReminderFor(item)
    return rem ? [{ name: 'cancel_reminder', args: { id: rem.id } }] : null
  }

  // ---- cancel one item ----
  if ((m = /^(?:cancel|scrap|drop|never ?mind|forget(?: about)?) (?:the |that |this |my )?(.+)$/.exec(text))) {
    const item = resolveTarget(m[1])
    // Projects may have parts: the spec says ask first, so let the model handle it.
    return item && item.kind !== 'project' ? [{ name: 'cancel_item', args: { id: item.id } }] : null
  }

  // ---- snooze ----
  if ((m = /^snooze(?: (?:it|that|this))?(?: (?:for )?(\d{1,3}) ?(m|min|mins|minutes|h|hr|hrs|hour|hours))?$/.exec(text)) ||
      (m = /^remind me again in (\d{1,3}) ?(m|min|mins|minutes|h|hr|hrs|hour|hours)$/.exec(text))) {
    const minutes = m[1] ? Number(m[1]) * UNIT_MIN[m[2]] : 15
    // Snooze only makes sense for an alarm that has already gone off. A future alarm is a "move", not a snooze —
    // leave that to the model so it can ask what the user meant.
    const since = DateTime.utc().minus({ hours: 3 }).toISO()!
    const fired = repo.listReminders().filter((r) => r.state === 'delivered' && (r.delivered_at ?? '') >= since)
    const top = getFocus()[0]
    let rem: Reminder | null = null
    if (top) rem = fired.find((r) => r.target_type === 'item' && r.target_id === top.itemId) ?? null
    if (!rem && fired.length === 1) rem = fired[0]
    return rem ? [{ name: 'snooze_reminder', args: { id: rem.id, minutes } }] : null
  }

  // ---- move / make it <time> ----
  if ((m = /^(?:actually,? )?(?:move|push|shift|change|reschedule) (.+?) to (.+)$/.exec(text)) ||
      (m = /^(?:actually,? )?(?:make|let'?s make) (it|that|this) (.+)$/.exec(text))) {
    const item = resolveTarget(m[1])
    if (!item) return null
    const tail = m[2].trim()
    const clock = parseClock(tail, item)
    if (clock) {
      if (!item.due_at_utc) return null // no date to attach a bare clock time to — let the model ask
      const base = DateTime.fromISO(item.due_at_utc, { zone: 'utc' }).toLocal()
      const dt = base.set({ hour: clock.hour, minute: clock.minute })
      return [{ name: 'update_item', args: { id: item.id, due_at_local: dt.toFormat("yyyy-MM-dd'T'HH:mm") } }]
    }
    const when = parseWhen(tail)
    if (!when || norm(when.text) !== tail) return null // the tail must be purely a date phrase
    return [{ name: 'update_item', args: { id: item.id, ...dueArgs(when) } }]
  }

  // ---- "remind me to X every <...> [at <time>]" — recurring ----
  if ((m = /^(?:please )?remind me (?:to |about |that )?(.+)$/.exec(text)) && /\b(every|each|daily|weekly|monthly|nightly|weekdays?|weekends?|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/.test(m[1])) {
    const rec = parseRecurrencePhrase(m[1])
    if (!rec) return null
    // An explicit clock in the leftover text ("at 5") wins; then a part-of-day hint; then the default reminder time.
    let clock: string | null = null
    let rest = rec.stripped
    const when = parseWhen(rest)
    if (when?.exact && when.dateTime) {
      clock = when.dateTime.slice(11, 16)
      rest = cleanTitle(rest, when.text)
    } else if (when && !when.exact) {
      rest = cleanTitle(rest, when.text) // "every sunday" left "sunday"-like residue; drop it
    }
    if (!clock) clock = rec.clockHint ?? repo.getPreference('default_reminder_time', '09:00').value
    const title = cleanTitle(rest, '')
    if (!title || words(title).length === 0) return null
    const first = firstOccurrence(rec.rrule, clock, DateTime.local().zoneName, new Date().toISOString())
    if (!first) return null
    log('info', 'router.recur', `${rec.rrule} at ${clock}, first ${first.anchorLocal}, title "${title}"`)
    return [{ name: 'create_item', args: { kind: 'task', title, remind_at_local: first.anchorLocal, remind_rrule: rec.rrule } }]
  }

  // ---- "remind me to X <date>" ----
  if ((m = /^(?:please )?remind me (?:to |about |that )?(.+)$/.exec(text))) {
    const when = parseWhen(m[1])
    if (!when) return null
    const title = cleanTitle(m[1], when.text)
    if (!title || words(title).length === 0) return null
    // Nothing is duplicated (invariant 9): "remind me to call the bank…" when "Call the bank" already exists
    // adds a reminder to that item instead of creating a second one.
    const existing = findItemByWords(title)
    if (existing && norm(existing.title) === norm(title)) {
      return [{ name: 'create_reminder', args: { item_id: existing.id, ...(when.exact ? { fire_at_local: when.dateTime } : { fire_date_local: when.date }) } }]
    }
    return [{ name: 'create_item', args: { kind: 'task', title, ...dueArgs(when), ...remindArgs(when) } }]
  }

  // ---- imperative create with a date, no reminder: "call the bank thursday at 3" ----
  if (IMPERATIVE.test(text)) {
    const when = parseWhen(text)
    if (!when) return null
    const title = cleanTitle(text, when.text)
    if (!title || words(title).length === 0) return null
    return [{ name: 'create_item', args: { kind: 'task', title, ...dueArgs(when) } }]
  }

  return null
}
