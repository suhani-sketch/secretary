import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayBundle, DayStatus, Item } from '../../../shared/types'
import { DayView } from './DayView'
import { DayPanel } from './DayPanel'
import { MonthView } from './MonthView'
import { WeekView } from './WeekView'
import { AgendaView } from './AgendaView'
import type { Selection } from './selection'
import { Legend, PrioritySummary } from './grammar'

/**
 * The Calendar surface (spec §7): its own full-width screen, switched to from the navigation — never a column inside the
 * conversation layout, and never with the conversation's rail beside it. Header: date navigation, Month / Week / Day /
 * Agenda. Four views with distinct jobs (6d) — Month is overview, Week is planning, Day is execution, Agenda is a
 * chronological list — all rendered from the same Day View Model, fetched once per visible range (`getDays`).
 * 6b: clicking anything opens the day detail panel on the right for that date, directly editable through the tool layer.
 */

export type CalendarMode = 'month' | 'week' | 'day' | 'agenda'

interface Props {
  dateLocal: string
  onChangeDate: (d: string) => void
  mode: CalendarMode
  onChangeMode: (m: CalendarMode) => void
  weekStart: number
  onChangeWeekStart: (n: number) => void
  /** Hands an item to the full editor (title, details, kind, recurrence…) for fields the panel does not carry. */
  onOpenEditor: (item: Item) => void
  onQuick: (tool: string, args: Record<string, unknown>) => Promise<void>
  refreshKey: number
  /** Dev hook: open the panel on load. */
  initialSelection?: Selection | null
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const addDays = (d: string, n: number): string => {
  const dt = parse(d)
  dt.setDate(dt.getDate() + n)
  return ymd(dt)
}
const addMonths = (d: string, n: number): string => {
  const dt = parse(d)
  dt.setDate(1)
  dt.setMonth(dt.getMonth() + n)
  return ymd(dt)
}
export const todayLocal = (): string => ymd(new Date())
/** The week-start on or before `d`, honouring the setting (0 Sunday … 6 Saturday). */
const startOfWeek = (d: string, weekStart: number): string => {
  const dt = parse(d)
  const diff = (dt.getDay() - weekStart + 7) % 7
  return addDays(d, -diff)
}
const longDate = (d: string): string => parse(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const shortDate = (d: string): string => parse(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const monthLabel = (d: string): string => parse(d).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
const hours = (min: number): string => `${Math.round(min / 6) / 10} h`

const STATUS_WORD: Record<DayStatus, string> = { light: 'a light day', normal: 'a normal day', busy: 'a busy day', overloaded: 'an overloaded day' }
const STATUS_TONE: Record<DayStatus, string> = { light: 'text-emerald-800 bg-emerald-50', normal: 'text-stone-700 bg-stone-100', busy: 'text-amber-900 bg-amber-50', overloaded: 'text-rose-900 bg-rose-50' }
const MODES: { id: CalendarMode; label: string; job: string }[] = [
  { id: 'month', label: 'Month', job: 'overview — where the load and the deadlines fall' },
  { id: 'week', label: 'Week', job: 'planning — the shape of the week' },
  { id: 'day', label: 'Day', job: 'execution — this day in full' },
  { id: 'agenda', label: 'Agenda', job: 'the coming days as a list' }
]
const AGENDA_DAYS = 14

/** The visible range for a mode: where it starts and how many days it covers. */
function rangeFor(mode: CalendarMode, dateLocal: string, weekStart: number): { from: string; days: number } {
  if (mode === 'day') return { from: dateLocal, days: 1 }
  if (mode === 'week') return { from: startOfWeek(dateLocal, weekStart), days: 7 }
  if (mode === 'agenda') return { from: dateLocal, days: AGENDA_DAYS }
  const first = addMonths(dateLocal, 0)
  const gridStart = startOfWeek(first, weekStart)
  const nextMonth = addMonths(dateLocal, 1)
  const daysToEnd = Math.round((parse(nextMonth).getTime() - parse(gridStart).getTime()) / 86_400_000)
  return { from: gridStart, days: Math.ceil(daysToEnd / 7) * 7 }
}

export function CalendarSurface(p: Props): React.JSX.Element {
  const [days, setDays] = useState<DayBundle[]>([])
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(p.initialSelection ?? null)
  const [panelDate, setPanelDate] = useState<string>(p.dateLocal)
  const today = todayLocal()
  const range = useMemo(() => rangeFor(p.mode, p.dateLocal, p.weekStart), [p.mode, p.dateLocal, p.weekStart])

  // One fetch per visible range; every view below reads from the same bundles.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setDays(await window.api.getDays(range.from, range.days))
    } catch {
      setDays([])
    } finally {
      setLoading(false)
    }
  }, [range.from, range.days])
  useEffect(() => {
    void load()
  }, [load, p.refreshKey])

  // A new date keeps the panel open (on the new date) if it was open; a thing-level selection is dropped.
  useEffect(() => {
    setPanelDate(p.dateLocal)
    setSelection((s) => (s ? { kind: 'date' } : s))
  }, [p.dateLocal])

  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const day = p.mode === 'day' ? (byDate.get(p.dateLocal) ?? null) : (byDate.get(panelDate) ?? null)
  const summary = p.mode === 'day' ? (byDate.get(p.dateLocal)?.summary ?? null) : null
  const isToday = p.dateLocal === today
  const step = (n: number): string => (p.mode === 'month' ? addMonths(p.dateLocal, n) : p.mode === 'week' ? addDays(p.dateLocal, 7 * n) : p.mode === 'agenda' ? addDays(p.dateLocal, AGENDA_DAYS * n) : addDays(p.dateLocal, n))
  const title =
    p.mode === 'month'
      ? monthLabel(p.dateLocal)
      : p.mode === 'week'
        ? `${shortDate(range.from)} – ${shortDate(addDays(range.from, 6))}`
        : p.mode === 'agenda'
          ? `from ${longDate(p.dateLocal)}`
          : longDate(p.dateLocal)
  const openDay = (d: string): void => {
    p.onChangeDate(d)
    p.onChangeMode('day')
  }
  const selectOn = (d: string, s: Selection): void => {
    setPanelDate(d)
    setSelection(s)
  }

