/**
 * Morning briefing glue (Phase 8a): once per calendar day, the first time the window is shown, drop one concise
 * assistant message into the conversation summarising what today looks like. Computed and phrased entirely in code
 * (the Phase 7 rule carries forward — `core/briefing.ts` never sees a model), so this costs zero model calls.
 *
 * Deliberately independent of the companion's own "first open of the day" greeting (Phase 4, renderer-side,
 * localStorage): that one is a robust, purely visual cue that must still work even if this fails (no API key
 * needed here either, but keeping them decoupled means a DB hiccup here can never cost the user their greeting).
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { buildDay } from './calendar'
import { upcomingDeadlineTargets } from './deadlines'
import { describeBriefing, type ComingUpEntry } from '../core/briefing'
import type { ChatMessage } from '../shared/types'

const SETTING_KEY = 'briefing.lastDate'
/** How far ahead "coming up" looks — a plain heads-up window, shorter than 7b's own 14-day "at risk" horizon. */
const COMING_UP_DAYS = 3

export function hasBriefedToday(nowLocal = DateTime.local()): boolean {
  return repo.getSettingValue(SETTING_KEY) === nowLocal.toISODate()
}

/** Hard deadlines / dated Things due strictly AFTER today, within COMING_UP_DAYS — never anything due today itself,
 *  which is already covered by today's own `priorities` (avoiding saying the same thing twice). Filtered by LOCAL
 *  CALENDAR DATE, not elapsed hours from now: `upcomingDeadlineTargets`'s own cutoff is an exact hour count from
 *  "right now", so a deadline at 17:00 three calendar days out would be silently missed by a briefing that runs at
 *  say 04:39 (72 exact hours from now lands mid-afternoon on day 3, before 17:00) — over-fetch one extra day from
 *  it, then apply the real calendar-day bound ourselves. */
function comingUpSoon(today: string, zone: string, nowUtc: string): ComingUpEntry[] {
  const cutoffDate = DateTime.fromISO(today, { zone }).plus({ days: COMING_UP_DAYS }).toISODate()!
  return upcomingDeadlineTargets(COMING_UP_DAYS + 1, nowUtc)
    .map((i) => ({ item: i, localDate: i.due_at_utc ? DateTime.fromISO(i.due_at_utc, { zone: 'utc' }).setZone(zone).toISODate()! : null }))
    .filter((x): x is { item: (typeof x)['item']; localDate: string } => x.localDate !== null && x.localDate > today && x.localDate <= cutoffDate)
    .sort((a, b) => a.localDate.localeCompare(b.localDate))
    .map((x) => ({ title: x.item.title, dueLabel: DateTime.fromISO(x.item.due_at_utc!, { zone: 'utc' }).setZone(zone).toFormat('ccc d LLL') }))
}

/** Idempotent: safe to call on every window show. Returns the inserted message only the first time each day.
 *  The "already briefed today" flag is written only AFTER everything below succeeds — a transient failure (e.g. a
 *  momentarily locked database) leaves today's flag unset, so the very next window show tries again instead of
 *  silently going without a briefing for the rest of the day. */
export function maybeSendMorningBriefing(nowLocal = DateTime.local()): ChatMessage | null {
  const today = nowLocal.toISODate()!
  if (repo.getSettingValue(SETTING_KEY) === today) return null

  const zone = nowLocal.zoneName
  const bundle = buildDay(today)
  const text = describeBriefing(bundle, {
    dateLabel: nowLocal.toFormat('cccc d LLLL'),
    hourLocal: nowLocal.hour,
    when: (occurrenceStartUtc) => DateTime.fromISO(occurrenceStartUtc, { zone: 'utc' }).setZone(zone).toFormat('HH:mm'),
    comingUp: comingUpSoon(today, zone, nowLocal.toUTC().toISO()!)
  })
  const message = repo.insertMessage('assistant', text, 0)
  repo.setSettingValue(SETTING_KEY, today)
  return message
}
