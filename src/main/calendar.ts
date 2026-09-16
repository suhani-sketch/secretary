import { DateTime } from 'luxon'
import * as repo from './repo'
import { constraintWindows } from './planning'
import { assembleDay, dayWindow } from '../core/calendar/aggregate'
import { expandEvents } from '../core/calendar/occurrences'
import type { Constraint, DayBundle, EventOccurrence } from '../shared/types'

/**
 * Main-process glue for the calendar (Phase 6): fetches rows from SQLite and hands them to the platform-independent
 * aggregation in src/core. Nothing here decides anything; it only gathers.
 */

/** Standing (rrule) constraints become concrete windows for the day so the core can count unavailable minutes. */
function concreteConstraints(fromUtc: string, toUtc: string): Constraint[] {
  const out: Constraint[] = []
  for (const c of repo.activeConstraints()) {
    if (!c.rrule) {
      out.push(c)
      continue
    }
    for (const w of constraintWindows(c, fromUtc, toUtc)) out.push({ ...c, starts_at: w.startUtc, ends_at: w.endUtc, rrule: null })
  }
  return out
}

export function buildDay(dateLocal: string): DayBundle {
  const zone = DateTime.local().zoneName
  const { startUtc, endUtc } = dayWindow(dateLocal, zone)
  return assembleDay({
    date: dateLocal,
    zone,
    nowUtc: new Date().toISOString(),
    events: repo.eventsTouching(startUtc, endUtc),
    items: repo.itemsForDay(startUtc, endUtc),
    reminders: repo.remindersBetween(startUtc, endUtc),
    notes: repo.dateNotesBetween(dateLocal, dateLocal),
    happenings: repo.happeningsBetween(startUtc, endUtc),
    constraints: concreteConstraints(startUtc, endUtc),
    waiting: repo.openWaitingItems()
  })
}

export function occurrencesBetween(fromUtc: string, toUtc: string): EventOccurrence[] {
  return expandEvents(repo.eventsTouching(fromUtc, toUtc), fromUtc, toUtc)
}
