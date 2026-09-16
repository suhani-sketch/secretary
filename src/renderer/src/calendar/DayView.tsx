import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayBundle, Item, PriorityEntry } from '../../../shared/types'
import { formatDue } from '../../../shared/format'
import { CalendarGrid, type GridEntry } from './CalendarAdapter'

/**
 * Day view (spec §8 6a): renders the Day View Model directly. Priorities → Due today → Schedule → Reminders and
 * follow-ups → Notes → Completed (collapsed). Past dates show what happened instead of what matters.
 * Nothing here computes: every number and ordering comes from src/core/calendar/aggregate.ts.
 */

interface Props {
  dateLocal: string
  onOpenItem: (item: Item) => void
  onOpenEvent: (eventId: string) => void
  onQuick: (tool: string, args: Record<string, unknown>) => Promise<void>
  refreshKey: number
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number
  /** The surface header shows the day's status; it learns it from here. */
  onLoaded?: (bundle: DayBundle) => void
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const hours = (min: number): string => `${Math.round(min / 6) / 10} h`


/** Importance + hardness as glyph AND word (spec 6c: never colour alone). */
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

export function DayView({ dateLocal, onOpenItem, onOpenEvent, onQuick, refreshKey, weekStart, onLoaded }: Props): React.JSX.Element {
  const [day, setDay] = useState<DayBundle | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const load = useCallback(async () => {
    try {
      const b = await window.api.getDay(dateLocal)
      setDay(b)
      onLoaded?.(b)
    } catch {
      setDay(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateLocal])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const entries: GridEntry[] = useMemo(() => {
    if (!day) return []
    const out: GridEntry[] = day.scheduled.map((o) => ({
      id: `ev:${o.id}:${o.occurrence_start_utc}`,
      title: o.span === 'continues' ? `${o.title} (continues)` : o.span === 'ends' ? `${o.title} (ends)` : o.span === 'starts' ? `${o.title} (starts)` : o.title,
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

  const spanning = day?.scheduled.filter((o) => o.all_day || o.span !== 'single') ?? []
  const s = day?.summary
  return (
    <div className="flex flex-col gap-3 min-h-0 h-full">
      {!day || !s ? (
        <div className="text-sm text-stone-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-5 min-h-0 flex-1">
          {/* left: the structured list */}
          <div className="flex flex-col gap-3 overflow-y-auto pr-1">
            {!s.is_past && (
              <Section title="Priorities" empty="Nothing pressing." count={day.priorities.length}>
                {day.priorities.map((p) => (
                  <PriorityRow key={p.item.id} p={p} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: p.item.id })} />
                ))}
              </Section>
            )}
            <Section title="Due today" empty="Nothing due." count={day.unscheduled.length} hint="date-bound · no time taken from the schedule">
              {day.unscheduled.map((i) => (
                <ItemRow key={i.id} item={i} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: i.id })} />
              ))}
            </Section>
            {spanning.length > 0 && (
              <Section title="All day" empty="" count={spanning.length}>
                {spanning.map((o) => (
                  <li key={`${o.id}:${o.occurrence_start_utc}`} className="text-sm flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/70 cursor-pointer" onClick={() => onOpenEvent(o.id)}>
                    <span className="text-xs">▬</span>
                    <span className="flex-1 break-words">{o.title}</span>
                    <span className="text-[10px] text-stone-400">{o.span === 'single' ? 'all day' : o.span}</span>
                  </li>
                ))}
              </Section>
            )}
            <Section title="Reminders and follow-ups" empty="No reminders." count={day.reminders.length + day.waiting.length}>
              {day.reminders.map((r) => (
                <li key={r.id} className="text-sm flex items-center gap-2 px-1 py-0.5">
                  <span className="text-xs">🔔</span>
                  <span className="flex-1 break-words">{r.item_title ?? 'Reminder'}</span>
                  <span className="text-xs text-stone-500 tabular-nums">{clock(r.fire_at_utc)}</span>
                  {r.state !== 'pending' && <span className="text-[10px] text-stone-400">{r.state}</span>}
                </li>
              ))}
              {day.waiting.map((w) => (
                <li key={w.id} className="text-sm flex items-center gap-2 px-1 py-0.5 cursor-pointer hover:bg-white/70 rounded" onClick={() => onOpenItem(w)}>
                  <span className="text-xs">⏳</span>
                  <span className="flex-1 break-words">
                    waiting on <span className="font-medium">{w.waiting_on ?? 'someone'}</span>
                    {w.details ? <span className="text-stone-500"> · {w.details}</span> : null}
                  </span>
                  {w.due_at_utc && <span className="text-xs text-stone-500">expected {formatDue(w.due_at_utc, w.due_precision)}</span>}
                </li>
              ))}
            </Section>
            <Section title="Notes" empty="No notes for this day." count={day.notes.length}>
              {day.notes.map((n) => (
                <li key={n.note.id} className="text-sm px-1 py-0.5 flex gap-2">
                  <span className="text-xs">📝</span>
                  <span className="text-stone-700">
                    {n.note.body}
                    {n.on_kind !== 'date' && <span className="text-stone-400 text-xs"> · on {n.on}</span>}
                  </span>
                </li>
              ))}
            </Section>
            {day.projects.length > 0 && (
              <Section title="Things involved" empty="" count={day.projects.length}>
                {day.projects.map((p) => (
                  <li key={p.project.id} className="text-sm px-1 py-0.5 cursor-pointer hover:bg-white/70 rounded" onClick={() => onOpenItem(p.project)}>
                    <span className="font-medium">{p.project.title}</span>
                    <span className="text-xs text-stone-500"> · {p.open_parts} open · today: {p.items_today.join(', ')}</span>
                  </li>
                ))}
              </Section>
            )}
            <section className="rounded-2xl bg-white/50 p-3">
              <button className="text-xs font-medium uppercase tracking-wide text-stone-500 flex items-center gap-2" onClick={() => setShowDone((v) => !v)}>
                <span>{showDone ? '▾' : '▸'}</span> Completed ({day.completed.length})
              </button>
              {showDone && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {day.completed.map((i) => (
                    <li key={i.id} className="text-sm text-stone-500 px-1 cursor-pointer hover:text-stone-700" onClick={() => onOpenItem(i)}>
                      <span className={i.status === 'done' ? 'line-through' : ''}>{i.title}</span>
                      {i.status === 'cancelled' && <span className="text-[10px] text-stone-400"> · dropped</span>}
                    </li>
                  ))}
                  {!day.completed.length && <li className="text-sm text-stone-400 px-1">Nothing finished{s.is_past ? ' that day' : ' yet'}.</li>}
                </ul>
              )}
            </section>
            {(s.is_past || s.is_today) && (
              <section className="rounded-2xl bg-white/50 p-3">
                <button className="text-xs font-medium uppercase tracking-wide text-stone-500 flex items-center gap-2" onClick={() => setShowHistory((v) => !v)}>
                  <span>{showHistory || s.is_past ? '▾' : '▸'}</span> What happened ({day.history.length})
                </button>
                {(showHistory || s.is_past) && (
                  <ul className="mt-2 flex flex-col gap-0.5">
                    {day.history.slice(0, 40).map((a) => (
                      <li key={a.id} className="text-xs text-stone-600 px-1 flex gap-2">
                        <span className="text-stone-400 tabular-nums w-10 shrink-0">{clock(a.created_at)}</span>
                        <span className="truncate">{a.summary}</span>
                      </li>
                    ))}
                    {!day.history.length && <li className="text-sm text-stone-400 px-1">Nothing recorded.</li>}
                  </ul>
                )}
              </section>
            )}
          </div>

          {/* right: the schedule — time-bound things only */}
          <section className="rounded-2xl bg-white/50 p-3 flex flex-col min-h-0">
            <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-2">
              Schedule <span className="normal-case font-normal text-stone-400">· {s.scheduled_minutes ? `${hours(s.scheduled_minutes)} booked` : 'nothing booked'}{s.conflicts ? ` · ${s.conflicts} clash${s.conflicts === 1 ? '' : 'es'}` : ''}</span>
            </h3>
            <div className="flex-1 min-h-0 cal-grid">
              <CalendarGrid
                view="day"
                dateLocal={dateLocal}
                entries={entries}
                dayStartHour={6}
                dayEndHour={24}
                allDayRow={false}
                weekStart={weekStart}
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

function PriorityRow({ p, onOpen, onDone }: { p: PriorityEntry; onOpen: (i: Item) => void; onDone: () => void }): React.JSX.Element {
  const mark = importanceMark(p.item)
  return (
    <li className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={() => onOpen(p.item)}>
      <span className={`w-4 text-center ${p.overdue ? 'text-amber-800' : mark.tone}`} title={p.reasons.join(', ')} aria-label={p.reasons.join(', ')}>
        {p.overdue ? '⚠' : mark.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words leading-snug">{p.item.title}</div>
        <div className={`text-xs truncate ${p.overdue ? 'text-amber-800' : 'text-stone-500'}`}>
          {p.overdue && p.item.due_at_utc ? `was due ${formatDue(p.item.due_at_utc, p.item.due_precision)}` : p.reasons.filter((r) => r !== 'overdue').join(' · ') || mark.word}
          {p.blocked ? ' · blocked' : ''}
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

function ItemRow({ item, onOpen, onDone }: { item: Item; onOpen: (i: Item) => void; onDone: () => void }): React.JSX.Element {
  const mark = importanceMark(item)
  return (
    <li className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={() => onOpen(item)}>
      <span className={`w-4 text-center ${mark.tone}`} title={mark.word} aria-label={mark.word}>
        {mark.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words leading-snug">{item.title}</div>
        <div className="text-xs text-stone-500 truncate">
          {mark.word}
          {item.kind !== 'task' && item.kind !== 'commitment' ? ` · ${item.kind}` : ''}
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
