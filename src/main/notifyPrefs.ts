/**
 * Adaptive intensity and quiet hours (spec §8 8d; §5 "Follow-through" already named quiet hours and preferences as
 * inputs to how insistently the app follows up). Settings-backed; every proactive surface (regular reminder
 * delivery, 8b's deadline alerts, 8c's follow-up) reads through here before deciding whether/how to interrupt.
 * The actual time-window arithmetic is `core/quietHours.ts` — this module is just the settings glue and the
 * concrete effects each intensity level has, kept in ONE place so nothing drifts between the surfaces that read it.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { isWithinQuietHours } from '../core/quietHours'

const KEY_QUIET_START = 'notify.quiet_start'
const KEY_QUIET_END = 'notify.quiet_end'
const KEY_INTENSITY = 'notify.intensity'

export type Intensity = 'normal' | 'low'

export function getQuietHours(): { start: string | null; end: string | null } {
  return { start: repo.getSettingValue(KEY_QUIET_START), end: repo.getSettingValue(KEY_QUIET_END) }
}

export function setQuietStart(hhmm: string): void {
  repo.setSettingValue(KEY_QUIET_START, hhmm)
}

export function setQuietEnd(hhmm: string): void {
  repo.setSettingValue(KEY_QUIET_END, hhmm)
}

export function clearQuietHours(): void {
  repo.deleteSettingValue(KEY_QUIET_START)
  repo.deleteSettingValue(KEY_QUIET_END)
}

export function isQuietNow(nowLocal = DateTime.local()): boolean {
  return isWithinQuietHours(nowLocal.hour * 60 + nowLocal.minute, getQuietHours())
}

export function getIntensity(): Intensity {
  return repo.getSettingValue(KEY_INTENSITY) === 'low' ? 'low' : 'normal'
}

export function setIntensity(level: Intensity): void {
  repo.setSettingValue(KEY_INTENSITY, level)
}

/** The concrete effects of "low" intensity, gathered in one place so every proactive surface reads the SAME
 *  definition of "less pushy" rather than each inventing its own notion of it.
 *  - Every toast (reminders AND 8b's deadline alerts) stops demanding acknowledgement — auto-dismiss rather than
 *    staying on screen until acted on.
 *  - 8b's deadline alerts only fire on `infeasible` — the one verdict that is unarguable — not `tight`, which is a
 *    softer, more debatable signal.
 *  - 8c's daily follow-up names at most 1 new item instead of 3 (still says how many more are waiting, honestly). */
export interface IntensityEffects {
  toastPersistent: boolean
  deadlineAlertOnlyInfeasible: boolean
  followUpCap: number
}

export function intensityEffects(level: Intensity = getIntensity()): IntensityEffects {
  return level === 'low' ? { toastPersistent: false, deadlineAlertOnlyInfeasible: true, followUpCap: 1 } : { toastPersistent: true, deadlineAlertOnlyInfeasible: false, followUpCap: 3 }
}
