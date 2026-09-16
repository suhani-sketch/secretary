import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DayBundle, Item, PriorityEntry } from '../../../shared/types'
import { formatDue } from '../../../shared/format'
import { CalendarGrid, type GridEntry } from './CalendarAdapter'
import type { Selection } from './selection'
import { dropExternal, moveEntry, resizeEntry, useExternalDraggable } from './dragging'
import { useRef } from 'react'
import { Marks, TypeGlyph, TYPE, titleClass, isHard } from './grammar'

/**
 * Day view (spec §8 6a): renders the Day View Model directly. Priorities → Due today → Schedule → Reminders and
 * follow-ups → Notes → Completed (collapsed). Past dates show what happened instead of what matters.
 * Nothing here computes: every number and ordering comes from src/core/calendar/aggregate.ts.
 */

interface Props {
  dateLocal: string
  /** Clicking anything selects it for the day panel (6b); the panel carries the editors. */
  onSelect: (s: Selection) => void
  selection: Selection | null
  onQuick: (tool: string, args: Record<string, unknown>) => Promise<void>
  refreshKey: number
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number
  /** The surface header shows the day's status; it learns it from here. */
  onLoaded?: (bundle: DayBundle) => void
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const hours = (min: number): string => `${Math.round(min / 6) / 10} h`


export function DayView({ dateLocal, onSelect, selection, onQuick, refreshKey, weekStart, onLoaded }: Props): React.JSX.Element {
  const onOpenItem = (i: Item): void => onSelect({ kind: 'item', id: i.id })
  const isSel = (kind: Selection['kind'], id: string): boolean => !!selection && selection.kind === kind && 'id' in selection && selection.id === id
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
      editable: !day.summary.is_past,
      data: { o }
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
  const dueRef = useRef<HTMLUListElement>(null)
  useExternalDraggable(dueRef, [day?.unscheduled.map((i) => i.id).join(',') ?? ''])
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
                  <PriorityRow key={p.item.id} p={p} active={isSel('item', p.item.id)} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: p.item.id })} />
                ))}
              </Section>
            )}
            <Section title="Due today" empty="Nothing due." count={day.unscheduled.length} hint={day.summary.is_past ? 'date-bound' : 'date-bound · drag onto the grid to set time aside'} ulRef={dueRef}>
              {day.unscheduled.map((i) => (
                <ItemRow key={i.id} item={i} active={isSel('item', i.id)} onOpen={onOpenItem} onDone={() => void onQuick('complete_item', { id: i.id })} draggable={!day.summary.is_past} />
              ))}
            </Section>
            {spanning.length > 0 && (
              <Section title="All day" empty="" count={spanning.length}>
                {spanning.map((o) => (
                  <li key={`${o.id}:${o.occurrence_start_utc}`} className={`text-sm flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer ${isSel('event', o.id) ? 'bg-white ring-1 ring-[#3A2E28]/30' : 'hover:bg-white/70'}`} onClick={() => onSelect({ kind: 'event', id: o.id, occurrenceStartUtc: o.occurrence_start_utc })}>
                    <span className="text-xs">▬</span>
                    <span className="flex-1 break-words">{o.title}</span>
                    <span className="text-[10px] text-stone-400">{o.span === 'single' ? 'all day' : o.span}</span>
                  </li>
                ))}
              </Section>
            )}
            <Section title="Reminders and follow-ups" empty="No reminders." count={day.reminders.length + day.waiting.length}>
              {day.reminders.map((r) => (
                <li key={r.id} className={`text-sm flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer ${isSel('reminder', r.id) ? 'bg-white ring-1 ring-[#3A2E28]/30' : 'hover:bg-white/70'}`} onClick={() => onSelect({ kind: 'reminder', id: r.id })}>
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
            {(day.unscheduled.some(isHard) || day.overdue.some(isHard) || day.reminders.length > 0) && (
              <div className="mb-2 flex items-center gap-1.5 flex-wrap text-[11px]">
                {[...day.unscheduled, ...day.overdue].filter(isHard).map((i) => (
                  <button key={i.id} className="inline-flex items-center gap-1 rounded-full bg-[#3A2E28] text-[#FAF6F0] px-2 py-0.5" onClick={() => onSelect({ kind: 'item', id: i.id })} title="hard deadline">
                    <span aria-hidden>◆</span>
                    {i.title}
                    {i.due_at_utc && i.due_precision === 'exact' ? ` · ${clock(i.due_at_utc)}` : ''}
                  </button>
                ))}
                {day.reminders.map((r) => (
                  <button key={r.id} className="inline-flex items-center gap-1 rounded-full bg-white ring-1 ring-stone-200 text-stone-700 px-2 py-0.5" onClick={() => onSelect({ kind: 'reminder', id: r.id })} title={`reminder · ${r.state}`}>
                    <span aria-hidden>🔔</span>
                    {clock(r.fire_at_utc)} {r.item_title ?? ''}
                  </button>
                ))}
              </div>
            )}
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
                onEntryMoved={(e, start, end, allDay, revert) => void moveEntry(e, start, end, allDay, revert, onQuick)}
                onEntryResized={(e, start, end, revert) => void resizeEntry(e, start, end, revert, onQuick)}
                onExternalDrop={(payload, start, end, allDay) => void dropExternal(payload, start, end, allDay, onQuick)}
                onEntryClick={(e) => {
                  if (e.kind === 'event' || e.kind === 'commitment' || e.kind === 'work_block' || e.kind === 'session') {
                    const { o } = e.data as { o: { id: string; occurrence_start_utc: string } }
                    onSelect({ kind: 'event', id: o.id, occurrenceStartUtc: o.occurrence_start_utc })
                  } else if (e.kind === 'happening') onSelect({ kind: 'happening', id: (e.data as { id: string }).id })
                }}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, empty, hint, children, ulRef }: { title: string; count: number; empty: string; hint?: string; children: React.ReactNode; ulRef?: React.RefObject<HTMLUListElement | null> }): React.JSX.Element {
  return (
    <section className="rounded-2xl bg-white/50 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 flex items-baseline gap-2">
        {title} <span className="text-stone-400">({count})</span>
        {hint && <span className="normal-case font-normal text-[10px] text-stone-400 ml-auto">{hint}</span>}
      </h3>
      <ul ref={ulRef} className="mt-1.5 flex flex-col gap-0.5">{count ? children : <li className="text-sm text-stone-400 px-1">{empty}</li>}</ul>
    </section>
  )
}

function PriorityRow({ p, onOpen, onDone, active }: { p: PriorityEntry; onOpen: (i: Item) => void; onDone: () => void; active?: boolean }): React.JSX.Element {
  return (
    <li className={`group text-sm flex items-start gap-2 rounded-lg px-1 py-1 cursor-pointer ${active ? 'bg-white ring-1 ring-[#3A2E28]/30' : 'hover:bg-white/80'}`} onClick={() => onOpen(p.item)}>
      <TypeGlyph item={p.item} overdue={p.overdue} />
      <div className="min-w-0 flex-1">
        <div className={`break-words leading-snug ${titleClass(p.item)}`}>{p.item.title}</div>
        <div className="mt-0.5 flex items-center gap-1 flex-wrap">
          <Marks item={p.item} overdue={p.overdue} />
          <span className="text-[10px] text-stone-500">
            {p.overdue && p.item.due_at_utc ? `was due ${formatDue(p.item.due_at_utc, p.item.due_precision)}` : p.reasons.filter((r) => !['overdue', 'critical', 'high importance', 'hard deadline'].includes(r) && !r.startsWith('promised')).join(' · ')}
            {p.blocked ? ' · blocked' : ''}
          </span>
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

function ItemRow({ item, onOpen, onDone, active, draggable }: { item: Item; onOpen: (i: Item) => void; onDone: () => void; active?: boolean; draggable?: boolean }): React.JSX.Element {
  return (
    <li
      className={`group text-sm flex items-start gap-2 rounded-lg px-1 py-1 ${draggable ? 'cursor-grab active:cursor-grabbing select-none' : 'cursor-pointer'} ${active ? 'bg-white ring-1 ring-[#3A2E28]/30' : 'hover:bg-white/80'}`}
      onClick={() => onOpen(item)}
      {...(draggable ? { 'data-item-id': item.id, 'data-title': item.title } : {})}
      title={draggable ? 'Drag onto the schedule to set time aside' : undefined}
    >
      <TypeGlyph item={item} />
      <div className="min-w-0 flex-1">
        <div className={`break-words leading-snug ${titleClass(item)}`}>{item.title}</div>
        <div className="mt-0.5">
          <Marks item={item} />
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
  const glyph = entry.kind === 'constraint' ? '' : entry.kind === 'due' || entry.kind === 'reminder' ? TYPE[entry.kind === 'due' ? 'task' : 'reminder'].glyph : TYPE[entry.kind].glyph
  return (
    <div className="px-1 leading-tight overflow-hidden">
      <div className="text-[11px] opacity-80 tabular-nums">{entry.allDay ? '' : `${clock(entry.startUtc)}${entry.endUtc ? `–${clock(entry.endUtc)}` : ''}`}</div>
      <div className="text-xs font-medium truncate">
        {glyph} {entry.title}
      </div>
    </div>
  )
}
