import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayBundle, Item } from '../../../shared/types'
import { formatClock, formatDue } from '../../../shared/format'
import { CalendarGrid, type GridEntry } from './CalendarAdapter'

/**
 * Day view (spec §8 6a): what the secretary knows about one date, from its existing records. Structure, in this order:
 * Priorities → Due today → Schedule → Reminders and follow-ups → Notes → Completed (collapsed).
 *
 * Time-bound and date-bound are kept apart: the Due area is a list, the Schedule is the time grid. A task never
 * occupies a slot. Everything shown is a reference to a real row, so anything clicked can be opened and edited.
 */

interface Props {
  dateLocal: string
  onChangeDate: (d: string) => void
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
const todayLocal = (): string => addDays(new Date().toISOString().slice(0, 10), 0)
const weekday = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

const STATUS_WORD: Record<DayBundle['status'], string> = { light: 'a light day', normal: 'a normal day', busy: 'a busy day', overloaded: 'an overloaded day' }
const STATUS_TONE: Record<DayBundle['status'], string> = { light: 'text-emerald-800 bg-emerald-50', normal: 'text-stone-700 bg-stone-100', busy: 'text-amber-900 bg-amber-50', overloaded: 'text-rose-900 bg-rose-50' }

/** Importance + hardness, never colour alone (spec 6c): a glyph and a word travel with every tone. */
export function importanceMark(i: Item): { glyph: string; word: string; tone: string } {
  const imp = i.importance ?? 2
  const hard = i.hardness === 'hard' || i.kind === 'deadline'
  if (i.kind === 'commitment') return { glyph: '🤝', word: `promised to ${i.committed_to ?? 'someone'}`, tone: 'text-rose-900' }
  if (imp <= 0) return { glyph: '‼', word: hard ? 'critical · hard deadline' : 'critical', tone: 'text-rose-900' }
  if (imp === 1) return { glyph: '!', word: hard ? 'high · hard deadline' : 'high', tone: 'text-amber-900' }
  if (hard) return { glyph: '◆', word: 'hard deadline', tone: 'text-stone-800' }
  if (imp >= 3) return { glyph: '·', word: 'low', tone: 'text-stone-400' }
  return { glyph: '•', word: 'normal', tone: 'text-stone-600' }
}

export function DayView({ dateLocal, onChangeDate, onOpenItem, onOpenEvent, onQuick, refreshKey }: Props): React.JSX.Element {
  const [day, setDay] = useState<DayBundle | null>(null)
  const [showDone, setShowDone] = useState(false)
  const load = useCallback(async () => {
    try {
      setDay(await window.api.getDay(dateLocal))
    } catch {
      setDay(null)
    }
  }, [dateLocal])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const entries: GridEntry[] = useMemo(() => {
    if (!day) return []
    const out: GridEntry[] = day.schedule.map((o) => ({
      id: `ev:${o.id}:${o.occurrence_start_utc}`,
      title: o.title,
      startUtc: o.occurrence_start_utc,
      endUtc: o.occurrence_end_utc,
      allDay: !!o.all_day,
      kind: o.kind === 'commitment' ? 'commitment' : o.kind === 'work_block' ? 'work_block' : o.kind === 'session' ? 'session' : 'event',
      editable: false, // manipulation is slice 6e
      data: o
    }))
    for (const c of day.constraints) {
      if (c.kind === 'unavailable' && c.starts_at && c.ends_at) out.push({ id: `c:${c.id}:${c.starts_at}`, title: c.label, startUtc: c.starts_at, endUtc: c.ends_at, allDay: false, kind: 'constraint', editable: false, tone: 'muted', data: c })
    }
    for (const h of day.happenings) {
      if (h.ends_at) out.push({ id: `h:${h.id}`, title: h.label, startUtc: h.started_at, endUtc: h.ends_at, allDay: false, kind: 'happening', editable: false, tone: 'muted', data: h })
    }
    return out
  }, [day])

  const isToday = dateLocal === todayLocal()
  return (
    <div className="flex flex-col gap-3 min-h-0 h-full">
      <div className="flex items-center gap-2">
        <button className="rounded-lg px-2 py-1 text-sm bg-white/70 hover:bg-white" onClick={() => onChangeDate(addDays(dateLocal, -1))} title="Previous day">
          ‹
        </button>
        <button className="rounded-lg px-2 py-1 text-sm bg-white/70 hover:bg-white" onClick={() => onChangeDate(todayLocal())} disabled={isToday}>
          today
        </button>
        <button className="rounded-lg px-2 py-1 text-sm bg-white/70 hover:bg-white" onClick={() => onChangeDate(addDays(dateLocal, 1))} title="Next day">
          ›
        </button>
        <h2 className="text-lg font-medium ml-2">{weekday(dateLocal)}</h2>
        {day && (
          <span className={`ml-auto text-xs rounded-full px-2 py-0.5 ${STATUS_TONE[day.status]}`} title={`${Math.round(day.scheduled_minutes / 6) / 10} h scheduled · ${day.due.length} due`}>
            {STATUS_WORD[day.status]}
          </span>
        )}
      </div>

      {!day ? (
        <div className="text-sm text-stone-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 min-h-0 flex-1">
          {/* left: the structured list */}
          <div className="flex flex-col gap-3 overflow-y-auto pr-1">
            <Section title="Priorities" empty="Nothing pressing." count={day.priorities.length}>
              {day.priorities.map((i) => (
                <ItemRow key={i.id} item={i} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: i.id })} showDue />
              ))}
            </Section>
            <Section title="Due today" empty="Nothing due." count={day.due.length} hint="date-bound: these do not take up time in the schedule">
              {day.due.map((i) => (
                <ItemRow key={i.id} item={i} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: i.id })} />
              ))}
            </Section>
            <Section title="Reminders and follow-ups" empty="No reminders." count={day.reminders.length + day.waiting.length}>
              {day.reminders.map((r) => (
                <li key={r.id} className="text-sm flex items-center gap-2 px-1 py-0.5">
                  <span className="text-xs">🔔</span>
                  <span className="flex-1 truncate">{r.item_title ?? 'Reminder'}</span>
                  <span className="text-xs text-stone-500 tabular-nums">{clock(r.fire_at_utc)}</span>
                  {r.state !== 'pending' && <span className="text-[10px] text-stone-400">{r.state}</span>}
                </li>
              ))}
              {day.waiting.map((w) => (
                <li key={w.id} className="text-sm flex items-center gap-2 px-1 py-0.5 cursor-pointer hover:bg-white/70 rounded" onClick={() => onOpenItem(w)}>
                  <span className="text-xs">⏳</span>
                  <span className="flex-1 truncate">
                    waiting on <span className="font-medium">{w.waiting_on ?? 'someone'}</span>
                    {w.details ? <span className="text-stone-500"> · {w.details}</span> : null}
                  </span>
                  {w.due_at_utc && <span className="text-xs text-stone-500">expected {formatDue(w.due_at_utc, w.due_precision)}</span>}
                </li>
              ))}
            </Section>
            <Section title="Notes" empty="No notes for this day." count={day.notes.length}>
              {day.notes.map((n) => (
                <li key={n.id} className="text-sm px-1 py-0.5 flex gap-2">
                  <span className="text-xs">📝</span>
                  <span className="text-stone-700">{n.body}</span>
                </li>
              ))}
            </Section>
            <section className="rounded-2xl bg-white/50 p-3">
              <button className="text-xs font-medium uppercase tracking-wide text-stone-500 flex items-center gap-2" onClick={() => setShowDone((v) => !v)}>
                <span>{showDone ? '▾' : '▸'}</span> Completed ({day.completed.length})
              </button>
              {showDone && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {day.completed.map((i) => (
                    <li key={i.id} className="text-sm text-stone-500 line-through px-1 cursor-pointer hover:text-stone-700" onClick={() => onOpenItem(i)}>
                      {i.title}
                    </li>
                  ))}
                  {!day.completed.length && <li className="text-sm text-stone-400 px-1">Nothing finished yet.</li>}
                </ul>
              )}
            </section>
          </div>

          {/* right: the schedule — time-bound things only */}
          <section className="rounded-2xl bg-white/50 p-3 flex flex-col min-h-0">
            <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
              Schedule <span className="normal-case font-normal text-stone-400">· {day.scheduled_minutes ? `${Math.round(day.scheduled_minutes / 6) / 10} h booked` : 'nothing booked'}</span>
            </h3>
            <div className="flex-1 min-h-0 cal-grid">
              <CalendarGrid
                view="day"
                dateLocal={dateLocal}
                entries={entries}
                dayStartHour={6}
                dayEndHour={24}
                allDayRow={false}
                renderEntry={(e) => <GridEntryContent entry={e} />}
                onEntryClick={(e) => {
                  if (e.kind === 'event' || e.kind === 'commitment' || e.kind === 'work_block' || e.kind === 'session') onOpenEvent((e.data as { id: string }).id)
                }}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, empty, hint, children }: { title: string; count: number; empty: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-2xl bg-white/50 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 flex items-baseline gap-2">
        {title} <span className="text-stone-400">({count})</span>
        {hint && <span className="normal-case font-normal text-[10px] text-stone-400 ml-auto">{hint}</span>}
      </h3>
      <ul className="mt-1.5 flex flex-col gap-0.5">{count ? children : <li className="text-sm text-stone-400 px-1">{empty}</li>}</ul>
    </section>
  )
}

