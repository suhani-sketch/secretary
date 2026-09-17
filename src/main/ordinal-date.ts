/**
 * A bare day-of-month with no month named ("the 25th", "on the 23rd", "by the 30th") — chrono-node's parser (used
 * throughout `router.ts#parseWhen` and elsewhere) has no concept of this at all. Verified directly against the
 * library: "the 25th" alone returns zero results, and "meeting on the 23rd at 5pm" returns exactly one result
 * covering only "at 5pm", silently defaulting the date part to today. Both defaults were reaching users as a
 * mis-dated event or constraint with no error and no warning — this is the deterministic fix, used everywhere a bare
 * ordinal day needs resolving, so a chain of date references (7g) never re-derives it differently in different places.
 */
import { DateTime } from 'luxon'

export interface OrdinalDayMatch {
  /** The exact substring matched, so a caller can strip it out of a title the way it strips any other date phrase. */
  text: string
  /** ISO date (yyyy-MM-dd) of the next occurrence of that day-of-month on or after `refDate`, in `zone`. */
  date: string
}

const ORDINAL_DAY = /\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b)/i

/** Forward-looking, like chrono's own convention: this month if the day has not yet passed, otherwise next month. */
export function parseBareOrdinalDay(text: string, refDate: Date, zone: string): OrdinalDayMatch | null {
  const m = ORDINAL_DAY.exec(text)
  if (!m) return null
  const day = Number(m[1])
  if (day < 1 || day > 31) return null
  const today = DateTime.fromJSDate(refDate, { zone }).startOf('day')
  let cand = today
  for (let i = 0; i < 2; i++) {
    const inMonth = cand.set({ day: Math.min(day, cand.daysInMonth!) })
    if (inMonth >= today && inMonth.day === day) return { text: m[0], date: inMonth.toISODate()! }
    cand = cand.plus({ months: 1 }).startOf('month')
  }
  return null
}
