import type { DayBundle, DayStatus } from '../../../shared/types'
import { formatDue } from '../../../shared/format'
import { Marks, PrioritySummary, TYPE, TypeGlyph, titleClass } from './grammar'
import type { Selection } from './selection'

/**
 * Agenda (spec §8 6d): a CHRONOLOGICAL LIST. The coming days in order, each as a short block: the date and its status,
 * then everything on it in time order — all-day and spanning events first, then timed events and reminders by clock,
 * then what is due that day without a time. Nothing is a grid here; it reads top to bottom like a briefing.
 * Days with nothing on them collapse to one line so the list stays scannable.
 */

interface Props {
  days: DayBundle[]
  todayLocal: string
  onOpenDay: (date: string) => void
  onSelectOn: (date: string, s: Selection) => void
}

const STATUS_TONE: Record<DayStatus, string> = { light: 'text-emerald-800 bg-emerald-50', normal: 'text-stone-600 bg-stone-100', busy: 'text-amber-900 bg-amber-50', overloaded: 'text-rose-900 bg-rose-50' }
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const longDate = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

type Line = { at: string | null; key: string; node: React.ReactNode }

export function AgendaView({ days, todayLocal, onOpenDay, onSelectOn }: Props): React.JSX.Element {
  return (
    <div className="h-full min-h-0 overflow-y-auto pr-2 flex flex-col gap-3">
      {days.map((d) => {
        const s = d.summary
        const lines: Line[] = []
        for (const o of d.scheduled) {
          lines.push({
            at: o.all_day ? null : o.occurrence_start_utc,
            key: `ev:${o.id}:${o.occurrence_start_utc}`,
            node: (
              <Row onClick={() => onSelectOn(d.date, { kind: 'event', id: o.id, occurrenceStartUtc: o.occurrence_start_utc })} time={o.all_day ? (o.span === 'single' ? 'all day' : o.span) : `${clock(o.occurrence_start_utc)}${o.occurrence_end_utc ? `–${clock(o.occurrence_end_utc)}` : ''}`}>
                <span className="w-5 text-center shrink-0" aria-hidden>
                  {TYPE[o.kind ?? 'event'].glyph}
                </span>
                <span className={`break-words ${o.kind === 'commitment' ? 'font-medium' : ''}`}>{o.title}</span>
                <span className="text-[10px] text-stone-400 ml-1">{TYPE[o.kind ?? 'event'].word}</span>
              </Row>
            )
          })
        }
        for (const r of d.reminders) {
          lines.push({
            at: r.fire_at_utc,
            key: `r:${r.id}`,
            node: (
              <Row onClick={() => onSelectOn(d.date, { kind: 'reminder', id: r.id })} time={clock(r.fire_at_utc)}>
                <span className="w-5 text-center shrink-0" aria-hidden>
                  🔔
                </span>
                <span className="break-words">{r.item_title ?? 'Reminder'}</span>
                {r.state !== 'pending' && <span className="text-[10px] text-stone-400 ml-1">{r.state}</span>}
              </Row>
            )
          })
        }
        for (const i of d.unscheduled) {
          lines.push({
            at: i.due_precision === 'exact' && i.due_at_utc ? i.due_at_utc : null,
            key: `due:${i.id}`,
            node: (
              <Row onClick={() => onSelectOn(d.date, { kind: 'item', id: i.id })} time={i.due_precision === 'exact' && i.due_at_utc ? `by ${clock(i.due_at_utc)}` : 'due'}>
                <TypeGlyph item={i} />
                <span className={`break-words ${titleClass(i)}`}>{i.title}</span>
                <Marks item={i} className="ml-1" />
              </Row>
            )
          })
        }
        // Timed things by clock; untimed (all-day bands, due-without-time) first.
        lines.sort((a, b) => (a.at === null && b.at === null ? 0 : a.at === null ? -1 : b.at === null ? 1 : a.at.localeCompare(b.at)))
        const empty = lines.length === 0 && d.overdue.length === 0 && d.completed.length === 0
        return (
          <section key={d.date} className={`rounded-2xl p-3 ${d.date === todayLocal ? 'bg-white/80 ring-1 ring-mocha/40' : 'bg-white/50'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <button className="font-medium hover:text-mocha text-left" onClick={() => onOpenDay(d.date)} title="Open this day">
                {longDate(d.date)}
                {d.date === todayLocal ? <span className="text-xs text-stone-400 font-normal"> · today</span> : s.is_past ? <span className="text-xs text-stone-400 font-normal"> · past</span> : null}
              </button>
              {s.status && <span className={`text-[10px] rounded-full px-2 py-0.5 ${STATUS_TONE[s.status]}`}>{s.status}</span>}
              <div className="min-w-0">
                <PrioritySummary summary={s} priorities={d.priorities} compact />
              </div>
            </div>
            {empty ? (
              <div className="text-xs text-stone-400 mt-1">Nothing on this day.</div>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {d.overdue.length > 0 && d.date === todayLocal && (
                  <li className="text-[11px] text-amber-900 px-1">
                    ⚠ carried in: {d.overdue.map((i) => `${i.title}${i.due_at_utc ? ` (was ${formatDue(i.due_at_utc, i.due_precision)})` : ''}`).join(' · ')}
                  </li>
                )}
                {lines.map((l) => (
                  <li key={l.key}>{l.node}</li>
                ))}
                {d.completed.length > 0 && <li className="text-[11px] text-stone-400 px-1">✓ done: {d.completed.map((i) => i.title).join(' · ')}</li>}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function Row({ time, onClick, children }: { time: string; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button className="w-full text-left text-sm flex items-start gap-2 rounded-lg px-1 py-0.5 hover:bg-white/80" onClick={onClick}>
      <span className="w-24 shrink-0 text-xs text-stone-500 tabular-nums pt-0.5">{time}</span>
      <span className="min-w-0 flex-1 flex items-center gap-1 flex-wrap">{children}</span>
    </button>
  )
}