function ItemRow({ item, onOpen, onDone, showDue }: { item: Item; onOpen: (i: Item) => void; onDone: () => void; showDue?: boolean }): React.JSX.Element {
  const mark = importanceMark(item)
  return (
    <li className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={() => onOpen(item)}>
      <span className={`w-4 text-center ${mark.tone}`} title={mark.word} aria-label={mark.word}>
        {mark.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.title}</div>
        <div className="text-xs text-stone-500 truncate">
          {mark.word}
          {item.kind !== 'task' && item.kind !== 'commitment' ? ` · ${item.kind}` : ''}
          {showDue && item.due_at_utc ? ` · ${formatDue(item.due_at_utc, item.due_precision)}` : ''}
        </div>
      </div>
      <button
        className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
        title="Done"
        onClick={(e) => {
          e.stopPropagation()
          onDone()
        }}
      >
        ✓
      </button>
    </li>
  )
}

/** Type grammar inside the grid (spec 6c): solid event, lighter work block, session, ephemeral happening. */
function GridEntryContent({ entry }: { entry: GridEntry }): React.JSX.Element {
  const glyph = entry.kind === 'commitment' ? '🤝' : entry.kind === 'work_block' ? '▤' : entry.kind === 'session' ? '📘' : entry.kind === 'happening' ? '⏱' : entry.kind === 'constraint' ? '' : '▪'
  return (
    <div className="px-1 leading-tight overflow-hidden">
      <div className="text-[11px] opacity-80 tabular-nums">{entry.allDay ? '' : `${clock(entry.startUtc)}${entry.endUtc ? `–${clock(entry.endUtc)}` : ''}`}</div>
      <div className="text-xs font-medium truncate">
        {glyph} {entry.title}
      </div>
    </div>
  )
}

export { formatClock }
