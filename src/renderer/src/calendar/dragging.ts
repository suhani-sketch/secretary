import { useEffect, type RefObject } from 'react'
import { ExternalDraggable, type GridEntry } from './CalendarAdapter'

/**
 * Manipulation (spec §8 6e): drag to move, resize to change duration, drag an unscheduled obligation onto the grid to
 * create a work block. Every change goes through the tool layer (`quick` → runTool), so it lands in `activities` and the
 * assistant knows about it at once. The library's own move is always reverted: the real row comes back through our data.
 * A single occurrence of a recurring series moves alone — the tool adds an exdate and a standalone event (6a/6e).
 */

const pad = (n: number): string => String(n).padStart(2, '0')
/** UTC ISO → local "YYYY-MM-DDTHH:MM" for the tool layer. */
export const toLocalDateTime = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const toLocalDate = (iso: string): string => toLocalDateTime(iso).slice(0, 10)

export type Quick = (tool: string, args: Record<string, unknown>) => Promise<void>

export interface OccurrenceData {
  o: { id: string; occurrence_start_utc: string; occurrence_end_utc: string | null; is_recurring_instance: boolean; all_day: number; title: string }
}
export interface DueData {
  item: { id: string; title: string }
}

/** An event/work block/session dragged to a new time; a due chip dragged down into the grid becomes a work block. */
export async function moveEntry(entry: GridEntry, newStartUtc: string, newEndUtc: string | null, allDay: boolean, revert: () => void, quick: Quick): Promise<void> {
  revert() // the library never keeps the change; our data does, after the tool has written it
  if (entry.kind === 'due') {
    const item = (entry.data as DueData | undefined)?.item
    if (!item || allDay) return // moving a due marker between days is a reschedule, done from the panel, not a drag
    const start = toLocalDateTime(newStartUtc)
    const end = toLocalDateTime(newEndUtc ?? new Date(new Date(newStartUtc).getTime() + 60 * 60_000).toISOString())
    await quick('create_event', { title: item.title, starts_at_local: start, ends_at_local: end, kind: 'work_block', item_id: item.id })
    return
  }
  const o = (entry.data as OccurrenceData | undefined)?.o
  if (!o) return
  if (allDay && !o.all_day) return // a timed event cannot be dropped into the due row
  const occurrence = o.is_recurring_instance ? { occurrence_start_local: toLocalDateTime(o.occurrence_start_utc) } : {}
  if (o.all_day) {
    await quick('update_event', { id: o.id, date_local: toLocalDate(newStartUtc), ...occurrence })
    return
  }
  const durationMs = o.occurrence_end_utc ? new Date(o.occurrence_end_utc).getTime() - new Date(o.occurrence_start_utc).getTime() : 60 * 60_000
  const end = newEndUtc ?? new Date(new Date(newStartUtc).getTime() + durationMs).toISOString()
  await quick('update_event', { id: o.id, starts_at_local: toLocalDateTime(newStartUtc), ends_at_local: toLocalDateTime(end), ...occurrence })
}

export async function resizeEntry(entry: GridEntry, newStartUtc: string, newEndUtc: string, revert: () => void, quick: Quick): Promise<void> {
  revert()
  const o = (entry.data as OccurrenceData | undefined)?.o
  if (!o || o.all_day) return
  const occurrence = o.is_recurring_instance ? { occurrence_start_local: toLocalDateTime(o.occurrence_start_utc) } : {}
  await quick('update_event', { id: o.id, starts_at_local: toLocalDateTime(newStartUtc), ends_at_local: toLocalDateTime(newEndUtc), ...occurrence })
}

/** Something dragged in from the unscheduled list. */
export async function dropExternal(payload: unknown, startUtc: string, endUtc: string | null, allDay: boolean, quick: Quick): Promise<void> {
  const item = payload as { id: string; title: string } | undefined
  if (!item?.id || allDay) return
  const end = endUtc ?? new Date(new Date(startUtc).getTime() + 60 * 60_000).toISOString()
  await quick('create_event', { title: item.title, starts_at_local: toLocalDateTime(startUtc), ends_at_local: toLocalDateTime(end), kind: 'work_block', item_id: item.id })
}

/**
 * Make every `[data-item-id]` element inside `ref` draggable onto the calendar. The element's data attributes carry the
 * payload; the library reads `title` and a one-hour default duration from them.
 */
export function useExternalDraggable(ref: RefObject<HTMLElement | null>, deps: unknown[]): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const d = new ExternalDraggable(el, {
      itemSelector: '[data-item-id]',
      eventData: (node) => ({
        title: node.getAttribute('data-title') ?? 'Work block',
        duration: '01:00',
        create: true,
        extendedProps: { payload: { id: node.getAttribute('data-item-id'), title: node.getAttribute('data-title') } }
      })
    })
    return () => d.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
