import { useEffect, useState } from 'react'
import type { DayBundle, EventOccurrence, Item, Reminder } from '../../../shared/types'
import { formatDue } from '../../../shared/format'
import type { Selection } from './selection'
import { IMPORTANCE as IMP, TYPE, grammarOf, importanceOf } from './grammar'
import { describeRRule } from '../../../core/recurrence'
import type { Activity, PlanView } from '../../../shared/types'

/**
 * Day detail panel (spec §8 6b): the complete context for the selected date, directly editable — complete, reschedule,
 * cancel, snooze, add a note, change importance — every action through the same tool layer the assistant uses, so each
 * one lands in `activities` like any other change. Functional architecture, not decoration: nothing here is a dead end.
 *
 * The selected thing (item, event, reminder) is expanded at the top with its editors; the rest of the day sits below as
 * compact rows that can be selected in turn. "Open the full editor" hands off to the existing ItemEditor for fields this
 * panel does not carry (title, details, kind, recurrence…).
 */

interface Props {
  day: DayBundle
  selection: Selection
  onSelect: (s: Selection) => void
  onQuick: (tool: string, args: Record<string, unknown>) => Promise<void>
  onOpenEditor: (item: Item) => void
  onClose: () => void
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
const toLocalDate = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const toLocalClock = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const addDays = (d: string, n: number): string => {
  const [y, m, dd] = d.split('-').map(Number)
  const dt = new Date(y, m - 1, dd + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

const btn = 'rounded-lg px-2.5 py-1 text-xs bg-white/80 hover:bg-white text-stone-700 disabled:opacity-40'
const btnDark = 'rounded-lg px-2.5 py-1 text-xs bg-cocoa text-cream hover:opacity-90 disabled:opacity-40'
const field = 'rounded-lg bg-white/80 px-2 py-1 text-xs text-stone-800 outline-none focus:bg-white'
const IMPORTANCE: { v: number; label: string; glyph: string }[] = [
  { v: 0, label: 'critical', glyph: '‼' },
  { v: 1, label: 'high', glyph: '!' },
  { v: 2, label: 'normal', glyph: '•' },
  { v: 3, label: 'low', glyph: '·' }
]

export function DayPanel({ day, selection, onSelect, onQuick, onOpenEditor, onClose }: Props): React.JSX.Element {
  const allItems: Item[] = [...day.priorities.map((p) => p.item), ...day.unscheduled, ...day.overdue, ...day.completed, ...day.waiting]
  const selectedItem = selection.kind === 'item' ? allItems.find((i) => i.id === selection.id) ?? null : null
  const selectedEvent = selection.kind === 'event' ? day.scheduled.find((o) => o.id === selection.id && o.occurrence_start_utc === selection.occurrenceStartUtc) ?? null : null
  const selectedReminder = selection.kind === 'reminder' ? day.reminders.find((r) => r.id === selection.id) ?? null : null
  const long = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <aside className="flex flex-col min-h-0 h-full rounded-3xl bg-paper-2/70 p-4 gap-3 overflow-hidden">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-stone-500">Day panel</div>
          <div className="font-medium leading-snug">{long}</div>
          {day.summary.status && (
            <div className="text-xs text-stone-500 mt-0.5">
              {day.summary.priorities} pressing · {day.summary.due} due · {day.summary.scheduled} scheduled · {day.summary.reminders} reminder{day.summary.reminders === 1 ? '' : 's'}
              {day.summary.overdue ? ` · ${day.summary.overdue} overdue` : ''}
            </div>
          )}
        </div>
        <button className="text-stone-400 hover:text-stone-700 text-lg leading-none" onClick={onClose} title="Close the panel">
          ×
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
        {/* the selected thing, editable */}
        {selectedItem && <ItemDetail item={selectedItem} day={day} onQuick={onQuick} onOpenEditor={onOpenEditor} />}
        {selectedEvent && <EventDetail occ={selectedEvent} day={day} onQuick={onQuick} />}
        {selectedReminder && <ReminderDetail r={selectedReminder} onQuick={onQuick} />}
        {/* what changed and when (6e): every manual or spoken change landed in activities */}
        {selectedItem && <Changes targetType="item" id={selectedItem.id} />}
        {selectedEvent && <Changes targetType="event" id={selectedEvent.id} />}
        {selectedReminder && <Changes targetType="reminder" id={selectedReminder.id} />}

        {/* the date itself: a note on the day */}
        <DateNote date={day.date} onQuick={onQuick} />

        {/* the rest of the day, selectable */}
        <Group title="Priorities" count={day.priorities.length}>
          {day.priorities.map((p) => (
            <Row key={p.item.id} active={selection.kind === 'item' && selection.id === p.item.id} glyph={p.overdue ? '⚠' : TYPE[grammarOf(p.item)].glyph} title={p.item.title} sub={p.overdue && p.item.due_at_utc ? `was due ${formatDue(p.item.due_at_utc, p.item.due_precision)}` : p.reasons.join(' · ')} onClick={() => onSelect({ kind: 'item', id: p.item.id })} onDone={() => void onQuick('complete_item', { id: p.item.id })} />
          ))}
        </Group>
        <Group title="Due today" count={day.unscheduled.length}>
          {day.unscheduled.map((i) => (
            <Row key={i.id} active={selection.kind === 'item' && selection.id === i.id} glyph={TYPE[grammarOf(i)].glyph} title={i.title} sub={`${IMP[importanceOf(i)].word}${i.hardness === 'hard' || i.kind === 'deadline' ? ' · hard deadline' : ''}${i.kind === 'commitment' ? ` · promised to ${i.committed_to ?? 'someone'}` : ''}`} onClick={() => onSelect({ kind: 'item', id: i.id })} onDone={() => void onQuick('complete_item', { id: i.id })} />
          ))}
        </Group>
        <Group title="Schedule" count={day.scheduled.length}>
          {day.scheduled.map((o) => (
            <Row key={`${o.id}:${o.occurrence_start_utc}`} active={selection.kind === 'event' && selection.id === o.id && selection.occurrenceStartUtc === o.occurrence_start_utc} glyph={TYPE[o.kind ?? 'event'].glyph} title={o.title} sub={o.all_day ? (o.span === 'single' ? 'all day' : o.span) : `${clock(o.occurrence_start_utc)}${o.occurrence_end_utc ? `–${clock(o.occurrence_end_utc)}` : ''}${o.is_recurring_instance ? ' · series' : ''}`} onClick={() => onSelect({ kind: 'event', id: o.id, occurrenceStartUtc: o.occurrence_start_utc })} />
          ))}
        </Group>
        <Group title="Reminders" count={day.reminders.length}>
          {day.reminders.map((r) => (
            <Row key={r.id} active={selection.kind === 'reminder' && selection.id === r.id} glyph="🔔" title={r.item_title ?? 'Reminder'} sub={`${clock(r.fire_at_utc)}${r.state !== 'pending' ? ` · ${r.state}` : ''}`} onClick={() => onSelect({ kind: 'reminder', id: r.id })} />
          ))}
        </Group>
        <Group title="Notes" count={day.notes.length}>
          {day.notes.map((n) => (
            <li key={n.note.id} className="text-xs px-1 py-0.5 flex gap-2 text-stone-700">
              <span>📝</span>
              <span>
                {n.note.body}
                {n.on_kind !== 'date' && <span className="text-stone-400"> · on {n.on}</span>}
              </span>
            </li>
          ))}
        </Group>
        <Group title="Completed" count={day.completed.length}>
          {day.completed.map((i) => (
            <Row key={i.id} active={selection.kind === 'item' && selection.id === i.id} glyph="✓" title={i.title} sub={i.status === 'done' ? 'done' : 'dropped'} muted onClick={() => onSelect({ kind: 'item', id: i.id })} />
          ))}
        </Group>
      </div>
    </aside>
  )
}

/* ---------- the selected item: complete · reschedule · snooze a day · cancel · importance · note · full editor ---------- */

function ItemDetail({ item, day, onQuick, onOpenEditor }: { item: Item; day: DayBundle; onQuick: Props['onQuick']; onOpenEditor: (i: Item) => void }): React.JSX.Element {
  const [date, setDate] = useState(item.due_at_utc ? toLocalDate(item.due_at_utc) : day.date)
  const [time, setTime] = useState(item.due_at_utc && item.due_precision === 'exact' ? toLocalClock(item.due_at_utc) : '')
  const [note, setNote] = useState('')
  useEffect(() => {
    setDate(item.due_at_utc ? toLocalDate(item.due_at_utc) : day.date)
    setTime(item.due_at_utc && item.due_precision === 'exact' ? toLocalClock(item.due_at_utc) : '')
    setNote('')
  }, [item.id, item.due_at_utc, item.due_precision, day.date])
  const open = item.status === 'open' || item.status === 'in_progress'
  const currentDate = item.due_at_utc ? toLocalDate(item.due_at_utc) : ''
  const currentTime = item.due_at_utc && item.due_precision === 'exact' ? toLocalClock(item.due_at_utc) : ''
  const changed = date !== currentDate || time !== currentTime
  const reschedule = (): void => {
    if (!date) return
    void onQuick('update_item', time ? { id: item.id, due_at_local: `${date}T${time}` } : { id: item.id, due_date_local: date })
  }
  return (
    <section className="rounded-2xl bg-white/70 p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-stone-400">{item.kind === 'commitment' ? `commitment · to ${item.committed_to ?? 'someone'}` : item.kind}{item.hardness === 'hard' ? ' · hard deadline' : ''}</div>
          <div className="font-medium leading-snug break-words">{item.title}</div>
          <div className="text-xs text-stone-500">{item.due_at_utc ? `due ${formatDue(item.due_at_utc, item.due_precision)}` : 'no date'}{item.status !== 'open' ? ` · ${item.status}` : ''}</div>
        </div>
      </div>
      {open && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <button className={btnDark} onClick={() => void onQuick('complete_item', { id: item.id })}>
              ✓ Done
            </button>
            <button className={btn} title="Move to tomorrow" onClick={() => void onQuick('update_item', { id: item.id, due_date_local: addDays(day.date, 1) })}>
              ↻ Tomorrow
            </button>
            <button className={btn} title="Cancel this — it stays in history" onClick={() => void onQuick('cancel_item', { id: item.id })}>
              Cancel
            </button>
            <button className={btn} onClick={() => onOpenEditor(item)} title="Every field, in the full editor">
              Full editor…
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-stone-500 w-16">Reschedule</span>
            <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" className={field} value={time} onChange={(e) => setTime(e.target.value)} placeholder="no time" />
            <button className={btn} disabled={!changed || !date} onClick={reschedule}>
              Move
            </button>
            {time && (
              <button className={btn} title="Keep the day, drop the clock time" onClick={() => setTime('')}>
                no time
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-stone-500 w-16">Importance</span>
            {IMPORTANCE.map((x) => (
              <button key={x.v} className={`${btn} ${(item.importance ?? 2) === x.v ? 'ring-1 ring-cocoa bg-white' : ''}`} onClick={() => void onQuick('update_item', { id: item.id, importance: x.v })} title={x.label}>
                {x.glyph} {x.label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="flex items-center gap-1.5">
        <input className={`${field} flex-1`} placeholder="Add a note to this…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && (void onQuick('add_note', { item_id: item.id, body: note.trim() }), setNote(''))} />
        <button className={btn} disabled={!note.trim()} onClick={() => (void onQuick('add_note', { item_id: item.id, body: note.trim() }), setNote(''))}>
          Note
        </button>
      </div>
    </section>
  )
}

/* ---------- the selected event: move (start/end) · rename · cancel or skip this occurrence · note ---------- */

function EventDetail({ occ, day, onQuick }: { occ: EventOccurrence; day: DayBundle; onQuick: Props['onQuick'] }): React.JSX.Element {
  const [date, setDate] = useState(toLocalDate(occ.occurrence_start_utc))
  const [start, setStart] = useState(toLocalClock(occ.occurrence_start_utc))
  const [end, setEnd] = useState(occ.occurrence_end_utc ? toLocalClock(occ.occurrence_end_utc) : '')
  const [title, setTitle] = useState(occ.title)
  const [note, setNote] = useState('')
  useEffect(() => {
    setDate(toLocalDate(occ.occurrence_start_utc))
    setStart(toLocalClock(occ.occurrence_start_utc))
    setEnd(occ.occurrence_end_utc ? toLocalClock(occ.occurrence_end_utc) : '')
    setTitle(occ.title)
    setNote('')
  }, [occ.id, occ.occurrence_start_utc, occ.occurrence_end_utc, occ.title])
  const occurrenceArg = occ.is_recurring_instance ? { occurrence_start_local: `${toLocalDate(occ.occurrence_start_utc)}T${toLocalClock(occ.occurrence_start_utc)}` } : {}
  const timeChanged = date !== toLocalDate(occ.occurrence_start_utc) || start !== toLocalClock(occ.occurrence_start_utc) || end !== (occ.occurrence_end_utc ? toLocalClock(occ.occurrence_end_utc) : '')
  const move = (): void => {
    if (occ.all_day) {
      void onQuick('update_event', { id: occ.id, date_local: date, ...occurrenceArg })
      return
    }
    void onQuick('update_event', { id: occ.id, starts_at_local: `${date}T${start}`, ...(end ? { ends_at_local: `${date}T${end}` } : {}), ...occurrenceArg })
  }
  return (
    <section className="rounded-2xl bg-white/70 p-3 flex flex-col gap-2">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-stone-400">
          {occ.kind === 'commitment' ? 'appointment' : occ.kind === 'work_block' ? 'work block' : occ.kind === 'session' ? 'session' : 'event'}
          {occ.is_recurring_instance ? ' · one occurrence of a series' : ''}
          {occ.span !== 'single' ? ` · ${occ.span} today` : ''}
        </div>
        {occ.rrule && (
          <div className="text-[11px] text-stone-500 mt-0.5" title="The series rule, in plain words. Change it from the conversation, e.g. make the class every Wednesday instead.">
            ↻ repeats {describeRRule(occ.rrule)}
            {occ.exdates && JSON.parse(occ.exdates).length ? ` · ${(JSON.parse(occ.exdates) as string[]).length} occurrence${(JSON.parse(occ.exdates) as string[]).length === 1 ? '' : 's'} changed or skipped` : ''}
          </div>
        )}
        <input className={`${field} w-full font-medium text-sm mt-0.5`} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== occ.title && void onQuick('update_event', { id: occ.id, title: title.trim() })} />
        <div className="text-xs text-stone-500 mt-0.5">{occ.all_day ? 'all day' : `${clock(occ.occurrence_start_utc)}${occ.occurrence_end_utc ? `–${clock(occ.occurrence_end_utc)}` : ''}`}</div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-stone-500 w-16">Move</span>
        <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
        {!occ.all_day && (
          <>
            <input type="time" className={field} value={start} onChange={(e) => setStart(e.target.value)} />
            <span className="text-xs text-stone-400">–</span>
            <input type="time" className={field} value={end} onChange={(e) => setEnd(e.target.value)} />
          </>
        )}
        <button className={btn} disabled={!timeChanged} onClick={move}>
          {occ.is_recurring_instance ? 'Move this one' : 'Move'}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {occ.is_recurring_instance ? (
          <>
            <button className={btn} onClick={() => void onQuick('delete_event', { id: occ.id, ...occurrenceArg })} title="Skip only this occurrence; the series continues">
              Skip this one
            </button>
            <button className={btn} onClick={() => void onQuick('delete_event', { id: occ.id })}>
              Cancel series…
            </button>
          </>
        ) : (
          <button className={btn} onClick={() => void onQuick('delete_event', { id: occ.id })}>
            Cancel event
          </button>
        )}
        {occ.item_id && (
          <button className={btn} onClick={() => void onQuick('complete_item', { id: occ.item_id })} title="The task this time is set aside for">
            ✓ Task done
          </button>
        )}
        {occ.kind === 'session' && occ.session_state !== 'done' && (
          <button className={btnDark} onClick={() => void onQuick('mark_session', { id: occ.id, state: 'done' })} title="I did this session">
            ✓ Session done
          </button>
        )}
        {occ.kind === 'session' && occ.session_state !== 'missed' && (
          <button className={btn} onClick={() => void onQuick('mark_session', { id: occ.id, state: 'missed' })} title="Skip this session — the plan records it as missed and carries on">
            Skip session
          </button>
        )}
        {occ.kind === 'session' && (occ.session_state === 'done' || occ.session_state === 'missed') && (
          <button className={btn} onClick={() => void onQuick('mark_session', { id: occ.id, state: 'planned' })} title="Undo the mark">
            Back to planned
          </button>
        )}
      </div>
      {occ.kind === 'session' && occ.plan_id && <PlanProgress planId={occ.plan_id} sessionState={occ.session_state} />}
      <div className="flex items-center gap-1.5">
        <input className={`${field} flex-1`} placeholder="Add a note to this event…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && (void onQuick('add_note', { event_id: occ.id, body: note.trim() }), setNote(''))} />
        <button className={btn} disabled={!note.trim()} onClick={() => (void onQuick('add_note', { event_id: occ.id, body: note.trim() }), setNote(''))}>
          Note
        </button>
      </div>
      <div className="text-[10px] text-stone-400">{day.date === toLocalDate(occ.occurrence_start_utc) ? '' : 'Started on an earlier day.'}</div>
    </section>
  )
}

/* ---------- the selected reminder: snooze · move · cancel (the item stays) ---------- */

function ReminderDetail({ r, onQuick }: { r: Reminder; onQuick: Props['onQuick'] }): React.JSX.Element {
  const [date, setDate] = useState(toLocalDate(r.fire_at_utc))
  const [time, setTime] = useState(toLocalClock(r.fire_at_utc))
  useEffect(() => {
    setDate(toLocalDate(r.fire_at_utc))
    setTime(toLocalClock(r.fire_at_utc))
  }, [r.id, r.fire_at_utc])
  const live = r.state !== 'cancelled' && r.state !== 'acknowledged'
  const changed = date !== toLocalDate(r.fire_at_utc) || time !== toLocalClock(r.fire_at_utc)
  return (
    <section className="rounded-2xl bg-white/70 p-3 flex flex-col gap-2">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-stone-400">reminder · {r.state}{r.rrule ? ' · recurring' : ''}</div>
        <div className="font-medium leading-snug break-words">{r.item_title ?? 'Reminder'}</div>
        <div className="text-xs text-stone-500">fires {clock(r.fire_at_utc)}</div>
      </div>
      {live && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <button className={btn} onClick={() => void onQuick('snooze_reminder', { id: r.id, minutes: 15 })}>
              ↻ 15 min
            </button>
            <button className={btn} onClick={() => void onQuick('snooze_reminder', { id: r.id, minutes: 60 })}>
              ↻ 1 h
            </button>
            <button className={btn} onClick={() => void onQuick('snooze_reminder', { id: r.id, minutes: 24 * 60 })}>
              ↻ Tomorrow
            </button>
            <button className={btn} title="Cancel the alarm only — the task stays" onClick={() => void onQuick('cancel_reminder', { id: r.id })}>
              Cancel alarm
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-stone-500 w-16">Move</span>
            <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" className={field} value={time} onChange={(e) => setTime(e.target.value)} />
            <button className={btn} disabled={!changed} onClick={() => void onQuick('update_reminder', { id: r.id, fire_at_local: `${date}T${time}` })}>
              Move
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/* ---------- a note on the date itself ---------- */

function DateNote({ date, onQuick }: { date: string; onQuick: Props['onQuick'] }): React.JSX.Element {
  const [note, setNote] = useState('')
  const add = (): void => {
    if (!note.trim()) return
    void onQuick('add_note', { date_local: date, body: note.trim() })
    setNote('')
  }
  return (
    <div className="flex items-center gap-1.5">
      <input className={`${field} flex-1`} placeholder="Note for this day…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <button className={btn} disabled={!note.trim()} onClick={add}>
        Note
      </button>
    </div>
  )
}

/** The plan behind a session: hours done against target, sessions missed, what is left. Words and hours, never a bar or a score. */
function PlanProgress({ planId, sessionState }: { planId: string; sessionState: string | null }): React.JSX.Element | null {
  const [view, setView] = useState<PlanView | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.getPlanProgress(planId).then((v) => alive && setView(v)).catch(() => alive && setView(null))
    return () => {
      alive = false
    }
  }, [planId, sessionState])
  if (!view) return null
  const p = view.progress
  const hours = (min: number): string => `${Math.round(min / 6) / 10} h`
  return (
    <div className="rounded-xl bg-slate-soft/15 p-2 text-[11px] text-stone-700">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">📘 {view.plan.title}</span>
        <span className="text-stone-500">{view.plan.status !== 'active' ? view.plan.status : ''}</span>
      </div>
      <div className="mt-0.5">{view.description}.</div>
      <div className="mt-0.5 text-stone-500">
        {p.sessions.done} done · {p.sessions.planned} ahead · {p.sessions.missed} missed{p.moved ? ` · ${p.moved} moved` : ''}
        {p.target_minutes !== null ? ` · target ${hours(p.target_minutes)}` : ''}
        {view.plan.ends_on ? ` · until ${view.plan.ends_on}` : ''}
      </div>
    </div>
  )
}

/** What changed and when, for the selected thing — the activities log, which every manual and spoken change writes to. */
function Changes({ targetType, id }: { targetType: 'item' | 'event' | 'reminder'; id: string }): React.JSX.Element | null {
  const [rows, setRows] = useState<Activity[]>([])
  useEffect(() => {
    let alive = true
    void window.api.activitiesForTarget(targetType, id, 8).then((r) => alive && setRows(r))
    return () => {
      alive = false
    }
  }, [targetType, id])
  if (!rows.length) return null
  const when = (iso: string): string => {
    const d = new Date(iso)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return (
    <section className="rounded-2xl bg-white/50 p-2.5">
      <h4 className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">What changed</h4>
      <ul className="flex flex-col gap-0.5">
        {rows.map((a) => (
          <li key={a.id} className="text-[11px] text-stone-600 flex gap-2">
            <span className="text-stone-400 tabular-nums shrink-0 w-14">{when(a.created_at)}</span>
            <span className="break-words">
              {a.summary}
              <span className="text-stone-400"> · {a.actor === 'user' ? 'you' : a.actor === 'assistant' ? 'secretary' : 'system'}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }): React.JSX.Element | null {
  if (!count) return null
  return (
    <section>
      <h4 className="text-[10px] uppercase tracking-wide text-stone-500 mb-1">
        {title} <span className="text-stone-400">({count})</span>
      </h4>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  )
}

function Row({ active, glyph, title, sub, muted, onClick, onDone }: { active: boolean; glyph: string; title: string; sub?: string; muted?: boolean; onClick: () => void; onDone?: () => void }): React.JSX.Element {
  return (
    <li className={`group text-xs flex items-start gap-2 rounded-lg px-1.5 py-1 cursor-pointer ${active ? 'bg-white ring-1 ring-cocoa/30' : 'hover:bg-white/70'} ${muted ? 'text-stone-400' : 'text-stone-800'}`} onClick={onClick}>
      <span className="w-4 text-center shrink-0">{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className={`break-words leading-snug ${muted ? 'line-through' : ''}`}>{title}</div>
        {sub && <div className="text-[10px] text-stone-500 break-words">{sub}</div>}
      </div>
      {onDone && (
        <button
          className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-emerald-700 px-1"
          title="Done"
          onClick={(e) => {
            e.stopPropagation()
            onDone()
          }}
        >
          ✓
        </button>
      )}
    </li>
  )
}
