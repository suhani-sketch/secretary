import { DateTime } from 'luxon'
import type { RRule as RRuleClass } from 'rrule'
import * as rrulePkg from 'rrule'

// rrule ships a CommonJS bundle whose named exports Node cannot detect in ESM mode; resolve the class either way
// so this module runs both inside the Vite bundle and under plain `node tests/recurrence.test.ts`.
type RRuleCtor = typeof RRuleClass
const RRule: RRuleCtor =
  (rrulePkg as unknown as { RRule?: RRuleCtor }).RRule ?? (rrulePkg as unknown as { default: { RRule: RRuleCtor } }).default.RRule

/**
 * Recurrence for reminders (spec §1 "rrule", §9 "RRULE across DST is a classic off-by-one-hour bug").
 *
 * All arithmetic happens in the user's wall-clock time: a "9:00 every day" reminder stays at 9:00 local after a
 * daylight-saving change, because the series is anchored to a local wall-clock time + IANA zone, not to a UTC instant.
 * The rrule library only understands UTC, so local wall-clock times are shuttled through it as "fake UTC" dates.
 *
 * This module is deliberately free of app imports so it can be unit-tested with plain Node.
 */

export interface Series {
  /** RFC 5545 RRULE body, e.g. "FREQ=WEEKLY;BYDAY=SU" (no "RRULE:" prefix). */
  rrule: string
  /** Wall-clock anchor "yyyy-MM-ddTHH:mm" in `tz` — the first occurrence the user agreed to. */
  anchorLocal: string
  /** IANA zone the anchor was stated in. */
  tz: string
}

const WALL = "yyyy-MM-dd'T'HH:mm"

/** Local wall-clock → the same digits as a UTC instant, which is how rrule wants to see them. */
function toFake(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, 0, 0))
}
/** Fake-UTC digits → the real instant in `tz`. */
function fromFake(d: Date, tz: string): DateTime {
  return DateTime.fromObject(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() },
    { zone: tz }
  )
}

export function normalizeRRule(s: string): string {
  const body = s.trim().replace(/^RRULE:/i, '')
  RRule.fromString(`RRULE:${body}`) // throws if invalid
  return body
}

function buildRule(rrule: string, dtstartFake: Date): RRuleClass {
  const opts = RRule.parseString(normalizeRRule(rrule))
  return new RRule({ ...opts, dtstart: dtstartFake })
}

/** The first occurrence strictly after `afterUtcIso` (or at/after when `inclusive`), as a UTC ISO instant. */
export function nextOccurrenceUtc(series: Series, afterUtcIso: string, inclusive = false): string | null {
  const anchor = DateTime.fromFormat(series.anchorLocal, WALL, { zone: series.tz })
  if (!anchor.isValid) throw new Error(`Bad series anchor "${series.anchorLocal}"`)
  const rule = buildRule(series.rrule, toFake(anchor))
  const after = DateTime.fromISO(afterUtcIso, { zone: 'utc' }).setZone(series.tz)
  const nextFake = rule.after(toFake(after), inclusive)
  return nextFake ? fromFake(nextFake, series.tz).toUTC().toISO() : null
}

/**
 * Where a brand-new series should start: the first occurrence at `clock` (HH:MM) on or after now.
 * Returns both the UTC instant and the local anchor to store.
 */
export function firstOccurrence(rrule: string, clock: string, tz: string, nowUtcIso: string): { fireAtUtc: string; anchorLocal: string } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock)
  if (!m) throw new Error(`Bad clock "${clock}"`)
  const now = DateTime.fromISO(nowUtcIso, { zone: 'utc' }).setZone(tz)
  // Seed the rule from today at the requested clock; rrule then finds the first day the rule allows.
  const seed = now.set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 })
  const rule = buildRule(rrule, toFake(seed))
  const nextFake = rule.after(toFake(now), false)
  if (!nextFake) return null
  const first = fromFake(nextFake, tz)
  return { fireAtUtc: first.toUTC().toISO()!, anchorLocal: first.toFormat(WALL) }
}

