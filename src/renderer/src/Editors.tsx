import { useState } from 'react'
import type { Item, ItemKind, ItemStatus, Reminder, ToolRunResult } from '../../shared/types'
import { formatClock } from '../../shared/format'

/**
 * Manual editing surfaces (spec §7). Every control here runs a tool through window.api.runTool —
 * the same validated, transactional, activity-recorded path the assistant uses (hard rule 3).
 * There is deliberately no importance/priority control: priority is inferred, never asked (§4).
 */

export type RunTool = (name: string, args: Record<string, unknown>) => Promise<ToolRunResult>

const pad = (n: number): string => String(n).padStart(2, '0')
const toLocalDate = (utc: string): string => {
  const d = new Date(utc)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const toLocalClock = (utc: string): string => {
  const d = new Date(utc)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const KINDS: ItemKind[] = ['task', 'deadline', 'project', 'waiting', 'note', 'commitment', 'idea', 'checklist_item']
const STATUSES: ItemStatus[] = ['open', 'in_progress', 'blocked', 'waiting']

const RECURRENCE: { label: string; rrule: string | null }[] = [
  { label: 'Does not repeat', rrule: null },
  { label: 'Every day', rrule: 'FREQ=DAILY' },
  { label: 'Weekdays', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Every week', rrule: 'FREQ=WEEKLY' },
  { label: 'Every month', rrule: 'FREQ=MONTHLY' }
]

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#3A2E28]/30" onMouseDown={onClose}>
      <div className="w-[520px] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-3xl bg-[#FAF6F0] shadow-xl p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-800 text-sm">
            close
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const field = 'w-full rounded-xl bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#B5836D]/40'
const label = 'text-xs text-stone-500 mb-1 block'
const btn = 'rounded-xl px-3 py-1.5 text-sm'
const primary = `${btn} bg-[#3A2E28] text-[#FAF6F0] disabled:opacity-40`
const quiet = `${btn} bg-[#B5836D]/15 hover:bg-[#B5836D]/30 text-[#3A2E28]`
const danger = `${btn} text-red-800 hover:bg-red-50`

interface EditorProps<T> {
  target: T
  reminders: Reminder[]
  runTool: RunTool
  onDone: (message: string) => void
  onClose: () => void
  onOpenReminder: (r: Reminder) => void
}

export function ItemEditor({
  target: item,
  reminders,
  projects,
  parentId,
  runTool,
  onDone,
  onClose,
  onOpenReminder
}: EditorProps<Item> & { projects: Item[]; parentId: string | null }): React.JSX.Element {
  const [parent, setParent] = useState<string>(parentId ?? '')
  const [title, setTitle] = useState(item.title)
  const [details, setDetails] = useState(item.details ?? '')
  const [kind, setKind] = useState<ItemKind>(item.kind)
  const [status, setStatus] = useState<ItemStatus>(item.status)
  const [date, setDate] = useState(item.due_at_utc ? toLocalDate(item.due_at_utc) : '')
  const [clock, setClock] = useState(item.due_at_utc && item.due_precision === 'exact' ? toLocalClock(item.due_at_utc) : '')
  const [looseness, setLooseness] = useState<'day' | 'week' | 'vague'>(item.due_precision === 'week' || item.due_precision === 'vague' ? item.due_precision : 'day')
  const [hardness, setHardness] = useState<'hard' | 'soft' | ''>(item.hardness ?? '')
  const [remDate, setRemDate] = useState('')
  const [remClock, setRemClock] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const mine = reminders.filter((r) => r.target_type === 'item' && r.target_id === item.id && r.state !== 'cancelled')

  const run = async (name: string, args: Record<string, unknown>, ok: string): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      let res = await runTool(name, args)
      if (res.confirm) {
        if (!window.confirm(res.confirm.question)) return
        res = await runTool(name, { ...args, confirmed: true })
      }
      if (res.error) setErr(res.error)
      else {
        onDone(res.applied.map((a) => a.phrase).join(' ') || ok)
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    // Project membership goes through its own tools (attach/detach), then the field edits.
    const parentChanged = (parent || null) !== (parentId || null)
    const membership = async (): Promise<void> => {
      if (!parentChanged) return
      const res = parent
        ? await runTool('attach_to_project', { item_id: item.id, project_id: parent })
        : await runTool('detach_from_project', { item_id: item.id })
      if (res.error) throw new Error(res.error)
    }
    const args: Record<string, unknown> = { id: item.id }
    if (title.trim() !== item.title) args.title = title.trim()
    if ((details || null) !== (item.details || null)) args.details = details || null
    if (kind !== item.kind) args.kind = kind
    if (status !== item.status && status !== 'done' && status !== 'cancelled') args.status = status
    if ((hardness || null) !== (item.hardness || null) && hardness) args.hardness = hardness
    const hadDue = !!item.due_at_utc
    if (!date && hadDue) args.clear_due = true
    else if (date) {
      const newLocal = clock ? `${date}T${clock}` : date
      const oldLocal = item.due_at_utc ? (item.due_precision === 'exact' ? `${toLocalDate(item.due_at_utc)}T${toLocalClock(item.due_at_utc)}` : toLocalDate(item.due_at_utc)) : ''
      const oldLoose = item.due_precision === 'week' || item.due_precision === 'vague' ? item.due_precision : 'day'
      if (newLocal !== oldLocal || (!clock && looseness !== oldLoose)) {
        if (clock) args.due_at_local = newLocal
        else {
          args.due_date_local = date
          if (looseness !== 'day') args.due_looseness = looseness
        }
      }
    }
    if (Object.keys(args).length === 1) {
      if (!parentChanged) {
        onClose()
        return
      }
      setBusy(true)
      membership()
        .then(() => {
          onDone(parent ? 'Moved into the Thing.' : 'Taken out of the Thing.')
          onClose()
        })
        .catch((e) => setErr((e as Error).message))
        .finally(() => setBusy(false))
      return
    }
    membership()
      .then(() => run('update_item', args, 'Saved.'))
      .catch((e) => setErr((e as Error).message))
  }

  return (
    <Modal title={item.kind === 'project' ? 'Edit Thing' : 'Edit item'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <span className={label}>Title</span>
          <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <span className={label}>Details</span>
          <textarea className={field} rows={2} value={details} onChange={(e) => setDetails(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Kind</span>
            <select className={field} value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className={label}>Status</span>
            <select className={field} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)} disabled={item.status === 'done' || item.status === 'cancelled'}>
              {(item.status === 'done' || item.status === 'cancelled' ? [item.status] : STATUSES).map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-3">
          <div>
            <span className={label}>Due day</span>
            <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <span className={label}>Time (optional)</span>
            <input type="time" className={field} value={clock} onChange={(e) => setClock(e.target.value)} disabled={!date} />
          </div>
          <div>
            <span className={label}>{clock ? 'Precision' : 'How firm is the day?'}</span>
            {clock ? (
              <div className="text-sm px-1 py-2 text-stone-500">exact</div>
            ) : (
              <select className={field} value={looseness} onChange={(e) => setLooseness(e.target.value as never)} disabled={!date}>
                <option value="day">that day</option>
                <option value="week">that week</option>
                <option value="vague">roughly then</option>
              </select>
            )}
          </div>
        </div>
        {item.kind !== 'project' && projects.length > 0 && (
          <div>
            <span className={label}>Part of</span>
            <select className={field} value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">not part of a Thing</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <span className={label}>Deadline or target?</span>
          <div className="flex gap-2">
            {(['hard', 'soft'] as const).map((h) => (
              <button key={h} type="button" onClick={() => setHardness(hardness === h ? '' : h)} className={`${btn} ${hardness === h ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'bg-white'}`}>
                {h === 'hard' ? 'hard deadline' : 'soft target'}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white/70 p-3">
          <span className={label}>Reminders</span>
          {mine.length === 0 && <p className="text-sm text-stone-400">None.</p>}
          {mine.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-sm py-1">
              <span className="text-xs rounded-full px-2 bg-stone-100 text-stone-600">{r.state}</span>
              <span className="flex-1">{formatClock(r.fire_at_utc)}{r.rrule ? ' · repeats' : ''}</span>
              <button className="text-xs text-stone-500 hover:text-stone-800" onClick={() => onOpenReminder(r)}>
                edit
              </button>
            </div>
          ))}
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <span className={label}>Add one</span>
              <input type="date" className={field} value={remDate} onChange={(e) => setRemDate(e.target.value)} />
            </div>
            <input type="time" className={`${field} w-28`} value={remClock} onChange={(e) => setRemClock(e.target.value)} />
            <button
              disabled={!remDate || busy}
              className={quiet}
              onClick={() =>
                run('create_reminder', remClock ? { item_id: item.id, fire_at_local: `${remDate}T${remClock}` } : { item_id: item.id, fire_date_local: remDate }, 'Reminder added.')
              }
            >
              Add
            </button>
          </div>
        </div>

        {err && <p className="text-sm text-red-700">{err}</p>}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button disabled={busy || !title.trim()} className={primary} onClick={save}>
            Save
          </button>
          {item.status !== 'done' && item.status !== 'cancelled' && (
            <>
              <button disabled={busy} className={quiet} onClick={() => run('complete_item', { id: item.id }, 'Done.')}>
                ✓ Done
              </button>
              <button disabled={busy} className={quiet} onClick={() => run('cancel_item', { id: item.id }, 'Cancelled.')}>
                Cancel item
              </button>
            </>
          )}
          <span className="flex-1" />
          <button disabled={busy} className={danger} onClick={() => run('delete_item', { id: item.id }, 'Deleted.')}>
            Delete…
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function ReminderEditor({ target: r, runTool, onDone, onClose }: Omit<EditorProps<Reminder>, 'reminders' | 'onOpenReminder'>): React.JSX.Element {
  const [date, setDate] = useState(toLocalDate(r.fire_at_utc))
  const [clock, setClock] = useState(toLocalClock(r.fire_at_utc))
  const preset = RECURRENCE.find((x) => x.rrule === r.rrule)
  const [recur, setRecur] = useState<string>(preset ? preset.label : r.rrule ? 'custom' : RECURRENCE[0].label)
  const [custom, setCustom] = useState(r.rrule ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const live = r.state === 'pending' || r.state === 'snoozed' || r.state === 'paused'

  const run = async (name: string, args: Record<string, unknown>, ok: string): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const res = await runTool(name, args)
      if (res.error) setErr(res.error)
      else {
        onDone(res.applied.map((a) => a.phrase).join(' ') || ok)
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    const args: Record<string, unknown> = { id: r.id }
    const newLocal = `${date}T${clock}`
    if (newLocal !== `${toLocalDate(r.fire_at_utc)}T${toLocalClock(r.fire_at_utc)}`) args.fire_at_local = newLocal
    const rr = recur === 'custom' ? custom.trim() || null : RECURRENCE.find((x) => x.label === recur)?.rrule ?? null
    if (rr !== (r.rrule ?? null)) args.rrule = rr
    if (Object.keys(args).length === 1) {
      onClose()
      return
    }
    void run('update_reminder', args, 'Saved.')
  }

  return (
    <Modal title={`Reminder · ${r.item_title ?? ''}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-stone-500">
          State: <span className="rounded-full px-2 bg-stone-100 text-stone-700">{r.state}</span>
          {r.delivered_at && <span className="ml-2">delivered {formatClock(r.delivered_at)}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>Day</span>
            <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <span className={label}>Time</span>
            <input type="time" className={field} value={clock} onChange={(e) => setClock(e.target.value)} />
          </div>
        </div>
        <div>
          <span className={label}>Repeat</span>
          <select className={field} value={recur} onChange={(e) => setRecur(e.target.value)}>
            {RECURRENCE.map((x) => (
              <option key={x.label} value={x.label}>
                {x.label}
              </option>
            ))}
            <option value="custom">Custom rule…</option>
          </select>
          {recur === 'custom' && (
            <input className={`${field} mt-2 font-mono text-xs`} placeholder="FREQ=WEEKLY;BYDAY=SU" value={custom} onChange={(e) => setCustom(e.target.value)} />
          )}
        </div>
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button disabled={busy || r.state === 'cancelled'} className={primary} onClick={save}>
            Save
          </button>
          {r.state === 'delivered' || r.state === 'acknowledged' ? (
            <>
              <button disabled={busy} className={quiet} onClick={() => run('snooze_reminder', { id: r.id, minutes: 15 }, 'Snoozed.')}>
                ↻ 15 min
              </button>
              <button disabled={busy} className={quiet} onClick={() => run('snooze_reminder', { id: r.id, minutes: 60 }, 'Snoozed.')}>
                ↻ 1 h
              </button>
            </>
          ) : null}
          {live && (
            <button disabled={busy} className={quiet} onClick={() => run('pause_reminder', { id: r.id, resume: r.state === 'paused' }, r.state === 'paused' ? 'Resumed.' : 'Paused.')}>
              {r.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <span className="flex-1" />
          {r.state !== 'cancelled' && (
            <button disabled={busy} className={danger} onClick={() => run('cancel_reminder', { id: r.id }, 'Reminder cancelled.')}>
              Cancel reminder
            </button>
          )}
        </div>
        <p className="text-xs text-stone-400">Cancelling a reminder never touches the item it belongs to.</p>
      </div>
    </Modal>
  )
}
