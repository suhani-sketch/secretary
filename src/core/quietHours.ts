/**
 * Quiet hours (spec §8 8d; §5 "Follow-through" already named quiet hours as one input to how insistently the app
 * follows up) — platform-independent, no Electron, no SQLite, no model.
 *
 * Pure time-window arithmetic only: the caller supplies "now" as local minutes-since-midnight (explicit, never
 * system-implicit — matches every other `core/*.ts` module's convention of taking an explicit zone/clock rather
 * than reading `Date` directly) and the stored "HH:MM" boundaries. A window spanning midnight ("22:00" to "08:00")
 * is handled the same way as one that doesn't ("13:00" to "14:00").
 */

export interface QuietHoursWindow {
  /** "HH:MM", 24-hour, local. Either or both may be unset — quiet hours are opt-in, never inferred or defaulted. */
  start: string | null
  end: string | null
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** True if `nowMinutes` (0–1439, minutes since local midnight) falls inside the configured window. Always false
 *  when either boundary is unset, or the window has zero width — there is nothing to be quiet about. */
export function isWithinQuietHours(nowMinutes: number, window: QuietHoursWindow): boolean {
  if (!window.start || !window.end) return false
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  if (start === end) return false
  if (start < end) return nowMinutes >= start && nowMinutes < end
  return nowMinutes >= start || nowMinutes < end // spans midnight
}
