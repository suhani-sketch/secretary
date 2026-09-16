import { useEffect, useState } from 'react'
import type { Activity, Item, Note, Reminder } from '../../shared/types'
import { formatClock, formatDue } from '../../shared/format'
import { Modal, type RunTool } from './Editors'

/**
 * Activity history in the UI (spec §8 3e). The timeline is read from `activities`, never from the model.
 * ProjectView: one Thing — its parts, waits, notes, and everything that happened to it, grouped by day.
 * ItemHistory: the same for a single item.
 */

const dayLabel = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

const actorStyle: Record<string, string> = {
  user: 'bg-emerald-100 text-emerald-900',
  assistant: 'bg-accent/25 text-cocoa',
  system: 'bg-stone-200 text-stone-600'
}
const verbIcon: Record<string, string> = {
  created: '＋',
  completed: '✓',
  cancelled: '×',
  deleted: '🗑',
  rescheduled: '↻',
  status_changed: '→',
  updated: '✎',
  note_added: '📝',
  reminder_fired: '🔔',
  reminder_missed: '⚠️',
  dismissed: '–',
  snoozed: '⏲',
  undone: '↶',
  delivery_failed: '‼'
}

export function Timeline({ activities, hideSystem }: { activities: Activity[]; hideSystem: boolean }): React.JSX.Element {
  const rows = hideSystem ? activities.filter((a) => a.actor !== 'system') : activities
  if (rows.length === 0) return <p className="text-sm text-stone-400">Nothing recorded yet.</p>
  const groups: { day: string; rows: Activity[] }[] = []
  for (const a of rows) {
    const day = dayLabel(a.created_at)
    const g = groups[groups.length - 1]
    if (g && g.day === day) g.rows.push(a)
    else groups.push({ day, rows: [a] })
  }
  return (
    <ol className="flex flex-col gap-3">
      {groups.map((g) => (
        <li key={g.day}>
          <div className="text-[11px] uppercase tracking-wide text-stone-500 mb-1">{g.day}</div>
          <ul className="flex flex-col gap-1 border-l-2 border-accent/30 pl-3">
            {g.rows.map((a) => (
              <li key={a.id} className={`text-sm flex items-start gap-2 ${a.reversible ? '' : 'text-stone-500'}`}>
                <span className="w-4 text-center shrink-0" title={a.verb}>
                  {verbIcon[a.verb] ?? '•'}
                </span>
                <span className="text-xs text-stone-400 w-11 shrink-0">{clock(a.created_at)}</span>
                <span className={`rounded px-1 text-[10px] shrink-0 mt-0.5 ${actorStyle[a.actor] ?? ''}`}>{a.actor === 'assistant' ? 'secretary' : a.actor === 'user' ? 'you' : 'system'}</span>
                <span className="min-w-0">{a.summary}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}

interface ProjectViewProps {
  project: Item
  parts: Item[]
  notes: Note[]
  reminders: Reminder[]
  runTool: RunTool
  onOpenItem: (i: Item) => void
  onOpenReminder: (r: Reminder) => void
  onClose: () => void
  initialTab?: 'overview' | 'timeline'
}

export function ProjectView({ project, parts, notes, reminders, runTool, onOpenItem, onOpenReminder, onClose, initialTab }: ProjectViewProps): React.JSX.Element {
  const [activities, setActivities] = useState<Activity[] | null>(null)
  const [hideSystem, setHideSystem] = useState(false)
  const [tab, setTab] = useState<'overview' | 'timeline'>(initialTab ?? 'overview')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = (): void => {
    void window.api.activitiesForProject(project.id, 200).then(setActivities)
  }
  useEffect(load, [project.id, parts.length, notes.length])

  const live = (i: Item): boolean => !['done', 'cancelled', 'archived'].includes(i.status)
  const steps = parts.filter((p) => p.kind === 'checklist_item' && p.status !== 'cancelled').sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9))
  const waits = parts.filter((p) => p.kind === 'waiting' && live(p))
  const tasks = parts.filter((p) => p.kind !== 'checklist_item' && p.kind !== 'waiting' && p.status !== 'cancelled')
  const openCount = parts.filter(live).length
  const alarms = reminders.filter((r) => r.target_type === 'item' && (r.target_id === project.id || parts.some((p) => p.id === r.target_id)) && (r.state === 'pending' || r.state === 'snoozed'))

  const quick = async (name: string, args: Record<string, unknown>, id: string): Promise<void> => {
    setBusyId(id)
    await runTool(name, args)
    setBusyId(null)
    load()
  }

  return (
    <Modal title={project.title} onClose={onClose}>
      <div className="flex flex-col gap-3 -mt-2">
        <div className="text-xs text-stone-500 flex flex-wrap gap-x-3">
          <span className="rounded px-1 bg-accent/25 text-cocoa">thing</span>
          {project.due_at_utc && (
            <span>
              due {formatDue(project.due_at_utc, project.due_precision)}
              {project.hardness === 'hard' ? ' · hard deadline' : project.hardness === 'soft' ? ' · soft target' : ''}
            </span>
          )}
          <span>
            {openCount} open of {parts.filter((p) => p.status !== 'cancelled').length} parts
          </span>
          <button className="underline hover:text-stone-800" onClick={() => onOpenItem(project)}>
            edit
          </button>
        </div>
        <div className="flex gap-1">
          {(['overview', 'timeline'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-2.5 py-1 text-xs ${tab === t ? 'bg-cocoa text-cream' : 'bg-white/70 text-stone-600'}`}>
              {t === 'overview' ? 'Overview' : `Timeline${activities ? ` (${activities.length})` : ''}`}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="flex flex-col gap-3">
            <Section title={`Steps (${steps.filter(live).length} left)`} empty="No checklist yet — say “add a list” and name the steps.">
              {steps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <button
                    disabled={!live(s) || busyId === s.id}
                    className={`w-4 h-4 rounded border shrink-0 ${live(s) ? 'border-stone-400 hover:bg-emerald-100' : 'bg-emerald-200 border-emerald-300'}`}
                    title={live(s) ? 'Tick off' : 'Done'}
                    onClick={() => void quick('complete_checklist_item', { id: s.id }, s.id)}
                  />
                  <span className={`flex-1 cursor-pointer hover:underline ${live(s) ? '' : 'line-through text-stone-400'}`} onClick={() => onOpenItem(s)}>
                    {s.title}
                  </span>
                </li>
              ))}
            </Section>
            <Section title={`Tasks (${tasks.filter(live).length} open)`} empty="No tasks attached.">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <button disabled={!live(t) || busyId === t.id} className={`text-xs px-1 ${live(t) ? 'text-stone-500 hover:text-emerald-700' : 'text-emerald-600'}`} title="Done" onClick={() => void quick('complete_item', { id: t.id }, t.id)}>
                    ✓
                  </button>
                  <span className={`flex-1 cursor-pointer hover:underline ${live(t) ? '' : 'line-through text-stone-400'}`} onClick={() => onOpenItem(t)}>
                    {t.title}
                  </span>
                  {t.due_at_utc && <span className="text-xs text-stone-500">{formatDue(t.due_at_utc, t.due_precision)}</span>}
                </li>
              ))}
            </Section>
            <Section title={`Waiting on (${waits.length})`} empty="Not waiting on anyone.">
              {waits.map((w) => (
                <li key={w.id} className="flex items-center gap-2 text-sm">
                  <span className="text-xs">⏳</span>
                  <span className="flex-1 cursor-pointer hover:underline" onClick={() => onOpenItem(w)}>
                    {w.waiting_on}
                    {w.details ? <span className="text-stone-500"> · {w.details}</span> : null}
                  </span>
                  {w.due_at_utc && <span className="text-xs text-stone-500">expected {formatDue(w.due_at_utc, w.due_precision)}</span>}
                  <button className="text-xs text-stone-500 hover:text-emerald-700" disabled={busyId === w.id} onClick={() => void quick('resolve_waiting', { id: w.id, outcome: 'replied' }, w.id)}>
                    replied ✓
                  </button>
                </li>
              ))}
            </Section>
            <Section title={`Alarms (${alarms.length})`} empty="No alarms set.">
              {alarms.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-sm cursor-pointer hover:underline" onClick={() => onOpenReminder(r)}>
                  <span className="text-xs">🔔</span>
                  <span className="flex-1">{r.item_title}</span>
                  <span className="text-xs text-stone-500">
                    {formatClock(r.fire_at_utc)}
                    {r.rrule ? ' ↻' : ''}
                    {r.condition_json ? ' · unless resolved' : ''}
                  </span>
                </li>
              ))}
            </Section>
            <Section title={`Notes (${notes.length})`} empty="No notes.">
              {notes.map((n) => (
                <li key={n.id} className="text-sm flex items-start gap-2">
                  <span className="text-xs mt-0.5">📝</span>
                  <span className="whitespace-pre-wrap">{n.body}</span>
                </li>
              ))}
            </Section>
          </div>
        )}

        {tab === 'timeline' && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs text-stone-500 self-end cursor-pointer">
              <input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} /> hide alarms firing and other system entries
            </label>
            {activities === null ? <p className="text-sm text-stone-400">Loading…</p> : <Timeline activities={activities} hideSystem={hideSystem} />}
          </div>
        )}
      </div>
    </Modal>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }): React.JSX.Element {
  return (
    <section className="rounded-2xl bg-white/70 p-3">
      <div className="text-xs font-medium text-stone-600 mb-1">{title}</div>
      {children.length === 0 ? <p className="text-sm text-stone-400">{empty}</p> : <ul className="flex flex-col gap-1">{children}</ul>}
    </section>
  )
}

/** History of a single item, opened from its editor. */
export function ItemHistory({ item, onClose }: { item: Item; onClose: () => void }): React.JSX.Element {
  const [activities, setActivities] = useState<Activity[] | null>(null)
  useEffect(() => {
    void window.api.activitiesForItem(item.id, 100).then(setActivities)
  }, [item.id])
  return (
    <Modal title={`History · ${item.title}`} onClose={onClose}>
      {activities === null ? <p className="text-sm text-stone-400">Loading…</p> : <Timeline activities={activities} hideSystem={false} />}
    </Modal>
  )
}
