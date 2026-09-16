import { useState } from 'react'
import type { DayBundle, DayStatus, Item } from '../../../shared/types'
import { DayView } from './DayView'

/**
 * The Calendar surface (spec §7): its own full-width screen, switched to from the navigation — never a column inside the
 * conversation layout, and never with the conversation's rail beside it. Header: date navigation, Month / Week / Day /
 * Agenda. Only Day works in 6a; the other three are placeholders until 6d, and say so.
 */

export type CalendarMode = 'month' | 'week' | 'day' | 'agenda'

interface Props {
  dateLocal: string
  onChangeDate: (d: string) => void
  mode: CalendarMode
  onChangeMode: (m: CalendarMode) => void
  weekStart: number
  onChangeWeekStart: (n: number) => void
  onOpenItem: (item: Item) => void
  onOpenEvent: (eventId: string) => void
  onQuick: (tool: string, args: Record<string, unknown>) => Promise<void>
  refreshKey: number
}

const addDays = (d: string, n: number): string => {
  const [y, m, dd] = d.split('-').map(Number)
  const dt = new Date(y, m - 1, dd + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
export const todayLocal = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const longDate = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const hours = (min: number): string => `${Math.round(min / 6) / 10} h`

const STATUS_WORD: Record<DayStatus, string> = { light: 'a light day', normal: 'a normal day', busy: 'a busy day', overloaded: 'an overloaded day' }
const STATUS_TONE: Record<DayStatus, string> = { light: 'text-emerald-800 bg-emerald-50', normal: 'text-stone-700 bg-stone-100', busy: 'text-amber-900 bg-amber-50', overloaded: 'text-rose-900 bg-rose-50' }
const MODES: { id: CalendarMode; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'agenda', label: 'Agenda' }
]

export function CalendarSurface(p: Props): React.JSX.Element {
  const [summary, setSummary] = useState<DayBundle['summary'] | null>(null)
  const isToday = p.dateLocal === todayLocal()
  const step = p.mode === 'month' ? 30 : p.mode === 'week' || p.mode === 'agenda' ? 7 : 1
  return (
    <div className="flex flex-col min-h-0 h-full gap-4">
      {/* header: date navigation · status · view controls */}
      <header className="flex items-center gap-3 rounded-3xl bg-white/50 px-5 py-3">
        <div className="flex items-center gap-1">
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white" onClick={() => p.onChangeDate(addDays(p.dateLocal, -step))} title="Previous">
            ‹
          </button>
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white disabled:opacity-40" onClick={() => p.onChangeDate(todayLocal())} disabled={isToday}>
            today
          </button>
          <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white" onClick={() => p.onChangeDate(addDays(p.dateLocal, step))} title="Next">
            ›
          </button>
        </div>
        <h1 className="text-xl font-semibold tracking-tight truncate min-w-0">
          {longDate(p.dateLocal)}
          {summary?.is_past && <span className="text-sm text-stone-400 font-normal"> · looking back</span>}
        </h1>
        {summary?.status && p.mode === 'day' && (
          <span className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap ${STATUS_TONE[summary.status]}`} title={`${hours(summary.scheduled_minutes)} scheduled · ${summary.due} due · ${summary.overdue} overdue · ~${hours(summary.due_effort_minutes)} of due work · ${hours(summary.available_minutes)} available${summary.conflicts ? ` · ${summary.conflicts} clash${summary.conflicts === 1 ? '' : 'es'}` : ''}`}>
            {STATUS_WORD[summary.status]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
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
              <button key={m.id} role="tab" aria-selected={p.mode === m.id} onClick={() => p.onChangeMode(m.id)} className={`rounded-lg px-3 py-1 text-sm ${p.mode === m.id ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'text-stone-600 hover:bg-white'}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* body */}
      <div className="flex-1 min-h-0 rounded-3xl bg-white/50 p-5">
        {p.mode === 'day' ? (
          <DayView dateLocal={p.dateLocal} onOpenItem={p.onOpenItem} onOpenEvent={p.onOpenEvent} onQuick={p.onQuick} refreshKey={p.refreshKey} weekStart={p.weekStart} onLoaded={(b) => setSummary(b.summary)} />
        ) : (
          <div className="h-full flex items-center justify-center text-center text-stone-400 text-sm">
            <div>
              <div className="text-base text-stone-500 mb-1">{MODES.find((m) => m.id === p.mode)?.label} view arrives in slice 6d.</div>
              <div>It will be built from the same Day View Model that Day uses — {p.mode === 'month' ? 'one summary per day: workload, deadlines, gaps' : p.mode === 'week' ? 'seven days side by side, for planning' : 'the days in order, as a list'}.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
