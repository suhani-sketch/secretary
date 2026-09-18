/**
 * The creature initiates, rarely (spec §8 Phase 9e) — the three triggers that do NOT follow from the user's own
 * write action, so they cannot live in `personality.ts`'s reactive path: a long-running focus session, working
 * late, and a hard deadline now only hours away. (The other three named triggers — an important task finished, a
 * repeatedly-postponed one finally landing, an important wait resolving — ARE reactive, and live in
 * `personality.ts` itself, right beside every other "something just happened" observation.)
 *
 * All three here spend from `personality.ts`'s own shared budget (90 min gap, 3/day, never the same line twice) —
 * one single "how chatty is it today" allowance, not a separate one per feature, so a chatty proactive day leaves
 * less room for reactive lines and vice versa. Delivered as a quiet chat message, the exact channel 8a/8c already
 * use (`onMessageAdded`, never a toast) — nothing here is allowed to pop up over what the user is doing. Checked on
 * every scheduler tick, not just window-show, since a two-hour focus session can run its whole course without the
 * window ever needing to be shown again.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { tryProactiveLine } from './personality'
import { upcomingDeadlineTargets } from './deadlines'
import { log } from './log'
import type { ChatMessage } from '../shared/types'

const SETTING_FOCUS_NOTIFIED = 'initiate.focus_notified_ids'
const SETTING_LATE_NIGHT_DATE = 'initiate.late_night_date'
const SETTING_DEADLINE_NOTIFIED = 'initiate.deadline_soon_ids'

function loadIdSet(key: string): Set<string> {
  const raw = repo.getSettingValue(key)
  if (!raw) return new Set()
  try {
    const ids = JSON.parse(raw) as unknown
    return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}
function saveIdSet(key: string, ids: Set<string>): void {
  repo.setSettingValue(key, JSON.stringify([...ids]))
}

const FOCUS_LINES = ["You've been at this for two hours.", 'Two hours in, and still going.', "That's a proper stretch of focus."]
const LATE_NIGHT_LINES = ["I think that's enough for tonight.", "It's late — this will still be here tomorrow.", 'Whatever is left can wait for daylight.']
const deadlineSoonLines = (title: string, whenClock: string): string[] => [`"${title}" is due at ${whenClock} — just so it isn't a surprise.`, `Heads up — "${title}" is due at ${whenClock}.`]

const insertLine = (text: string): ChatMessage => repo.insertMessage('assistant', text, 0)

/** A focus-kind happening running two hours or more, not yet mentioned for this particular run of it. */
function checkLongFocus(nowLocal: DateTime): ChatMessage | null {
  const running = repo.runningHappenings().filter((h) => h.metaphor === 'focus')
  if (!running.length) return null
  const notified = loadIdSet(SETTING_FOCUS_NOTIFIED)
  for (const h of running) {
    if (notified.has(h.id)) continue
    const startedLocal = DateTime.fromISO(h.started_at, { zone: 'utc' }).toLocal()
    if (nowLocal.diff(startedLocal, 'minutes').minutes < 120) continue
    const line = tryProactiveLine(FOCUS_LINES)
    // Budget spent, or the user seems to be struggling right now (personality.ts's own rule 3) — stay quiet. Do
    // NOT mark this happening as notified: a later, calmer moment should still get to say it once.
    if (!line) return null
    notified.add(h.id)
    saveIdSet(SETTING_FOCUS_NOTIFIED, notified)
    log('info', 'initiate.long_focus', line, h.id)
    return insertLine(line)
  }
  return null
}

/** Genuinely late, AND the user has actually been doing something in the last 20 minutes — never fired against an
 *  app merely left open, idle, overnight. At most once per calendar night. */
function checkLateNight(nowLocal: DateTime): ChatMessage | null {
  if (!(nowLocal.hour >= 23 || nowLocal.hour < 3)) return null
  const today = nowLocal.toISODate()!
  if (repo.getSettingValue(SETTING_LATE_NIGHT_DATE) === today) return null
  const cutoff = nowLocal.minus({ minutes: 20 }).toUTC().toISO()!
  const activeRecently = repo.recentMessages(5).some((m) => m.role === 'user' && m.created_at >= cutoff)
  if (!activeRecently) return null
  const line = tryProactiveLine(LATE_NIGHT_LINES)
  if (!line) return null
  repo.setSettingValue(SETTING_LATE_NIGHT_DATE, today)
  log('info', 'initiate.late_night', line)
  return insertLine(line)
}

/** A hard deadline now only hours away — a calm heads-up, distinct from 8b's feasibility-risk toast (which only
 *  ever fires when the arithmetic says something won't fit; this is pure time proximity, regardless of feasibility,
 *  and could easily be the first word the user gets about it if things have been comfortably on track the whole
 *  way). Its own id-tracking, separate from 8b's — the two are different signals and neither should suppress the
 *  other. */
function checkDeadlineSoon(nowLocal: DateTime): ChatMessage | null {
  const notified = loadIdSet(SETTING_DEADLINE_NOTIFIED)
  const nowUtc = nowLocal.toUTC().toISO()!
  const targets = upcomingDeadlineTargets(1, nowUtc).filter((t) => t.hardness === 'hard' && t.due_at_utc)
  for (const t of targets) {
    if (notified.has(t.id)) continue
    const dueLocal = DateTime.fromISO(t.due_at_utc!, { zone: 'utc' }).toLocal()
    const hoursLeft = dueLocal.diff(nowLocal, 'hours').hours
    if (hoursLeft <= 0 || hoursLeft > 4) continue
    const line = tryProactiveLine(deadlineSoonLines(t.title, dueLocal.toFormat('HH:mm')))
    if (!line) return null
    notified.add(t.id)
    saveIdSet(SETTING_DEADLINE_NOTIFIED, notified)
    log('info', 'initiate.deadline_soon', line, t.id)
    return insertLine(line)
  }
  return null
}

/** Checked on every scheduler tick (spec: "never interrupting focused work" — a message that only shows up once
 *  the user looks back at the app is never an interruption; a toast would have been). At most one of the three
 *  fires per call — they already share one budget, there is no need to also race them against each other. */
export function maybeInitiate(nowLocal: DateTime = DateTime.local()): ChatMessage | null {
  return checkLongFocus(nowLocal) ?? checkLateNight(nowLocal) ?? checkDeadlineSoon(nowLocal)
}
