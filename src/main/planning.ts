import { DateTime } from 'luxon'
import * as repo from './repo'
import { nextOccurrenceUtc } from './recurrence'
import { expandEvents } from '../core/calendar/occurrences'
import { formatClock } from '../shared/format'
import type { Constraint } from '../shared/types'

/**
 * Deterministic planning helpers (spec §4 "Compute, don't reason", §8 3f). Conflict detection and availability are
 * computed from `constraints` and `events`; the model only phrases the result.
 */

export interface Window {
  startUtc: string
  endUtc: string
}

export interface Conflict {
  kind: 'unavailable' | 'avoid' | 'prefer' | 'event'
  label: string
  window: Window
  constraintId?: string
  eventId?: string
}

const overlaps = (a: Window, b: Window): boolean => a.startUtc < b.endUtc && b.startUtc < a.endUtc

/** Concrete occurrence windows of a constraint that touch [fromUtc, toUtc]. Standing rules expand via the wall-clock rrule. */
export function constraintWindows(c: Constraint, fromUtc: string, toUtc: string, tz = DateTime.local().zoneName): Window[] {
  if (!c.starts_at) return []
  const end = c.ends_at ?? DateTime.fromISO(c.starts_at, { zone: 'utc' }).plus({ hours: 1 }).toISO()!
  const durationMs = DateTime.fromISO(end).toMillis() - DateTime.fromISO(c.starts_at).toMillis()
  if (!c.rrule) return overlaps({ startUtc: c.starts_at, endUtc: end }, { startUtc: fromUtc, endUtc: toUtc }) ? [{ startUtc: c.starts_at, endUtc: end }] : []
  const series = { rrule: c.rrule, anchorLocal: DateTime.fromISO(c.starts_at, { zone: 'utc' }).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm"), tz }
  const out: Window[] = []
  // Start looking one duration before the range so an occurrence already underway at `fromUtc` is caught.
  let cursor = DateTime.fromISO(fromUtc, { zone: 'utc' }).minus({ milliseconds: durationMs + 60_000 }).toISO()!
  for (let i = 0; i < 100; i++) {
    const next = nextOccurrenceUtc(series, cursor, true)
    if (!next || next > toUtc) break
    const w = { startUtc: next, endUtc: DateTime.fromISO(next, { zone: 'utc' }).plus({ milliseconds: durationMs }).toISO()! }
    if (overlaps(w, { startUtc: fromUtc, endUtc: toUtc })) out.push(w)
    cursor = DateTime.fromISO(next, { zone: 'utc' }).plus({ minutes: 1 }).toISO()!
  }
  return out
}

/** Everything that clashes with booking [startUtc, endUtc]: unavailable/avoid/prefer constraints and calendar events. */
export function conflictsFor(startUtc: string, endUtc: string): Conflict[] {
  const range = { startUtc, endUtc }
  const out: Conflict[] = []
  for (const c of repo.activeConstraints()) {
    for (const w of constraintWindows(c, startUtc, endUtc)) out.push({ kind: c.kind, label: c.label, window: w, constraintId: c.id })
  }
  // Timed occurrences only (recurring series expanded through the one recurrence engine). All-day events — "in Delhi",
  // a conference — are context for the day, not a booking of every minute of it, so they never block a timed slot.
  for (const o of expandEvents(repo.eventsTouching(startUtc, endUtc), startUtc, endUtc)) {
    if (o.all_day) continue
    const w = { startUtc: o.occurrence_start_utc, endUtc: o.occurrence_end_utc ?? DateTime.fromISO(o.occurrence_start_utc).plus({ hours: 1 }).toISO()! }
    if (overlaps(w, range)) out.push({ kind: 'event', label: o.title, window: w, eventId: o.id })
  }
  return out
}

/** Only the conflicts that should stop a booking (hard unavailability and existing events). */
export const blockingConflicts = (cs: Conflict[]): Conflict[] => cs.filter((c) => c.kind === 'unavailable' || c.kind === 'event')

export function describeConflict(c: Conflict): string {
  const s = DateTime.fromISO(c.window.startUtc, { zone: 'utc' }).toLocal()
  const e = DateTime.fromISO(c.window.endUtc, { zone: 'utc' }).toLocal()
  const span = s.hasSame(e, 'day') ? `${s.toFormat('ccc d LLL HH:mm')}–${e.toFormat('HH:mm')}` : `${formatClock(c.window.startUtc)} → ${formatClock(c.window.endUtc)}`
  const what = c.kind === 'event' ? `your event "${c.label}"` : c.kind === 'unavailable' ? `"${c.label}" (unavailable)` : c.kind === 'avoid' ? `a time you avoid ("${c.label}")` : `a preference ("${c.label}")`
  return `${what} ${span}`
}

/** The first moment after the clashes end — a cheap "try this instead" until Phase 4's free-slot search. */
export function afterConflicts(cs: Conflict[]): string | null {
  const ends = cs.map((c) => c.window.endUtc).sort()
  return ends.length ? ends[ends.length - 1] : null
}

/** Booking window for an item with an exact due time: the hour ending at the due time. */
export function bookingWindowForDue(dueAtUtc: string, minutes = 60): Window {
  const end = DateTime.fromISO(dueAtUtc, { zone: 'utc' })
  return { startUtc: end.minus({ minutes }).toISO()!, endUtc: end.toISO()! }
}

/** Parts of the day as local hour ranges (used by tier 0 and by the model prompt's convention). */
export const PART_OF_DAY: Record<string, [number, number]> = {
  morning: [8, 12],
  afternoon: [12, 18],
  evening: [18, 22],
  night: [20, 23],
  'all day': [0, 24]
}

export function describeConstraint(c: Constraint): string {
  if (!c.starts_at) return c.label
  const s = DateTime.fromISO(c.starts_at, { zone: 'utc' }).toLocal()
  const e = c.ends_at ? DateTime.fromISO(c.ends_at, { zone: 'utc' }).toLocal() : null
  const allDay = e ? s.hour === 0 && s.minute === 0 && e.diff(s, 'hours').hours >= 23.9 : false
  const when = c.rrule
    ? `${allDay ? 'all day' : `${s.toFormat('HH:mm')}–${e?.toFormat('HH:mm') ?? ''}`}, ${describeRule(c.rrule)}`
    : allDay
      ? s.toFormat('ccc d LLL')
      : `${s.toFormat('ccc d LLL HH:mm')}–${e ? e.toFormat('HH:mm') : ''}`
  return `${c.label} — ${when}`
}

import { describeRRule as describeRule } from './recurrence'