  return (
    <div className="flex flex-col min-h-0 h-full gap-4">
      {/* header: date navigation · status · view controls */}
      <header className="flex items-center gap-3 rounded-3xl bg-white/50 px-5 py-3">
        <div className="flex items-center gap-1">
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white" onClick={() => p.onChangeDate(step(-1))} title="Previous">
            ‹
          </button>
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white disabled:opacity-40" onClick={() => p.onChangeDate(today)} disabled={isToday}>
            today
          </button>
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white" onClick={() => p.onChangeDate(step(1))} title="Next">
            ›
          </button>
        </div>
        <button className="text-xl font-semibold tracking-tight truncate min-w-0 text-left hover:text-[#8B6A55]" onClick={() => selectOn(p.dateLocal, selection?.kind === 'date' && panelDate === p.dateLocal ? ({ kind: 'date' } as Selection) : { kind: 'date' })} title="Open the day panel">
          {title}
          {summary?.is_past && <span className="text-sm text-stone-400 font-normal"> · looking back</span>}
        </button>
        {summary?.status && p.mode === 'day' && (
          <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${STATUS_TONE[summary.status]}`} title={`${hours(summary.scheduled_minutes)} scheduled · ${summary.due} due · ${summary.overdue} overdue · ~${hours(summary.due_effort_minutes)} of due work · ${hours(summary.available_minutes)} available${summary.conflicts ? ` · ${summary.conflicts} clash${summary.conflicts === 1 ? '' : 'es'}` : ''}`}>
            {STATUS_WORD[summary.status]}
          </span>
        )}
        <span className="text-xs text-stone-400 hidden lg:inline whitespace-nowrap">{MODES.find((m) => m.id === p.mode)?.job}</span>
        <div className="ml-auto flex items-center gap-3">
          {loading && <span className="text-[11px] text-stone-400">…</span>}
          <label className="text-[11px] text-stone-400 flex items-center gap-1 whitespace-nowrap" title="Which day the week starts on">
            week starts
            <select className="bg-white/80 rounded px-1 py-0.5 text-[11px] text-stone-600" value={p.weekStart} onChange={(e) => p.onChangeWeekStart(Number(e.target.value))}>
              <option value={1}>Mon</option>
              <option value={0}>Sun</option>
              <option value={6}>Sat</option>
            </select>
          </label>
          <div className="flex rounded-xl bg-white/80 p-0.5" role="tablist" aria-label="Calendar view">
            {MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={p.mode === m.id} onClick={() => p.onChangeMode(m.id)} className={`rounded-lg px-3 py-1 text-sm ${p.mode === m.id ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'text-stone-600 hover:bg-white'}`} title={m.job}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* what matters today, before any panel is opened (spec 6c) — and the grammar, so it is learnable */}
      {p.mode === 'day' && day && (
        <div className="flex items-center gap-4 px-5 -mt-1">
          <div className="min-w-0 flex-1">
            <PrioritySummary summary={day.summary} priorities={day.priorities} />
          </div>
          <div className="hidden xl:block shrink-0">
            <Legend />
          </div>
        </div>
      )}

      {/* body: the view, with the day panel beside it when something is selected */}
      <div className={`flex-1 min-h-0 grid gap-4 ${selection && day ? 'grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-1'}`}>
        <div className="min-h-0 rounded-3xl bg-white/50 p-5">
          {p.mode === 'day' && <DayView dateLocal={p.dateLocal} onSelect={(s) => selectOn(p.dateLocal, s)} selection={panelDate === p.dateLocal ? selection : null} onQuick={p.onQuick} refreshKey={p.refreshKey} weekStart={p.weekStart} onLoaded={(b) => setDays((ds) => (ds.some((d) => d.date === b.date) ? ds.map((d) => (d.date === b.date ? b : d)) : [...ds, b]))} />}
          {p.mode === 'month' && (days.length ? <MonthView gridStart={range.from} days={days} monthLabel={title} ym={p.dateLocal.slice(0, 7)} weekStart={p.weekStart} todayLocal={today} onOpenDay={openDay} /> : <Loading />)}
          {p.mode === 'week' && (days.length ? <WeekView weekStartDate={range.from} days={days} weekStart={p.weekStart} todayLocal={today} onOpenDay={openDay} onSelectOn={selectOn} /> : <Loading />)}
          {p.mode === 'agenda' && (days.length ? <AgendaView days={days} todayLocal={today} onOpenDay={openDay} onSelectOn={selectOn} /> : <Loading />)}
        </div>
        {selection && day && <DayPanel day={day} selection={selection} onSelect={(s) => selectOn(day.date, s)} onQuick={p.onQuick} onOpenEditor={p.onOpenEditor} onClose={() => setSelection(null)} />}
      </div>
    </div>
  )
}

function Loading(): React.JSX.Element {
  return <div className="h-full flex items-center justify-center text-sm text-stone-400">Loading…</div>
}
