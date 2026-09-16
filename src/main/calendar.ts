import { DateTime } from 'luxon'
import * as repo from './repo'
import { constraintWindows } from './planning'
import { assembleDay, dayWindow } from '../core/calendar/aggregate'
import { expandEvents } from '../core/calendar/occurrences'
import type { Constraint, DayBundle, DaySummary, EventOccurrence, Item } from '../shared/types'

/**
 * Main-process glue for the calendar (Phase 6): fetches rows from SQLite and hands them to the platform-independent
 * Day View Model in src/core. Nothing here decides anything; it only gathers. Every view goes through `buildDay`.
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
  const events = repo.eventsTouching(startUtc, endUtc)
  const items = repo.itemsForDay(startUtc, endUtc)
  const waiting = repo.openWaitingItems()
  const eventIds = events.map((e) => e.id)
  const itemIds = [...new Set([...items.map((i) => i.id), ...waiting.map((w) => w.id)])]

  // Titles for note targets, so a note can say what it is on.
  const titles: Record<string, string> = {}
  for (const e of events) titles[e.id] = e.title
  for (const i of items) titles[i.id] = i.title
  for (const w of waiting) titles[w.id] = w.title

  // Blocked is computed from links, never stored (spec 3f).
  const blockedIds = new Set<string>()
  for (const i of items) if (i.status === 'open' && repo.blockersOf(i.id).length) blockedIds.add(i.id)

  // Project context: which Thing each item belongs to, and how much of that Thing is still open.
  const parentOf: Record<string, string> = {}
  const projectMap = new Map<string, { project: Item; open_parts: number }>()
  for (const i of items) {
    const p = i.kind === 'project' ? undefined : repo.parentProjectOf(i.id)
    if (!p) continue
    parentOf[i.id] = p.id
    if (!projectMap.has(p.id)) projectMap.set(p.id, { project: p, open_parts: repo.projectParts(p.id).filter((c) => c.status === 'open').length })
  }

  return assembleDay({
    date: dateLocal,
    zone,
    nowUtc: new Date().toISOString(),
    events,
    items,
    reminders: repo.remindersBetween(startUtc, endUtc),
    notes: [...repo.dateNotesBetween(dateLocal, dateLocal), ...repo.notesForMany('item', itemIds), ...repo.notesForMany('event', eventIds)],
    titles,
    happenings: repo.happeningsBetween(startUtc, endUtc),
    constraints: concreteConstraints(startUtc, endUtc),
    waiting,
    blockedIds,
    projects: [...projectMap.values()],
    parentOf,
    activities: repo.activitiesBetween(startUtc, endUtc)
  })
}

/** Summaries for a run of days (Month/Week take these) — the same model, once per day. */
export function buildSummaries(fromDateLocal: string, days: number): DaySummary[] {
  const out: DaySummary[] = []
  let d = DateTime.fromISO(fromDateLocal)
  for (let i = 0; i < days; i++) {
    out.push(buildDay(d.toISODate()!).summary)
    d = d.plus({ days: 1 })
  }
  return out
}

export function occurrencesBetween(fromUtc: string, toUtc: string): EventOccurrence[] {
  return expandEvents(repo.eventsTouching(fromUtc, toUtc), fromUtc, toUtc)
}