export function describeRRule(rrule: string | null | undefined): string {
  if (!rrule) return ''
  try {
    return RRule.fromString(`RRULE:${normalizeRRule(rrule)}`).toText()
  } catch {
    return rrule
  }
}

// ---------- Natural-language recurrence (Tier 0) ----------

export interface RecurrencePhrase {
  rrule: string
  /** The text with the recurrence phrase removed. */
  stripped: string
  /** A clock implied by a part of day ("every morning"), when no explicit time is given. */
  clockHint?: string
}

const DAY: Record<string, string> = {
  monday: 'MO', mon: 'MO', tuesday: 'TU', tue: 'TU', tues: 'TU', wednesday: 'WE', wed: 'WE',
  thursday: 'TH', thu: 'TH', thur: 'TH', thurs: 'TH', friday: 'FR', fri: 'FR', saturday: 'SA', sat: 'SA', sunday: 'SU', sun: 'SU'
}
const DAY_RE = '(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?'
const PART: Record<string, string> = { morning: '09:00', afternoon: '14:00', evening: '18:00', night: '21:00', noon: '12:00', midday: '12:00' }

/** "every sunday", "daily", "every weekday at 9", "every other week", "every 3 days", "sundays" → RRULE + leftover text. */
export function parseRecurrencePhrase(input: string): RecurrencePhrase | null {
  const text = ` ${input.toLowerCase().replace(/\s+/g, ' ').trim()} `
  const tryRe = (re: RegExp, build: (m: RegExpExecArray) => { rrule: string; clockHint?: string } | null): RecurrencePhrase | null => {
    const m = re.exec(text)
    if (!m) return null
    const r = build(m)
    if (!r) return null
    const stripped = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    return { rrule: r.rrule, stripped, clockHint: r.clockHint }
  }

  return (
    // every 3 days / every other week / every second month
    tryRe(/ (?:every|each) (other|second|\d+) (day|week|month)s? /, (m) => {
      const n = m[1] === 'other' || m[1] === 'second' ? 2 : Number(m[1])
      const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY' }[m[2]]!
      return { rrule: n > 1 ? `FREQ=${freq};INTERVAL=${n}` : `FREQ=${freq}` }
    }) ??
    // every weekday / on weekdays / every weekend
    tryRe(/ (?:(?:every|each|on) )?(weekdays?|weekends?|work ?days?) /, (m) => ({
      rrule: /weekend/.test(m[1]) ? 'FREQ=WEEKLY;BYDAY=SA,SU' : 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    })) ??
    // every monday (and wednesday) / mondays and fridays / every mon, wed
    tryRe(new RegExp(` (?:(?:every|each|on) )?(${DAY_RE}s?(?:(?: ?,? ?(?:and|&|,) ?| )${DAY_RE}s?)*) `), (m) => {
      const words = m[1].split(/[\s,&]+|and/).map((w) => w.replace(/s$/, '')).filter(Boolean)
      const days = words.map((w) => DAY[w]).filter(Boolean)
      // Plain "sunday" is a date, not a recurrence — only "every sunday", "on sundays" or "sundays" recur.
      const recurring = /^ (?:every|each|on) /.test(m[0]) || /s /.test(m[0]) || /s(?:,| and| &)/.test(m[1])
      if (!days.length || !recurring) return null
      return { rrule: `FREQ=WEEKLY;BYDAY=${[...new Set(days)].join(',')}` }
    }) ??
    // every day / daily / every morning / each evening / nightly
    tryRe(/ (?:(?:every|each) (day|morning|afternoon|evening|night|noon|midday)|daily|nightly) /, (m) => ({
      rrule: 'FREQ=DAILY',
      clockHint: m[1] ? PART[m[1]] : m[0].includes('nightly') ? PART.night : undefined
    })) ??
    // every week / weekly · every month / monthly · every year / yearly
    tryRe(/ (?:every (week|month|year)|(weekly|monthly|yearly|annually)) /, (m) => {
      const w = m[1] ?? m[2]
      const freq = /week/.test(w) ? 'WEEKLY' : /month/.test(w) ? 'MONTHLY' : 'YEARLY'
      return { rrule: `FREQ=${freq}` }
    })
  )
}
