import type { DayBundle, DayStatus } from '../../../shared/types'
import { PrioritySummary } from './grammar'

/**
 * Month (spec §8 6d): OVERVIEW. Workload, not appointments — where deadlines fall, where load clusters, where the gaps are.
 * Each cell is a day's summary from the Day View Model: a descriptive status tint (light / normal / busy / overloaded,
 * never a score), the compact priority chips, and multi-day all-day events drawn as continuous bands across cells.
 * Clicking a day goes to Day (execution). Our own grid — the library is not involved here.
 */

interface Props {
  /** First visible cell's date (a week start) and the bundles for every visible cell, in order. */
  gridStart: string
  days: DayBundle[]
  monthLabel: string
  /** The month being shown, "YYYY-MM"; other months' cells are muted. */
  ym: string
  weekStart: number
  todayLocal: string
  onOpenDay: (date: string) => void
}

const STATUS_BG: Record<DayStatus, string> = { light: 'bg-emerald-50/60', normal: 'bg-white/60', busy: 'bg-amber-50/80', overloaded: 'bg-rose-50/80' }
const STATUS_DOT: Record<DayStatus, string> = { light: 'bg-emerald-400', normal: 'bg-stone-300', busy: 'bg-amber-400', overloaded: 'bg-rose-500' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function MonthView({ days, ym, weekStart, todayLocal, onOpenDay }: Props): React.JSX.Element {
  const headers = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(weekStart + i) % 7])
  const weeks: DayBundle[][] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-7 text-[11px] text-stone-500 px-1 mb-1">
        {headers.map((h) => (
          <div key={h} className="px-2">
            {h}
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 grid grid-rows-[repeat(auto-fit,minmax(0,1fr))] gap-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="relative grid grid-cols-7 gap-1 min-h-0">
            {week.map((d) => {
              const inMonth = d.date.startsWith(ym)
              const s = d.summary
              const status = s.status
              return (
                <button
                  key={d.date}
                  onClick={() => onOpenDay(d.date)}
                  className={`relative text-left rounded-xl p-2 min-h-0 overflow-hidden flex flex-col gap-1 border ${d.date === todayLocal ? 'border-mocha' : 'border-transparent'} ${status ? STATUS_BG[status] : 'bg-white/30'} ${inMonth ? '' : 'opacity-45'} hover:ring-1 hover:ring-cocoa/30`}
                  title={status ? `${d.date}: ${status} · ${Math.round(s.scheduled_minutes / 6) / 10} h booked · ${s.due} due · ${s.overdue} overdue · ${s.hard_deadlines} hard deadline${s.hard_deadlines === 1 ? '' : 's'}` : `${d.date}: past`}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`tabular-nums ${d.date === todayLocal ? 'font-semibold text-cocoa' : 'text-stone-700'}`}>{Number(d.date.slice(8, 10))}</span>
                    {status && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-stone-500">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
                        {status}
                      </span>
                    )}
                    {s.is_past && s.completed > 0 && <span className="text-[10px] text-stone-400">✓ {s.completed}</span>}
                  </div>
                  {/* bands: multi-day / all-day events, drawn per cell with open ends where they continue */}
                  {d.scheduled
                    .filter((o) => o.all_day)
                    .slice(0, 2)
                    .map((o) => (
                      <div
                        key={`${o.id}:${o.occurrence_start_utc}`}
                        className={`text-[10px] px-1.5 py-0.5 truncate bg-mocha text-cream ${o.span === 'single' ? 'rounded' : o.span === 'starts' ? 'rounded-l -mr-3' : o.span === 'ends' ? 'rounded-r -ml-3' : '-mx-3'}`}
                        title={`${o.title}${o.span !== 'single' ? ` · ${o.span}` : ''}`}
                      >
                        {o.span === 'starts' || o.span === 'single' ? `▬ ${o.title}` : o.span === 'ends' ? `… ${o.title}` : '…'}
                      </div>
                    ))}
                  {/* workload: the compact priority summary from the model */}
                  <div className="min-h-0 overflow-hidden">
                    <PrioritySummary summary={s} priorities={d.priorities} compact />
                  </div>
                  {!s.is_past && s.scheduled > 0 && (
                    <div className="mt-auto text-[10px] text-stone-500 truncate">
                      {d.scheduled
                        .filter((o) => !o.all_day)
                        .slice(0, 2)
                        .map((o) => `${new Date(o.occurrence_start_utc).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })} ${o.title}`)
                        .join(' · ')}
                      {d.scheduled.filter((o) => !o.all_day).length > 2 ? ` +${d.scheduled.filter((o) => !o.all_day).length - 2}` : ''}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
