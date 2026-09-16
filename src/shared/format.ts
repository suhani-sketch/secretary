import type { DuePrecision } from './types'

/**
 * Honest due-time display (spec invariant 1). A `day`-precision item never shows a clock time,
 * because none was ever stated. Used by both the main process (for the model) and the renderer.
 */
export function formatDue(dueAtUtc: string | null, precision: DuePrecision | null, opts: { year?: boolean } = {}): string {
  if (!dueAtUtc) return ''
  const d = new Date(dueAtUtc)
  const day = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(opts.year ? { year: 'numeric' } : {})
  })
  switch (precision) {
    case 'day':
      return day
    case 'week':
      return `the week of ${day}`
    case 'vague':
      return `around ${day}`
    case 'exact':
    default:
      return `${day} at ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
}

/**
 * Overdue, honestly: an exact time is overdue once it passes; a day-only item only once that whole
 * day is over; a week/vague item once a week has passed. "Due today" is never "overdue".
 */
export function isOverdue(dueAtUtc: string | null, precision: DuePrecision | null, nowMs = Date.now()): boolean {
  if (!dueAtUtc) return false
  const due = new Date(dueAtUtc).getTime()
  const DAY = 24 * 3600 * 1000
  switch (precision) {
    case 'day':
      return due + DAY <= nowMs
    case 'week':
    case 'vague':
      return due + 7 * DAY <= nowMs
    default:
      return due < nowMs
  }
}

export function formatClock(utcIso: string | null): string {
  if (!utcIso) return ''
  const d = new Date(utcIso)
  return (
    d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) +
    ' at ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  )
}
