import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'
import * as repo from '../repo'
import { clearOffer, getFocus, getOffer, setOffer } from './context'
import { firstOccurrence, parseRecurrencePhrase } from '../recurrence'
import { resolveEntity } from '../entity'
import { PART_OF_DAY } from '../planning'
import { log } from '../log'
import type { Item, Reminder } from '../../shared/types'
import { detectHappeningEnd, detectHappeningStart } from '../happenings'
import { RITUALS as RITUAL_OFFERS } from './tools'
import { occurrencesBetween } from '../calendar'

/** A bare "I'm making dinner": an ordinary reply, nothing created, no offer (invariant 9). */
function plainAcknowledgement(label: string): string {
  const l = label.toLowerCase()
  if (/dinner|lunch|breakfast|supper|brunch|meal|food|snack/.test(l)) return `Enjoy ${l.replace(/^(?:the|a|some)\s+/, '')}. I'm here if you want anything timed.`
  if (/tea|chai|coffee/.test(l)) return `Enjoy the ${l}.`
  return `Noted — nothing to do on my side. Say if you want it timed.`
}

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
    // "3:30" with no am/pm is an afternoon appointment, not half past three in the morning — same rule as a bare "3".
    if (!r.start.isCertain('meridiem') && h >= 1 && h <= 6) {
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

  // ---- "I haven't sent it yet" / "not yet" / "still haven't done it" → a status report, nothing to store ----
  // The thing stays outstanding exactly as it is. Only the user's OWN undone work matches; "haven't heard back" is a wait.
  if (
    /^(?:no,? |nope,? )?(?:not yet|not done yet|still not done|(?:i )?(?:still )?haven'?t (?:done |sent |finished |started |submitted |written |sent off |dealt with |got (?:a)?round to )?(?:it|that|this|them|.{1,40}?) yet)\.?$/.test(text) &&
    !/\b(?:heard|repl|got back|respond|answer|arriv)/.test(text)
  ) {
    return [{ name: REPLY, args: { text: 'Okay — still outstanding, then. I have left it as it is.' } }]
  }

  // ---- "yes" / "no" to a standing offer or question ----
  if (/^(?:yes|yes please|yep|yeah|sure|ok|okay|please|do it|go ahead|yes do|same|same thing|yes same|(?:yes,? )?(?:book|do|put|add|move|schedule) it anyway|anyway|go ahead anyway|yes anyway|override)$/.test(text)) {
    const offer = getOffer()
    if (!offer) return null
    if (offer.kind === 'conflict_override') {
      return [{ name: offer.toolName, args: offer.args }]
    }
    if (offer.kind === 'project_match') {
      return [{ name: 'create_project', args: { title: offer.proposedTitle, use_existing_id: offer.existingId } }]
    }
    if (offer.kind === 'ritual') {
      // Offered on a bare statement → nothing exists yet, so "yes" creates the timed happening now.
      if (!offer.happeningId) return [{ name: 'start_happening', args: { label: offer.label, minutes: offer.minutes, ...(offer.metaphor ? { metaphor: offer.metaphor } : {}) } }]
      return [{ name: 'time_happening', args: { id: offer.happeningId, minutes: offer.minutes } }]
    }
    if (offer.kind !== 'reminder') return null
    const item = repo.getItem(offer.itemId)
    if (!item || !item.due_at_utc || item.status !== 'open') return null
    const due = DateTime.fromISO(item.due_at_utc, { zone: 'utc' }).toLocal()
    return item.due_precision === 'exact'
      ? [{ name: 'create_reminder', args: { item_id: item.id, fire_at_local: due.toFormat("yyyy-MM-dd'T'HH:mm") } }]
      : [{ name: 'create_reminder', args: { item_id: item.id, fire_date_local: due.toFormat('yyyy-MM-dd') } }]
  }

  // "yes, 4 minutes" / "make it 6 minutes" / "4 min please" while a timer offer stands → time it with THAT length.
  if ((m = /^(?:yes,? |yeah,? |sure,? |ok,? |okay,? |make it |let'?s say |say )?(\d{1,3}) ?(?:m|min|mins|minutes?)(?: please| then| is good| works)?$/.exec(text))) {
    const offer = getOffer()
    if (offer?.kind === 'ritual') {
      if (!offer.happeningId) return [{ name: 'start_happening', args: { label: offer.label, minutes: Number(m[1]), ...(offer.metaphor ? { metaphor: offer.metaphor } : {}) } }]
      return [{ name: 'time_happening', args: { id: offer.happeningId, minutes: Number(m[1]) } }]
    }
  }

  if (/^(?:no|nope|no,? (?:it'?s |that'?s )?(?:a )?(?:new|different|separate)(?: project| thing| one)?|(?:a )?(?:new|different|separate) (?:project|thing|one)|it'?s (?:a )?(?:new|different) (?:one|project|thing))$/.test(text)) {
    const offer = getOffer()
    if (offer?.kind === 'project_match') return [{ name: 'create_project', args: { title: offer.proposedTitle, force_new: true } }]
    if (offer?.kind === 'ritual') return [{ name: 'decline_ritual', args: { kind: offer.happeningKind } }]
    return null
  }
  // A softer no to a timer offer: "no thanks", "nah", "not this time", "no timer", "I'm fine".
  if (/^(?:no thanks|no thank you|nah|nope thanks|not this time|no timer|no need|i'?m (?:fine|good|ok|okay)|it'?s fine|don'?t bother|no,? (?:i'?m )?(?:fine|good))$/.test(text)) {
    const offer = getOffer()
    if (offer?.kind === 'ritual') return [{ name: 'decline_ritual', args: { kind: offer.happeningKind } }]
    if (offer?.kind === 'reminder') {
      clearOffer()
      return [{ name: REPLY, args: { text: 'Okay, no reminder.' } }]
    }
    return null
  }

  // ---- living activities (Phase 5): happenings start and end here, before "done" can turn them into item completions ----
  // "egg's done" / "laundry's done" / "I'm out of the shower" → finish the running happening it names. Only when one is
  // actually running and matches; otherwise the phrase means an item and falls through to the ordinary rules.
  {
    const end = detectHappeningEnd(text)
    if (end) {
      const running = repo.runningHappenings()
      const h = end.fragment ? repo.matchHappening(running, end.fragment) : running.length === 1 ? running[0] : null
      if (h) return [{ name: 'finish_happening', args: { id: h.id, outcome: end.outcome } }]
      // "egg's done" after the timer already ended it: agree, don't fail — and don't let it become an item completion.
      const recent = end.fragment ? repo.matchHappening(repo.recentlyEndedHappenings(new Date(Date.now() - 6 * 3600_000).toISOString()), end.fragment, true) : null
      if (recent) {
        const at = DateTime.fromISO(recent.ends_at!, { zone: 'utc' }).toLocal().toFormat('HH:mm')
        return [{ name: REPLY, args: { text: recent.state === 'done' ? `Yes — the ${recent.label} finished at ${at}.` : `The ${recent.label} was dropped at ${at}; nothing is running for it.` } }]
      }
    }
    // "I'm making dinner, remind me to check it in 20 minutes" → the happening AND the alarm (§11F 2). The alarm's title
    // names the thing ("Check the dinner"), not "it".
    if ((m = /^(.+?),?\s+(?:and |then |but )?(?:please )?(?:remind me|ping me|nudge me|tell me) (?:to |about |that )?(.+)$/.exec(text))) {
      const first = detectHappeningStart(m[1])
      const when = parseWhen(m[2])
      if (first && when) {
        const rawTitle = m[2].replace(/\b(?:it|that|this)\b/g, `the ${first.label}`)
        const title = cleanTitle(rawTitle, when.text)
        if (title && words(title).length) {
          const args: Record<string, unknown> = { label: first.label }
          if (first.minutes) args.minutes = first.minutes
          if (first.metaphor) args.metaphor = first.metaphor
          return [
            { name: 'start_happening', args },
            { name: 'create_item', args: { kind: 'task', title, ...dueArgs(when), ...remindArgs(when) } }
          ]
        }
      }
    }
    // "I've put an egg on for 8 minutes" / "started the washing machine" / "starting a focus session" → a happening.
    // "I'm making dinner" / "I'm making tea" with nothing to time → NOTHING is created (invariant 9). At most one offer
    // where a default timer makes sense and that kind has not been declined; otherwise an ordinary reply.
    const start = detectHappeningStart(text)
    if (start) {
      if (start.bare) {
        const ritual = RITUAL_OFFERS[start.kind]
        if (ritual && repo.getSettingValue(`ritual.declined.${start.kind}`) !== '1') {
          setOffer({ kind: 'ritual', happeningId: null, happeningKind: start.kind, minutes: ritual.minutes, label: start.label, metaphor: start.metaphor })
          return [{ name: REPLY, args: { text: `${start.label[0].toUpperCase()}${start.label.slice(1)} — ${ritual.question[0].toLowerCase()}${ritual.question.slice(1)}` } }]
        }
        clearOffer()
        return [{ name: REPLY, args: { text: plainAcknowledgement(start.label) } }]
      }
      const args: Record<string, unknown> = { label: start.label }
      if (start.minutes) args.minutes = start.minutes
      if (start.metaphor) args.metaphor = start.metaphor
      return [{ name: 'start_happening', args }]
    }
  }

  // ---- today's context (5d): shapes today's reasoning, expires tonight, never stored as a task/note/memory ----
  if ((m = /^(?:honestly,? |ugh,? |god,? |so |really |i'?m just )?(?:i'?m|i am|i feel|feeling|i'?m feeling|i've been feeling) (?:so |really |very |pretty |quite |completely |absolutely |a bit |kind of |kinda )?(exhausted|tired|wiped|wiped out|drained|knackered|shattered|burnt out|burned out|worn out|low|down|flat|anxious|stressed|overwhelmed|not great|unwell|sick|ill|off|foggy|wired|restless|energised|energized|great|good|fine|better)(?: today| tonight| this morning| this evening| right now| at the moment)?$/.exec(text))) {
    const word = m[1]
    const kind = /anxious|stressed|overwhelmed|low|down|flat|not great|great|good|fine|better/.test(word) ? 'mood' : 'energy'
    return [{ name: 'note_context', args: { kind, text: word } }]
  }
  // "I'm at TISS until 5" / "I'm at the office till 6" → context + a same-day unavailable window so nothing gets booked there.
  if ((m = /^(?:i'?m|i am|i'?ll be|i will be) (?:at|in) (.+?) (?:until|till|til|up to) (\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?: today| tonight)?$/.exec(text))) {
    let hour = Number(m[2])
    const minute = m[3] ? Number(m[3]) : 0
    if (m[4] === 'pm' && hour < 12) hour += 12
    else if (!m[4] && hour <= 8) hour += 12
    const today = DateTime.local()
    const end = today.set({ hour, minute, second: 0, millisecond: 0 })
    if (end > today) {
      const place = restoreCase(m[1])
      return [
        { name: 'note_context', args: { kind: 'location', text: `at ${place} until ${end.toFormat('HH:mm')}` } },
        { name: 'add_constraint', args: { kind: 'unavailable', label: `at ${place}`, starts_at_local: today.toFormat("yyyy-MM-dd'T'HH:mm"), ends_at_local: end.toFormat("yyyy-MM-dd'T'HH:mm") } }
      ]
    }
  }

  // ---- commitments (5d): a promise to a named person — "I told Priya I'd send the draft tonight" ----
  if (
    (m = /^(?:i )?(?:told|promised|assured|said to) (.+?) (?:that )?(?:i'?d|i would|i'?ll|i will|i was going to|i'?m going to) (.+)$/.exec(text)) ||
    (m = /^(?:i )?(?:said|promised) (?:that )?(?:i'?d|i would|i'?ll|i will) (.+?) (?:to|for) (.+)$/.exec(text)) ||
    (m = /^(.+?) (?:is|are) expecting (?:me to |that i(?:'ll| will) )?(.+)$/.exec(text))
  ) {
    const swapped = /^(?:i )?(?:said|promised) (?:that )?(?:i'?d|i would|i'?ll|i will) /.test(text) && !/^(?:i )?(?:told|promised|assured|said to) /.test(text)
    const personRaw = swapped ? m[2] : m[1]
    const whatRaw = swapped ? m[1] : m[2]
    const person = restoreCase(personRaw).replace(/^(?:to|for)\s+/i, '').trim()
    if (person && person.split(' ').length <= 4 && !/\b(?:it|that|this|them|him|her|the)\b/i.test(person)) {
      const when = parseWhen(whatRaw)
      const title = cleanTitle(whatRaw, when?.text ?? '').replace(/\b(?:him|her|them)\b/gi, person)
      if (title && words(title).length) {
        return [{ name: 'create_item', args: { kind: 'commitment', title, committed_to: person, ...(when ? dueArgs(when) : {}) } }]
      }
    }
  }

  // ---- "what am I forgetting?" (5d) → deterministic, commitments first ----
  if (/^(?:so,? )?(?:what am i forgetting|am i forgetting (?:anything|something)|what have i forgotten|anything i'?m forgetting|what'?s slipping|am i missing anything|what am i missing)\??$/.test(text)) {
    return [{ name: 'get_forgetting', args: {} }]
  }

  // ---- "note for thursday: bring the signed copy" → a note on that DATE (information, never a task) ----
  if ((m = /^(?:add (?:a )?)?note (?:for|on|about) (today|tomorrow|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the \d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+ \d{1,2}(?:st|nd|rd|th)?)\s*[:\-–—,]\s*(.+)$/.exec(text))) {
    const when = parseWhen(m[1])
    if (when) return [{ name: 'add_note', args: { date_local: when.exact ? when.dateTime!.slice(0, 10) : when.date, body: restoreCase(m[2]) } }]
  }

  // ---- multi-day (6a): "I'm in Delhi Monday to Wednesday" → ONE all-day event spanning the days, never three ----
  if ((m = /^(?:i'?m|i am|i'?ll be|i will be|we'?re|we are) (?:going to be |away |off |travelling |traveling )?(?:in|at|to|visiting) (.+?) (?:from )?((?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|the \d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+ \d{1,2}(?:st|nd|rd|th)?)) (?:to|until|till|through|-|–) ((?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|the \d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+ \d{1,2}(?:st|nd|rd|th)?))$/.exec(text))) {
    const a = parseWhen(m[2])
    const b = parseWhen(m[3])
    if (a && b) {
      const first = a.exact ? a.dateTime!.slice(0, 10) : a.date!
      let last = b.exact ? b.dateTime!.slice(0, 10) : b.date!
      if (last < first) last = DateTime.fromISO(last).plus({ weeks: 1 }).toISODate()! // "friday to monday" rolls forward
      const place = restoreCase(m[1]).replace(/^(?:the )/i, '')
      return [{ name: 'create_event', args: { title: `In ${place}`, date_local: first, end_date_local: last } }]
    }
  }

  // ---- calendar (6a): "meeting with Professor X Thursday at 3" → event; "what am I doing thursday?" → get_day ----
  if ((m = /^(?:so,? )?(?:what(?:'s| is| am i doing| do i have| have i got| did i do| happened| was)(?: on| for)?|anything(?: on)?|show me|how was) (today|tomorrow|yesterday|(?:this |next |last )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the \d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+ \d{1,2}(?:st|nd|rd|th)?)\??$/.exec(text))) {
    const when = parseWhen(m[1])
    if (when && !when.exact) return [{ name: 'get_day', args: { date_local: when.date } }]
    if (when?.exact) return [{ name: 'get_day', args: { date_local: when.dateTime!.slice(0, 10) } }]
  }
  if ((m = /^(?:i(?:'ve| have) (?:got )?|i've got |there'?s |there is |put |add |book )?(?:a |an |my |the )?(meeting|call|appointment|dentist|doctor|gp|class|lecture|tutorial|seminar|workshop|interview|viva|lunch|dinner|coffee|drinks|catch[- ]?up|standup|stand-up|sync|review|presentation|exam|test|flight|train|haircut|gym class|rehearsal|session)\b(.*)$/.exec(text))) {
    // Recurring series in natural language (6e): "class every tuesday 2-4", "standup every weekday at 9:30".
    const rec = parseRecurrencePhrase(m[2])
    if (rec) {
      const range = /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(m[2])
      const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(m[2])
      const toClock = (h: number, mm: number, ap?: string): string => {
        let hour = h
        if (ap === 'pm' && hour < 12) hour += 12
        else if (ap === 'am' && hour === 12) hour = 0
        else if (!ap && hour >= 1 && hour <= 6) hour += 12
        return `${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
      }
      let clock: string | null = null
      let minutes: number | undefined
      if (range) {
        clock = toClock(Number(range[1]), range[2] ? Number(range[2]) : 0, range[5])
        const endClock = toClock(Number(range[3]), range[4] ? Number(range[4]) : 0, range[5])
        const [sh, sm] = clock.split(':').map(Number)
        const [eh, em] = endClock.split(':').map(Number)
        minutes = Math.max(15, eh * 60 + em - (sh * 60 + sm))
      } else if (at) clock = toClock(Number(at[1]), at[2] ? Number(at[2]) : 0, at[3])
      else if (rec.clockHint) clock = rec.clockHint
      if (clock) {
        const first = firstOccurrence(rec.rrule, clock, DateTime.local().zoneName, new Date().toISOString())
        if (first) {
          const title = cleanTitle(`${m[1]}${m[2]}`, '')
            .replace(/\s+(?:every|each|daily|weekly|monthly|weekdays?|weekends?)\b.*$/i, '')
            .replace(/\s+(?:on|at|from)\s*$/i, '')
            .trim()
          const args: Record<string, unknown> = { title: title || restoreCase(m[1]), starts_at_local: first.anchorLocal, rrule: rec.rrule }
          if (minutes) args.duration_minutes = minutes
          if (/meeting|call|appointment|dentist|doctor|gp|interview|viva|lunch|dinner|coffee|drinks|catch|class|lecture|tutorial|seminar|standup|stand-up|sync/.test(m[1])) args.kind = 'commitment'
          return [{ name: 'create_event', args }]
        }
      }
    }
    const when = parseWhen(text)
    if (when && when.exact) {
      const title = cleanTitle(`${m[1]}${m[2]}`, when.text).replace(/\s+(?:on|at|from)\s*$/i, '')
      const dur = /\b(\d{1,3}) ?(?:min|mins|minutes)\b/.exec(m[2])
      const hours = /\b(?:for )?(\d(?:\.5)?) ?(?:h|hr|hrs|hours?)\b/.exec(m[2])
      const range = /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(m[2])
      const args: Record<string, unknown> = { title, starts_at_local: when.dateTime }
      if (dur) args.duration_minutes = Number(dur[1])
      else if (hours) args.duration_minutes = Math.round(Number(hours[1]) * 60)
      else if (range) {
        const startH = Number(when.dateTime!.slice(11, 13))
        let endH = Number(range[3])
        const endM = range[4] ? Number(range[4]) : 0
        if (endH < startH || (endH <= 6 && !range[5])) endH += 12
        if (endH > startH || (endH === startH && endM > Number(when.dateTime!.slice(14, 16)))) args.duration_minutes = Math.max(15, endH * 60 + endM - (startH * 60 + Number(when.dateTime!.slice(14, 16))))
      }
      if (/\b(?:with|w\/)\b/.test(m[2]) || /meeting|call|appointment|dentist|doctor|gp|interview|viva|lunch|dinner|coffee|drinks|catch/.test(m[1])) args.kind = 'commitment'
      if (title && words(title).length) return [{ name: 'create_event', args }]
    }
  }

  // ---- availability (3f): "I'm busy tomorrow afternoon" / "I'm travelling on Friday" / "I'm out on the 20th" ----
  if ((m = /^(?:i(?:'m| am| will be|'ll be)|i have|i've got) (busy|unavailable|out|away|travelling|traveling|off|in class|in a meeting|at the gym|at work|on leave|on holiday|a class|a meeting|an exam|a flight)(?: (.+))?$/.exec(text))) {
    const label = m[1].replace(/^(?:a|an) /, '')
    const tail = m[2] ?? ''
    const part = /\b(morning|afternoon|evening|night|all day)\b/.exec(tail)?.[1]
    const range = /\b(?:from |between )?(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(tail)
    const rec = parseRecurrencePhrase(tail)
    const dateText = tail.replace(/\b(morning|afternoon|evening|night|all day)\b/, ' ').replace(range?.[0] ?? '', ' ').replace(rec ? tail.slice(tail.indexOf(tail.replace(rec.stripped, '').trim())) : '', ' ')
    const when = parseWhen(dateText.trim() || 'today')
    const day = when ? (when.exact ? when.dateTime!.slice(0, 10) : when.date!) : DateTime.local().toISODate()!
    let startH: number, endH: number, startM = 0, endM = 0
    if (range) {
      startH = Number(range[1]); startM = Number(range[2] ?? 0); endH = Number(range[3]); endM = Number(range[4] ?? 0)
      if (range[5] === 'pm') { if (startH < 12 && startH <= endH) startH += 12; if (endH < 12) endH += 12 } else if (!range[5]) { if (startH <= 7) startH += 12; if (endH <= 7 || endH < startH) endH += 12 }
    } else if (part && PART_OF_DAY[part]) [startH, endH] = PART_OF_DAY[part]
    else if (when?.exact) { const h = Number(when.dateTime!.slice(11, 13)); startH = h; endH = h + 1 }
    else [startH, endH] = [0, 24]
    const pad = (n: number): string => String(n).padStart(2, '0')
    const startLocal = `${day}T${pad(startH)}:${pad(startM)}`
    const endDay = endH >= 24 ? DateTime.fromISO(day).plus({ days: 1 }).toISODate()! : day
    const endLocal = `${endDay}T${pad(endH >= 24 ? 0 : endH)}:${pad(endM)}`
    const args: Record<string, unknown> = startH === 0 && endH === 24 && !rec ? { kind: 'unavailable', label, date_local: day } : { kind: 'unavailable', label, starts_at_local: startLocal, ends_at_local: endLocal }
    if (rec) args.rrule = rec.rrule
    return [{ name: 'add_constraint', args }]
  }

  // ---- dependencies (3f): "X blocks Y" / "Y depends on X" / "can't do Y until X is done" ----
  if ((m = /^(.+?) (?:blocks|is blocking) (.+)$/.exec(text)) || (m = /^(.+?) (?:depends on|is waiting on|needs|is blocked by) (.+?)(?: (?:first|to be done|being done))?$/.exec(text)) ||
      (m = /^(?:i )?can'?t (?:do|start|finish|send|submit) (.+?) (?:until|till|before) (.+?)(?: is| gets)? (?:done|finished|complete|completed|sorted|ready)$/.exec(text))) {
    const isBlocks = /\b(?:blocks|is blocking)\b/.test(text)
    const blockerText = isBlocks ? m[1] : m[2]
    const blockedText = isBlocks ? m[2] : m[1]
    const pool = repo.openItems(200)
    const rb = resolveEntity(blockerText, pool, getFocus().map((f) => f.itemId))
    const rd = resolveEntity(blockedText, pool, getFocus().map((f) => f.itemId))
    if (rb.kind === 'none' || rd.kind === 'none' || rb.entity.id === rd.entity.id) return null
    return [{ name: 'add_link', args: { from_id: rb.entity.id, to_id: rd.entity.id, type: 'blocks' } }]
  }

  // ---- notes (3d): "add a note to the application that the transcript must be a PDF" / "note: X" ----
  if ((m = /^(?:add |make |put )?(?:a )?note (?:to|on|for|about) (.+?)(?:,)? (?:that|saying|:) (.+)$/.exec(text))) {
    const pool = [...repo.openProjects(), ...repo.openItems(200).filter((i) => i.kind !== 'project')]
    const target = REF_WORDS.test(norm(m[1])) ? resolveTarget(m[1]) : (() => { const r = resolveEntity(m[1], pool, getFocus().map((f) => f.itemId)); return r.kind === 'none' ? null : r.entity })()
    if (!target) return null
    return [{ name: 'add_note', args: { item_id: target.id, body: restoreCase(m[2]) } }]
  }
  if ((m = /^note(?: to self)?[:\s]+(.+)$/.exec(text)) && !/^(?:to|on|for|about) /.test(m[1])) {
    // "note: thursday - bring the signed copy" names a day up front → a note on that DATE, not on whatever is in focus.
    const dated = /^(today|tomorrow|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|the \d{1,2}(?:st|nd|rd|th)?(?: of \w+)?|\w+ \d{1,2}(?:st|nd|rd|th)?)\s*[:\-–—,]\s*(.+)$/.exec(m[1])
    if (dated) {
      const when = parseWhen(dated[1])
      if (when) return [{ name: 'add_note', args: { date_local: when.exact ? when.dateTime!.slice(0, 10) : when.date, body: restoreCase(dated[2]) } }]
    }
    const top = getFocus()[0]
    const item = top ? repo.getItem(top.itemId) : undefined
    if (item && item.status !== 'done' && item.status !== 'cancelled') return [{ name: 'add_note', args: { item_id: item.id, body: restoreCase(m[1]) } }]
    return [{ name: 'add_note', args: { date_local: DateTime.local().toISODate(), body: restoreCase(m[1]) } }]
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

  // ---- project questions (§11B 9–10): "what is left?" / "what have I done for X?" → get_project, phrased in code ----
  // Deterministic so the answer always carries steps, waiting states and history together, never a from-memory summary.
  if ((m = /^(?:so |ok |okay )?(?:what(?:'s| is| else is)? (?:still )?(?:left|remaining|outstanding|to do|still to do)|what remains|what have i done|what did i do|what'?s done|where (?:am i|are we))(?: (?:on|for|with|of) (.+?))?\??$/.exec(text))) {
    let target: Item | null = null
    if (m[1]) {
      const r = resolveEntity(m[1], repo.openProjects(), getFocus().map((f) => f.itemId))
      if (r.kind === 'match') target = r.entity
      else return null // near-miss or unknown name — the model asks
    } else {
      target = checklistTarget()
    }
    if (!target) return null
    return [{ name: 'get_project', args: { id: target.id } }]
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

  // ---- cancel one item (or an upcoming event: "cancel the dentist", "cancel the meeting with X") ----
  if ((m = /^(?:cancel|scrap|drop|never ?mind|forget(?: about)?) (?:the |that |this |my )?(.+)$/.exec(text))) {
    const ref = m[1].replace(/ (?:meeting|appointment|event)$/, '').trim()
    const top = getFocus()[0]
    if (top?.kind === 'event' && REF_WORDS.test(norm(m[1]))) return [{ name: 'delete_event', args: { id: top.itemId } }]
    const upcoming = occurrencesBetween(new Date().toISOString(), DateTime.local().plus({ days: 60 }).toUTC().toISO()!)
    const evWords = words(ref)
    if (evWords.length) {
      const hits = upcoming.filter((o) => evWords.every((w) => o.title.toLowerCase().includes(w)))
      const distinct = new Set(hits.map((o) => o.id))
      if (distinct.size === 1 && !findItemByWords(ref)) return [{ name: 'delete_event', args: { id: hits[0].id } }]
    }
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
    const tail = m[2].trim()
    // "Move it to 4" right after a meeting was created → the event, not an item (Phase 6, §11C 2).
    const top = getFocus()[0]
    if (top?.kind === 'event' && REF_WORDS.test(norm(m[1]))) {
      const ev = repo.getEvent(top.itemId)
      if (!ev) return null
      const base = DateTime.fromISO(ev.starts_at_utc, { zone: 'utc' }).toLocal()
      const cm = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(tail)
      if (cm) {
        let hour = Number(cm[1])
        const minute = cm[2] ? Number(cm[2]) : 0
        if (cm[3] === 'pm' && hour < 12) hour += 12
        else if (cm[3] === 'am' && hour === 12) hour = 0
        else if (!cm[3] && !cm[2] && hour <= 12 && (hour <= 6 || (hour < 12 && base.hour >= 12))) hour += 12
        return [{ name: 'update_event', args: { id: ev.id, starts_at_local: base.set({ hour, minute }).toFormat("yyyy-MM-dd'T'HH:mm") } }]
      }
      const when = parseWhen(tail)
      if (!when || norm(when.text) !== tail) return null
      return when.exact
        ? [{ name: 'update_event', args: { id: ev.id, starts_at_local: when.dateTime } }]
        : [{ name: 'update_event', args: { id: ev.id, starts_at_local: DateTime.fromISO(when.date!).set({ hour: base.hour, minute: base.minute }).toFormat("yyyy-MM-dd'T'HH:mm") } }]
    }
    const item = resolveTarget(m[1])
    if (!item) return null
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

  // ---- imperative create with a date, no reminder: "call the bank thursday at 3" / "submit the report friday, hard deadline" ----
  if (IMPERATIVE.test(text)) {
    // A trailing "hard deadline" / "deadline" / "must" is hardness, not part of the title (spec: hardness is its own axis).
    const hardTail = /,?\s*(?:it'?s a |this is a |that'?s a )?(?:hard deadline|hard|deadline|non-negotiable|must)\s*$/i
    const hard = hardTail.test(text)
    const body = hard ? text.replace(hardTail, '') : text
    const when = parseWhen(body)
    if (!when) return null
    const title = cleanTitle(body, when.text)
    if (!title || words(title).length === 0) return null
    return [{ name: 'create_item', args: { kind: hard ? 'deadline' : 'task', title, ...dueArgs(when), ...(hard ? { hardness: 'hard' } : {}) } }]
  }

  return null
}
