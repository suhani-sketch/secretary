import { useMemo } from 'react'
import type { DayBundle, DayStatus } from '../../../shared/types'
import { CalendarGrid, type GridEntry } from './CalendarAdapter'
import { PrioritySummary, TYPE } from './grammar'
import type { Selection } from './selection'
import { UnscheduledList } from './UnscheduledList'
import { dropExternal, moveEntry, resizeEntry, type Quick } from './dragging'

/**
 * Week (spec §8 6d): PLANNING. Seven days side by side on one time grid, so the shape of the week is visible — where the
 * bookings cluster, where the free stretches are, what is due on which day. The all-day row is the DUE strip: date-bound
 * obligations sit there as markers and never occupy time; multi-day events run across it as bands; unavailable windows
 * are hatched. Each column header carries that day's status and compact priority chips from the Day View Model.
 * 6e: events move and resize by drag; a due chip dragged down into the grid, or an unscheduled obligation dragged in, becomes a work block.
 */

interface Props {
  weekStartDate: string
  days: DayBundle[]
  weekStart: number
  todayLocal: string
  onOpenDay: (date: string) => void
  onSelectOn: (date: string, s: Selection) => void
  onQuick: Quick
  refreshKey: number
}

const STATUS_TONE: Record<DayStatus, string> = { light: 'text-emerald-800', normal: 'text-stone-500', busy: 'text-amber-900', overloaded: 'text-rose-900' }
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

export function WeekView({ weekStartDate, days, weekStart, todayLocal, onOpenDay, onSelectOn, onQuick, refreshKey }: Props): React.JSX.Element {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const entries: GridEntry[] = useMemo(() => {
    const out: GridEntry[] = []
    const seenEvents = new Set<string>()
    for (const d of days) {
      for (const o of d.scheduled) {
        // A spanning occurrence appears in several bundles; the grid draws it once from its real start/end.
        const key = `${o.id}:${o.occurrence_start_utc}`
        if (seenEvents.has(key)) continue
        seenEvents.add(key)
        out.push({
          id: `ev:${key}`,
          title: o.title,
          startUtc: o.occurrence_start_utc,
          endUtc: o.occurrence_end_utc,
          allDay: !!o.all_day,
          kind: o.kind === 'commitment' ? 'commitment' : o.kind === 'work_block' ? 'work_block' : o.kind === 'session' ? 'session' : 'event',
          editable: !d.summary.is_past,
          data: { date: d.date, o }
        })
      }
      // Due strip: date-bound obligations as all-day markers — they take no time.
      for (const i of d.unscheduled) {
        out.push({ id: `due:${d.date}:${i.id}`, title: i.title, startUtc: `${d.date}T00:00:00`, endUtc: null, allDay: true, kind: 'due', editable: !d.summary.is_past, tone: i.hardness === 'hard' || i.kind === 'deadline' ? 'critical' : undefined, data: { date: d.date, item: i } })
      }
      for (const c of d.constraints) {
        if (c.kind === 'unavailable' && c.starts_at && c.ends_at) out.push({ id: `c:${c.id}:${c.starts_at}`, title: c.label, startUtc: c.starts_at, endUtc: c.ends_at, allDay: false, kind: 'constraint', editable: false, tone: 'muted' })
      }
    }
    return out
  }, [days])

  return (
    <div className="h-full min-h-0 grid grid-cols-[220px_minmax(0,1fr)] gap-4">
      <UnscheduledList refreshKey={refreshKey} onSelect={(date, id) => onSelectOn(date, { kind: 'item', id })} />
      <div className="min-h-0 cal-grid">
      <CalendarGrid
        view="week"
        dateLocal={weekStartDate}
        entries={entries}
        weekStart={weekStart}
        dayStartHour={6}
        dayEndHour={24}
        allDayRow
        renderDayHeader={(date, label) => {
          const d = byDate.get(date)
          const s = d?.summary
          return (
            <button className={`w-full text-left px-1 py-0.5 rounded-lg hover:bg-white/70 ${date === todayLocal ? 'ring-1 ring-mocha' : ''}`} onClick={() => onOpenDay(date)} title="Open this day">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-xs ${date === todayLocal ? 'font-semibold text-cocoa' : 'text-stone-700'}`}>{label}</span>
                {s?.status && <span className={`text-[10px] ${STATUS_TONE[s.status]}`}>{s.status}</span>}
                {s?.is_past && s.completed > 0 && <span className="text-[10px] text-stone-400">✓ {s.completed}</span>}
              </div>
              {s && d && (
                <div className="mt-0.5 min-h-[14px]">
                  <PrioritySummary summary={s} priorities={d.priorities} compact />
                </div>
              )}
            </button>
          )
        }}
        renderEntry={(e) => (
          <div className="px-1 leading-tight overflow-hidden">
            {!e.allDay && <div className="text-[10px] opacity-80 tabular-nums">{`${clock(e.startUtc)}${e.endUtc ? `–${clock(e.endUtc)}` : ''}`}</div>}
            <div className="text-[11px] font-medium truncate">
              {e.kind === 'due' ? (e.tone === 'critical' ? '◆' : TYPE.task.glyph) : e.kind === 'constraint' ? '' : TYPE[e.kind === 'reminder' ? 'reminder' : e.kind === 'happening' ? 'happening' : e.kind].glyph} {e.title}
            </div>
          </div>
        )}
        onEntryClick={(e) => {
          const data = e.data as { date: string; o?: { id: string; occurrence_start_utc: string }; item?: { id: string } } | undefined
          if (!data) return
          if (data.o) onSelectOn(data.date, { kind: 'event', id: data.o.id, occurrenceStartUtc: data.o.occurrence_start_utc })
          else if (data.item) onSelectOn(data.date, { kind: 'item', id: data.item.id })
        }}
        onDayClick={(date) => onSelectOn(date, { kind: 'date' })}
        onEntryMoved={(e, start, end, allDay, revert) => void moveEntry(e, start, end, allDay, revert, onQuick)}
        onEntryResized={(e, start, end, revert) => void resizeEntry(e, start, end, revert, onQuick)}
        onExternalDrop={(payload, start, end, allDay) => void dropExternal(payload, start, end, allDay, onQuick)}
      />
      </div>
    </div>
  )
}
