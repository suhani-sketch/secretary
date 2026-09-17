/**
 * Smart scheduling (spec §8 Phase 7e) — platform-independent, no Electron, no SQLite, no model.
 *
 * Given a duration and a horizon, find real gaps in the calendar big enough to hold it. This module only finds gaps
 * against HARD-busy windows (events + unavailable constraints) and workable hours; grading a candidate gap against
 * buffers/avoid-windows/neighbours is `planning.assessSlot`'s job in the glue layer, which already does it well —
 * duplicating that logic here would be the "computation in the wrong place" mistake spec §8 warns against.
 */
import { DateTime } from 'luxon'

export interface BusyWindow {
  startUtc: string
  endUtc: string
}

export interface FreeWindow {
  startUtc: string
  endUtc: string
  /** Whether the gap's start is bounded by a real busy window ending there (vs. the search boundary or a day's open). */
  precededByBusy: boolean
}

export interface FreeSearchInput {
  fromUtc: string
  untilUtc: string
  zone: string
  busy: BusyWindow[]
  /** Local hour the workable day starts/ends, e.g. 8 and 22. */
  workStartHour: number
  workEndHour: number
  durationMinutes: number
  /** Cap on how many qualifying windows to return (chronological). */
  max?: number
}

export interface FreeSearchResult {
  /** Gaps at least `durationMinutes` long, chronological, capped at `max`. */
  windows: FreeWindow[]
  /** Every workable minute not already busy across the whole search — "how much free time exists at all". */
  totalFreeMinutes: number
  /** The single longest uninterrupted gap found, in minutes — "the biggest block available, even if not enough". */
  longestGapMinutes: number
}

/** Merge overlapping/adjacent windows so gap arithmetic never double-counts or leaves a false micro-gap. */
function mergeBusy(busy: BusyWindow[]): BusyWindow[] {
  const sorted = [...busy].sort((a, b) => a.startUtc.localeCompare(b.startUtc))
  const out: BusyWindow[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.startUtc <= last.endUtc) last.endUtc = last.endUtc > w.endUtc ? last.endUtc : w.endUtc
    else out.push({ ...w })
  }
  return out
}

export function findFreeWindows(inp: FreeSearchInput): FreeSearchResult {
  const max = inp.max ?? 8
  const busy = mergeBusy(inp.busy)
  const windows: FreeWindow[] = []
  let totalFreeMinutes = 0
  let longestGapMinutes = 0

  let dayCursor = DateTime.fromISO(inp.fromUtc, { zone: 'utc' }).setZone(inp.zone).startOf('day')
  const until = DateTime.fromISO(inp.untilUtc, { zone: 'utc' })
  const from = DateTime.fromISO(inp.fromUtc, { zone: 'utc' })
  let guard = 0

  while (dayCursor.toUTC() < until && guard < 60) {
    guard++
    let dayStart = dayCursor.set({ hour: inp.workStartHour, minute: 0, second: 0, millisecond: 0 })
    let dayEnd = dayCursor.set({ hour: inp.workEndHour, minute: 0, second: 0, millisecond: 0 })
    if (dayStart.toUTC() < from) dayStart = from.setZone(inp.zone)
    if (dayEnd.toUTC() > until) dayEnd = until.setZone(inp.zone)
    dayCursor = dayCursor.plus({ days: 1 })
    if (dayEnd <= dayStart) continue

    const dayStartUtc = dayStart.toUTC().toISO()!
    const dayEndUtc = dayEnd.toUTC().toISO()!
    const touching = busy.filter((b) => b.startUtc < dayEndUtc && b.endUtc > dayStartUtc)

    let cursor = dayStartUtc
    let boundedByBusy = false
    for (const b of touching) {
      if (b.startUtc > cursor) {
        const gapMin = (new Date(b.startUtc).getTime() - new Date(cursor).getTime()) / 60_000
        totalFreeMinutes += gapMin
        longestGapMinutes = Math.max(longestGapMinutes, gapMin)
        if (gapMin >= inp.durationMinutes && windows.length < max) windows.push({ startUtc: cursor, endUtc: b.startUtc, precededByBusy: boundedByBusy })
      }
      if (b.endUtc > cursor) cursor = b.endUtc
      boundedByBusy = true
    }
    if (cursor < dayEndUtc) {
      const gapMin = (new Date(dayEndUtc).getTime() - new Date(cursor).getTime()) / 60_000
      totalFreeMinutes += gapMin
      longestGapMinutes = Math.max(longestGapMinutes, gapMin)
      if (gapMin >= inp.durationMinutes && windows.length < max) windows.push({ startUtc: cursor, endUtc: dayEndUtc, precededByBusy: boundedByBusy })
    }
  }
  return { windows, totalFreeMinutes: Math.round(totalFreeMinutes), longestGapMinutes: Math.round(longestGapMinutes) }
}
