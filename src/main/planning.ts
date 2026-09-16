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

/**
 * Conflict LEVELS (spec §8 6f): hard = genuine overlap with a timed booking or an unavailable window; tight = it fits but with
 * no breathing room (less than the default buffer before or after an adjacent booking); poor fit = it works but violates a
 * stated constraint or preference — an "avoid" window, or a transition buffer the user asked for ("thirty minutes to get home
 * from TISS"). Buffers live in `constraints` as kind='avoid' rows with label `buffer|after|30|TISS` and no window.
 */
export type ConflictLevel = 'clear' | 'tight' | 'poor' | 'hard'
export interface SlotAssessment {
  level: ConflictLevel
  hard: Conflict[]
  reasons: string[]
  /** First moment after the hard clashes end, if any. */
  next_free_utc: string | null
}
export interface BufferRule {
  id: string
  minutes: number
  side: 'after' | 'before' | 'around'
  /** Title fragment the rule applies to, or null for every booking. */
  scope: string | null
  label: string
}
export const DEFAULT_BUFFER_MIN = 15

export function bufferRules(): BufferRule[] {
  const out: BufferRule[] = []
  for (const c of repo.activeConstraints()) {
    const m = /^buffer\|(after|before|around)\|(\d{1,3})\|(.*)$/.exec(c.label)
    if (!m) continue
    out.push({ id: c.id, side: m[1] as BufferRule['side'], minutes: Number(m[2]), scope: m[3] ? m[3] : null, label: describeBuffer(m[1] as BufferRule['side'], Number(m[2]), m[3] || null) })
  }
  return out
}
export const describeBuffer = (side: BufferRule['side'], minutes: number, scope: string | null): string =>
  `${minutes} min ${side === 'around' ? 'either side of' : side} ${scope ? `"${scope}"` : 'anything'}`

export function assessSlot(startUtc: string, endUtc: string, ignoreEventId?: string): SlotAssessment {
  const all = conflictsFor(startUtc, endUtc).filter((c) => !(c.kind === 'event' && c.eventId === ignoreEventId))
  const hard = blockingConflicts(all)
  if (hard.length) return { level: 'hard', hard, reasons: hard.map(describeConflict), next_free_utc: afterConflicts(hard) }
  const reasons: string[] = []
  let level: ConflictLevel = 'clear'
  // Stated avoid/prefer windows → poor fit.
  for (const c of all) if (c.kind === 'avoid') (reasons.push(`sits in a time you avoid (${describeConflict(c)})`), (level = 'poor'))
  // Neighbours: what ends just before, what starts just after (a wider window than the slot itself).
  const around = DateTime.fromISO(startUtc, { zone: 'utc' }).minus({ hours: 3 }).toISO()!
  const until = DateTime.fromISO(endUtc, { zone: 'utc' }).plus({ hours: 3 }).toISO()!
  const neighbours = expandEvents(repo.eventsTouching(around, until), around, until).filter((o) => !o.all_day && o.id !== ignoreEventId)
  const rules = bufferRules()
  for (const o of neighbours) {
    const oEnd = o.occurrence_end_utc ?? o.occurrence_start_utc
    const gapBefore = (new Date(startUtc).getTime() - new Date(oEnd).getTime()) / 60_000 // this one ends, then our slot starts
    const gapAfter = (new Date(o.occurrence_start_utc).getTime() - new Date(endUtc).getTime()) / 60_000 // our slot ends, then this one starts
    for (const r of rules) {
      if (r.scope && !o.title.toLowerCase().includes(r.scope.toLowerCase())) continue
      if ((r.side === 'after' || r.side === 'around') && gapBefore >= 0 && gapBefore < r.minutes) (reasons.push(`only ${Math.round(gapBefore)} min after "${o.title}" — you asked for ${r.label}`), (level = 'poor'))
      if ((r.side === 'before' || r.side === 'around') && gapAfter >= 0 && gapAfter < r.minutes) (reasons.push(`only ${Math.round(gapAfter)} min before "${o.title}" — you asked for ${r.label}`), (level = 'poor'))
    }
    if (level !== 'poor') {
      if (gapBefore >= 0 && gapBefore < DEFAULT_BUFFER_MIN) (reasons.push(`straight after "${o.title}" (${Math.round(gapBefore)} min gap)`), (level = 'tight'))
      if (gapAfter >= 0 && gapAfter < DEFAULT_BUFFER_MIN) (reasons.push(`straight before "${o.title}" (${Math.round(gapAfter)} min gap)`), (level = 'tight'))
    }
  }
  return { level, hard: [], reasons, next_free_utc: null }
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
