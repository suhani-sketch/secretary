import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Activity,
  AppInfo,
  AppliedChange,
  ChatMessage,
  ChatStatus,
  ExtractionEntry,
  Constraint,
  Item,
  Link,
  Note,
  Reminder,
  SchedulerLogEntry,
  ToolRunResult
} from '../../shared/types'
import { Room, type EnvironmentId, type TimeChoice } from './Room'
import { useCompanion, type CompanionState } from './companionState'
import { ItemEditor, NoteEditor, ReminderEditor } from './Editors'
import { ItemHistory, ProjectView } from './ProjectView'
import { formatClock, formatDue, isOverdue } from '../../shared/format'
import { RightNow } from './Happenings'
import type { Happening } from '../../shared/types'
import { CalendarSurface, type CalendarMode } from './calendar/CalendarSurface'

const fmtLocal = (utcIso: string | null): string => (utcIso ? formatClock(utcIso) : '—')

const fmtLogTime = (utcIso: string): string =>
  new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const levelColor: Record<string, string> = {
  info: 'text-stone-600',
  warn: 'text-amber-700 font-medium',
  error: 'text-red-700 font-semibold'
}

type Surface = 'conversation' | 'calendar' | 'things' | 'settings'
type UiMessage = ChatMessage & { applied?: AppliedChange[]; error?: string | null; pending?: boolean }
type Editing =
  | { kind: 'item'; item: Item }
  | { kind: 'reminder'; reminder: Reminder }
  | { kind: 'note'; note: Note }
  | { kind: 'project'; project: Item; tab?: 'overview' | 'timeline' }
  | { kind: 'history'; item: Item }
  | null

export default function App(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [constraints, setConstraints] = useState<Constraint[]>([])
  const [happenings, setHappenings] = useState<Happening[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [logs, setLogs] = useState<SchedulerLogEntry[]>([])
  const [aiCalls, setAiCalls] = useState<SchedulerLogEntry[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [extractions, setExtractions] = useState<ExtractionEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<ChatStatus>({ kind: 'idle' })
  const [showDebug, setShowDebug] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  // Calendar (Phase 6): a secondary view over the same records; conversation stays home.
  const [surface, setSurface] = useState<Surface>('conversation')
  const [calMode, setCalMode] = useState<CalendarMode>(() => {
    // Dev hook: "#calendar:2026-09-17,mode:week" opens the calendar in that mode.
    const m = /(?:^|,)mode:(month|week|day|agenda)/.exec(window.location.hash)?.[1]
    return (m as CalendarMode | undefined) ?? 'day'
  })
  const [calDate, setCalDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [refreshKey, setRefreshKey] = useState(0)
  // Week start (spec 6a): Monday by default, a setting, never hard-coded in views.
  const [weekStart, setWeekStart] = useState(1)
  useEffect(() => {
    void window.api.getSetting('calendar.weekStart').then((v) => v !== null && setWeekStart(Number(v)))
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- Companion signals (Phase 4): derived from what the app is really doing ----
  const [lastToolNames, setLastToolNames] = useState<string[]>([])
  const [lastAppliedAt, setLastAppliedAt] = useState(0)
  const [celebrateAt, setCelebrateAt] = useState(0)
  const [greetAt, setGreetAt] = useState(0)
  const [addressedAt, setAddressedAt] = useState(0)
  const [concernedAt, setConcernedAt] = useState(0)
  const [typingAt, setTypingAt] = useState(0)
  const [hour, setHour] = useState(new Date().getHours())
  const [environment, setEnvironment] = useState<EnvironmentId>('trees')
  const [timeChoice, setTimeChoice] = useState<TimeChoice>('auto')
  const prevOverdue = useRef<number | null>(null)
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    // First open of the day → greeting. Remembered per day in this browser profile only; nothing is scored.
    const today = new Date().toDateString()
    let last: string | null = null
    try {
      last = localStorage.getItem('companion.greeted')
    } catch {
      /* no storage */
    }
    if (last !== today) {
      setGreetAt(Date.now())
      try {
        localStorage.setItem('companion.greeted', today)
      } catch {
        /* ignore */
      }
    }
    void window.api.getSetting('scene.environment').then((v) => v && setEnvironment(v as EnvironmentId))
    void window.api.getSetting('scene.timeOfDay').then((v) => v && setTimeChoice(v as TimeChoice))
  }, [])
  // Dev hook: "#state:working,light:night,env:rain" forces creature state / light band / environment for screenshots.
  const hashParts = Object.fromEntries(window.location.hash.replace('#', '').split(',').map((p) => p.split(':') as [string, string]))
  const forcedState = (hashParts['state'] as CompanionState | undefined) ?? null
  useEffect(() => {
    if (hashParts['light']) setTimeChoice(hashParts['light'] as TimeChoice)
    if (hashParts['env']) setEnvironment(hashParts['env'] as EnvironmentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [i, r, l, a, x, ac, act, lk, nt, cs, hp] = await Promise.all([
        window.api.listItems(),
        window.api.listReminders(),
        window.api.listLog(50),
        window.api.getAppInfo(),
        window.api.listExtractions(20),
        window.api.listAiCalls(20),
        window.api.listActivities(40),
        window.api.listLinks(),
        window.api.listNotes(),
        window.api.listConstraints(),
        window.api.listHappenings()
      ])
      setItems(i)
      setLinks(lk)
      setNotes(nt)
      setConstraints(cs)
      setHappenings(hp)
      setReminders(r)
      setLogs(l)
      setInfo(a)
      setExtractions(x)
      setAiCalls(ac)
      setActivities(act)
      setRefreshKey((k) => k + 1)
    } catch (e) {
      setFlash((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.chatHistory(60).then((h) => setMessages(h))
    const offChanged = window.api.onChanged(() => void refresh())
    const offStatus = window.api.onChatStatus(setStatus)
    const offPrefill = window.api.onChatPrefill((text) => {
      setDraft(text)
      inputRef.current?.focus()
    })
    const t = setInterval(() => void refresh(), 10000)
    return () => {
      offChanged()
      offStatus()
      offPrefill()
      clearInterval(t)
    }
  }, [refresh])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, status])

  // Developer hook: "#project" / "#history" in the URL opens the first Thing's view / first item's history once loaded.
  const [autoOpened, setAutoOpened] = useState(false)
  useEffect(() => {
    if (autoOpened || !info) return
    const hash = window.location.hash.replace('#', '')
    const light = /^light:(\w+)$/.exec(hash)
    if (light) setTimeChoice(light[1] as TimeChoice)
    if (hash === 'calendar' || hash.startsWith('calendar:')) {
      setSurface('calendar')
      const d = /^calendar:(\d{4}-\d{2}-\d{2})/.exec(hash)
      if (d) setCalDate(d[1])
    } else if (hash === 'project' || hash === 'timeline') {
      const p = items.find((i) => i.kind === 'project' && i.status !== 'archived')
      if (p) setEditing({ kind: 'project', project: p, tab: hash === 'timeline' ? 'timeline' : 'overview' })
    } else if (hash === 'history') {
      setEditing({ kind: 'history', item: items[0] })
    }
    setAutoOpened(true)
  }, [items, info, autoOpened])

  const say = (msg: string): void => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 5000)
  }

  /** Manual edits use the same tool layer as the assistant. Notes appear in the conversation as system lines. */
  const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolRunResult> => {
    const res = await window.api.runTool(name, args)
    const history = await window.api.chatHistory(60)
    setMessages((m) => {
      const known = new Set(m.map((x) => x.id))
      return [...m, ...history.filter((h) => !known.has(h.id))]
    })
    void refresh()
    return res
  }

  const quick = async (name: string, args: Record<string, unknown>): Promise<void> => {
    let res = await runTool(name, args)
    if (res.confirm) {
      if (!window.confirm(res.confirm.question)) return
      res = await runTool(name, { ...args, confirmed: true })
    }
    say(res.error ? `Couldn't: ${res.error}` : res.applied.map((a) => a.phrase).join(' '))
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || status.kind !== 'idle') return
    setDraft('')
    const tempId = `tmp-${Date.now()}`
    setMessages((m) => [...m, { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString(), pending: true }])
    if (/\b(you|your|thanks|thank you|hey|hello|hi|good morning|good night|please)\b/i.test(text)) setAddressedAt(Date.now())
    try {
      const res = await window.api.sendChat(text)
      setMessages((m) => [...m.filter((x) => x.id !== tempId), res.userMessage, { ...res.assistantMessage, applied: res.applied, error: res.error }])
      // Feed the creature: what happened, and whether it deserves a small celebration.
      setLastToolNames(res.applied.map((a) => a.tool))
      if (res.applied.length) setLastAppliedAt(Date.now())
      if (res.error) setConcernedAt(Date.now())
      const big = res.applied.some(
        (a) =>
          (a.tool === 'complete_item' && a.itemId && itemById.get(a.itemId)?.kind === 'project') ||
          (a.tool === 'complete_checklist_item' && /last step/.test(a.phrase)) ||
          a.tool === 'archive_project'
      )
      if (big) setCelebrateAt(Date.now())
    } catch (e) {
      setConcernedAt(Date.now())
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString() },
        { id: `err-${Date.now()}`, role: 'assistant', content: `Something went wrong on my side: ${(e as Error).message}`, tier: null, created_at: new Date().toISOString(), error: (e as Error).message }
      ])
    }
    void refresh()
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const live = (i: Item): boolean => !['done', 'cancelled', 'archived'].includes(i.status)
  const openItems = items.filter(live)
  const pending = reminders.filter((r) => r.state === 'pending' || r.state === 'snoozed' || r.state === 'paused')
  const itemById = new Map(items.map((i) => [i.id, i]))
  // Things: which project each item belongs to (part_of), and how many live parts each project has.
  const parentOf = new Map<string, Item>()
  const partsOf = new Map<string, number>()
  for (const l of links) {
    if (l.type !== 'part_of') continue
    const p = itemById.get(l.to_item)
    if (p) parentOf.set(l.from_item, p)
    const child = itemById.get(l.from_item)
    if (child && live(child)) partsOf.set(l.to_item, (partsOf.get(l.to_item) ?? 0) + 1)
  }
  const projects = openItems.filter((i) => i.kind === 'project')
  // Blocked = has an open blocker via a `blocks` link. Computed here from the links table, never stored.
  const blockersOf = new Map<string, Item[]>()
  for (const l of links) {
    if (l.type !== 'blocks') continue
    const b = itemById.get(l.from_item)
    if (b && live(b)) blockersOf.set(l.to_item, [...(blockersOf.get(l.to_item) ?? []), b])
  }
  // Checklist steps render nested under their Thing, in sort order, not as standalone rows.
  const checklistOf = new Map<string, Item[]>()
  for (const it of openItems) {
    if (it.kind !== 'checklist_item') continue
    const p = parentOf.get(it.id)
    if (!p) continue
    const arr = checklistOf.get(p.id) ?? []
    arr.push(it)
    checklistOf.set(p.id, arr)
  }
  for (const arr of checklistOf.values()) arr.sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || a.created_at.localeCompare(b.created_at))
  const waitingItems = openItems.filter((i) => i.kind === 'waiting').sort((a, b) => (a.due_at_utc ?? '9').localeCompare(b.due_at_utc ?? '9'))
  const followUpsOn = new Map<string, Reminder[]>()
  for (const r of pending) {
    const m = /"unless_resolved":"([0-9a-f-]{36})"/.exec(r.condition_json ?? '')
    if (m) followUpsOn.set(m[1], [...(followUpsOn.get(m[1]) ?? []), r])
  }
  const standalone = openItems.filter((i) => !(i.kind === 'checklist_item' && parentOf.has(i.id)) && i.kind !== 'waiting')
  const reorder = (project: Item, id: string, dir: -1 | 1): void => {
    const list = checklistOf.get(project.id) ?? []
    const idx = list.findIndex((c) => c.id === id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= list.length) return
    const ids = list.map((c) => c.id)
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    void quick('reorder_checklist', { project_id: project.id, ordered_ids: ids })
  }

  // Overdue is its own list (spec §7 Today: "live obligations, blockers"), never mixed into Coming Up.
  const now = Date.now()
  const overdueItems = openItems.filter((i) => isOverdue(i.due_at_utc, i.due_precision, now)).sort((a, b) => a.due_at_utc!.localeCompare(b.due_at_utc!))
  const overdueIds = new Set(overdueItems.map((i) => i.id))

  // Coming Up reflects exactly what exists (spec §5): alarms AND dated items, told apart, next 7 days.
  const horizon = now + 7 * 24 * 3600 * 1000
  const todayIso = new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const horizonIso = new Date(horizon - new Date(horizon).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  // Day notes ("travelling Friday") sit in Coming Up as information, never as obligations.
  const dayNotes = notes.filter((n) => n.target_type === 'date' && n.target_id >= todayIso && n.target_id <= horizonIso)
  const notesOnItem = new Map<string, Note[]>()
  for (const n of notes) if (n.target_type === 'item') notesOnItem.set(n.target_id, [...(notesOnItem.get(n.target_id) ?? []), n])
  type Upcoming = { key: string; at: number; label: string; when: string; kind: 'alarm' | 'due' | 'note'; suggestion: boolean; open: () => void; item?: Item }
  const upcoming: Upcoming[] = [
    ...pending
      .filter((r) => new Date(r.fire_at_utc).getTime() <= horizon && !(r.target_type === 'item' && overdueIds.has(r.target_id)))
      .map((r) => ({
        key: 'r' + r.id,
        at: new Date(r.fire_at_utc).getTime(),
        label: (r.item_title ?? 'Reminder') + (r.rrule ? ' ↻' : '') + (r.state === 'paused' ? ' (paused)' : ''),
        when: formatClock(r.fire_at_utc),
        kind: 'alarm' as const,
        suggestion: false,
        open: () => setEditing({ kind: 'reminder', reminder: r }),
        item: r.target_type === 'item' ? itemById.get(r.target_id) : undefined
      })),
    // A dated item with a live alarm is already represented by its 🔔 row; only alarm-less dates get a 📅 row.
    ...openItems
      .filter((i) => i.due_at_utc && new Date(i.due_at_utc).getTime() <= horizon && !overdueIds.has(i.id))
      .filter((i) => !pending.some((r) => r.target_type === 'item' && r.target_id === i.id))
      .map((i) => ({
        key: 'i' + i.id,
        at: new Date(i.due_at_utc!).getTime(),
        label: i.title,
        when: formatDue(i.due_at_utc, i.due_precision),
        kind: 'due' as const,
        suggestion: !!i.is_suggestion,
        open: () => setEditing({ kind: 'item', item: i }),
        item: i
      })),
    ...dayNotes.map((n) => ({
      key: 'n' + n.id,
      at: new Date(n.target_id + 'T00:00').getTime() + 1,
      label: n.body,
      when: new Date(n.target_id + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      kind: 'note' as const,
      suggestion: false,
      open: () => setEditing({ kind: 'note', note: n }),
      item: undefined as Item | undefined
    }))
  ].sort((a, b) => a.at - b.at)

  // Overdue count rising is a moment of concern, not a permanent frown.
  useEffect(() => {
    const n = overdueItems.length
    if (prevOverdue.current !== null && n > prevOverdue.current) setConcernedAt(Date.now())
    prevOverdue.current = n
  }, [overdueItems.length])

  // What is happening in the room right now (Phase 5): focus wins, then cooking, then something the user waits on.
  const runningHappenings = happenings.filter((h) => h.state === 'running')
  const happeningKind: 'focus' | 'cooking' | 'waiting' | null = runningHappenings.some((h) => h.kind === 'focus' || h.metaphor === 'focus')
    ? 'focus'
    : runningHappenings.some((h) => ['egg', 'tea', 'cooking'].includes(h.kind ?? '') || h.metaphor === 'egg' || h.metaphor === 'tea' || h.metaphor === 'plant')
      ? 'cooking'
      : runningHappenings.some((h) => ['laundry', 'charging', 'process'].includes(h.kind ?? '') || h.metaphor === 'laundry' || h.metaphor === 'download')
        ? 'waiting'
        : null

  const companion = useCompanion(
    {
      chat: status,
      typing: draft.trim().length > 0 && Date.now() - typingAt < 8000,
      lastToolNames,
      lastAppliedAt,
      celebrateAt,
      greetAt,
      addressedAt,
      concernedAt,
      waitingOpen: waitingItems.length,
      hour,
      happening: happeningKind
    },
    forcedState
  )

  return (
    <div className="h-full flex flex-col gap-3 p-5 overflow-hidden">
      {/* SURFACES (spec §7): Conversation is home; Calendar, Things and Settings are their own full-width screens. */}
      <nav className="flex items-center gap-1 text-sm" aria-label="Surfaces">
        {(
          [
            ['conversation', 'Conversation'],
            ['calendar', 'Calendar'],
            ['things', 'Things'],
            ['settings', 'Settings']
          ] as [Surface, string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setSurface(id)} className={`rounded-full px-3 py-1 ${surface === id ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'text-stone-500 hover:bg-white/60 hover:text-stone-800'}`} aria-current={surface === id ? 'page' : undefined}>
            {label}
          </button>
        ))}
      </nav>

      {surface === 'calendar' && (
        <div className="flex-1 min-h-0">
          <CalendarSurface
            dateLocal={calDate}
            onChangeDate={setCalDate}
            mode={calMode}
            onChangeMode={setCalMode}
            weekStart={weekStart}
            onChangeWeekStart={(n) => {
              setWeekStart(n)
              void window.api.setSetting('calendar.weekStart', String(n))
            }}
            onOpenEditor={(it) => setEditing(it.kind === 'project' ? { kind: 'project', project: it } : { kind: 'item', item: it })}
            onQuick={quick}
            refreshKey={refreshKey}
            initialSelection={hashParts['panel'] ? { kind: 'date' } : null}
          />
        </div>
      )}
      {surface === 'things' && (
        <div className="flex-1 min-h-0 rounded-3xl bg-white/50 p-6 flex items-center justify-center text-sm text-stone-400 text-center">
          <div>
            <div className="text-base text-stone-500 mb-1">Things — its own surface, later.</div>
            <div>For now, open a Thing from the conversation's rail.</div>
          </div>
        </div>
      )}
      {surface === 'settings' && (
        <div className="flex-1 min-h-0 rounded-3xl bg-white/50 p-6 flex items-center justify-center text-sm text-stone-400 text-center">
          <div>
            <div className="text-base text-stone-500 mb-1">Settings — its own surface, later.</div>
            <div>The scene chooser is in the room; the week start is in the calendar header.</div>
          </div>
        </div>
      )}

      {surface === 'conversation' && (
      <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(0,1fr)_300px] gap-5 overflow-hidden">
      {/* ROOM + COMPANION */}
      <aside className="relative overflow-hidden rounded-3xl">
        <Room
          state={companion.state}
          gaze={companion.gaze}
          happening={happeningKind}
          environment={environment}
          time={timeChoice}
          onChangeEnvironment={(e) => {
            setEnvironment(e)
            void window.api.setSetting('scene.environment', e)
          }}
          onChangeTime={(t) => {
            setTimeChoice(t)
            void window.api.setSetting('scene.timeOfDay', t)
          }}
        />
        <div className="absolute top-3 left-4 text-[11px] text-stone-600/80 pointer-events-none">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <p className="absolute bottom-2 left-0 right-0 text-[11px] text-stone-500 text-center pointer-events-none">
          {status.kind === 'throttled' ? `one moment — retrying in ${status.retryInSeconds}s` : ''}
        </p>
      </aside>

      {/* CONVERSATION */}
      <main className="flex flex-col min-h-0">
        <header className="flex items-baseline justify-between mb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Secretary</h1>
          <div className="flex gap-3 text-xs text-stone-500">
            <button onClick={() => void quick('undo_last', {})} className="hover:text-stone-800" title="Undo the last change">
              undo
            </button>
            <button onClick={() => setShowDebug((v) => !v)} className="hover:text-stone-800">
              {showDebug ? 'hide debug' : 'debug'}
            </button>
          </div>
        </header>

        {info && !info.ai.hasKey && (
          <div className="mb-3 rounded-xl bg-amber-50 text-amber-900 text-sm px-4 py-2">
            No API key found. Put <code>GEMINI_API_KEY=…</code> in the <code>.env</code> file next to <code>package.json</code>, then quit and reopen the app. Everything else still works by hand.
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-3xl bg-white/50 p-5 flex flex-col gap-3">
          {messages.length === 0 && (
            <p className="text-sm text-stone-400 m-auto text-center max-w-sm">
              Tell me what's on your mind. "Remind me to call the bank Thursday at 3", "the CV is done", "actually make it 4", "undo that".
            </p>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {status.kind !== 'idle' && <div className="self-start rounded-2xl bg-[#F1E9DF] px-4 py-2 text-sm text-stone-500 animate-pulse">…</div>}
        </div>

        <div className="mt-3 rounded-2xl bg-white shadow-sm flex items-end gap-2 p-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setTypingAt(Date.now())
            }}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="type or dump here — Enter to send, Shift+Enter for a new line"
            className="flex-1 resize-none bg-transparent px-3 py-2 outline-none text-[15px] leading-relaxed"
          />
          <button onClick={() => void send()} disabled={!draft.trim() || status.kind !== 'idle'} className="rounded-xl bg-[#3A2E28] text-[#FAF6F0] px-4 py-2 text-sm disabled:opacity-30">
            Send
          </button>
        </div>
        {flash && <p className="mt-2 text-xs text-stone-500">{flash}</p>}
      </main>

      {/* TODAY RAIL (or DEBUG) */}
      <aside className="flex flex-col gap-4 min-h-0 overflow-hidden">
        {!showDebug ? (
          <>
            {overdueItems.length > 0 && (
              <section className="rounded-2xl bg-amber-50/80 p-4 flex flex-col gap-2 min-h-0">
                <h2 className="text-xs font-medium uppercase tracking-wide text-amber-800">Overdue ({overdueItems.length})</h2>
                <ul className="flex flex-col gap-1 overflow-y-auto">
                  {overdueItems.slice(0, 8).map((it) => (
                    <li key={it.id} className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={() => setEditing({ kind: 'item', item: it })}>
                      <span className="mt-0.5 text-xs">⚠️</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{it.title}</div>
                        <div className="text-xs text-amber-800">was due {formatDue(it.due_at_utc, it.due_precision)}</div>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                        title="Done"
                        onClick={(e) => {
                          e.stopPropagation()
                          void quick('complete_item', { id: it.id })
                        }}
                      >
                        ✓
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="rounded-2xl bg-white/60 p-4 flex flex-col gap-2 min-h-0">
              <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Coming up · 7 days</h2>
              {upcoming.length === 0 && <p className="text-sm text-stone-400">Nothing dated, no alarms set.</p>}
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {upcoming.slice(0, 10).map((u) => (
                  <li key={u.key} className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={u.open}>
                    <span className="mt-0.5 text-xs" title={u.kind === 'alarm' ? 'Reminder will fire' : u.kind === 'note' ? 'Note for that day' : 'Due date, no reminder'}>
                      {u.kind === 'alarm' ? '🔔' : u.kind === 'note' ? '📝' : '📅'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate ${u.suggestion || u.kind === 'note' ? 'italic text-stone-600' : ''}`}>
                        {u.label}
                        {u.suggestion && <span className="ml-1 text-[10px] not-italic text-stone-400">suggested</span>}
                      </div>
                      <div className="text-xs text-stone-500">
                        {u.when}
                        {u.kind === 'due' && <span className="text-stone-400"> · no reminder</span>}
                        {u.kind === 'note' && <span className="text-stone-400"> · note</span>}
                      </div>
                    </div>
                    {u.item && live(u.item) && (
                      <button
                        className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                        title="Done"
                        onClick={(e) => {
                          e.stopPropagation()
                          void quick('complete_item', { id: u.item!.id })
                        }}
                      >
                        ✓
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <RightNow happenings={happenings} onFinish={(id, outcome) => void quick('finish_happening', { id, outcome })} />
            {constraints.length > 0 && (
              <section className="rounded-2xl bg-stone-100/80 p-4 flex flex-col gap-1 min-h-0">
                <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Unavailable / preferences ({constraints.length})</h2>
                <ul className="flex flex-col gap-0.5 overflow-y-auto">
                  {constraints.slice(0, 8).map((c) => (
                    <li key={c.id} className="group text-xs flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-white/80">
                      <span>{c.label.startsWith('buffer|') ? '↔' : c.kind === 'unavailable' ? '🚫' : c.kind === 'avoid' ? '⚠️' : '👍'}</span>
                      {c.label.startsWith('buffer|') ? (
                        <span className="flex-1 truncate text-stone-700" title="A transition buffer: bookings tighter than this are flagged as a poor fit">
                          <span className="font-medium">buffer</span>
                          <span className="text-stone-500">{` · ${c.label.split('|')[2]} min ${c.label.split('|')[1] === 'around' ? 'either side of' : c.label.split('|')[1]} ${c.label.split('|')[3] ? `“${c.label.split('|')[3]}”` : 'anything'}`}</span>
                        </span>
                      ) : (
                      <span className="flex-1 truncate text-stone-700">
                        <span className="font-medium">{c.label}</span>
                        <span className="text-stone-500">
                          {' · '}
                          {c.starts_at ? formatClock(c.starts_at).replace(/ at 00:00$/, '') : ''}
                          {c.ends_at && c.starts_at && new Date(c.ends_at).getTime() - new Date(c.starts_at).getTime() < 23.9 * 3600000 ? `–${new Date(c.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}` : ' (all day)'}
                          {c.rrule ? ' ↻' : ''}
                        </span>
                      </span>
                      )}
                      <button className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-red-700" title="Remove" onClick={() => void quick('remove_constraint', { id: c.id })}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {waitingItems.length > 0 && (
              <section className="rounded-2xl bg-sky-50/70 p-4 flex flex-col gap-2 min-h-0">
                <h2 className="text-xs font-medium uppercase tracking-wide text-sky-900">Waiting on ({waitingItems.length})</h2>
                <ul className="flex flex-col gap-1 overflow-y-auto">
                  {waitingItems.map((w) => {
                    const late = isOverdue(w.due_at_utc, w.due_precision, now)
                    const fu = followUpsOn.get(w.id) ?? []
                    return (
                      <li key={w.id} className="group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer" onClick={() => setEditing({ kind: 'item', item: w })}>
                        <span className="mt-0.5 text-xs">⏳</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate">
                            <span className="font-medium">{w.waiting_on ?? 'someone'}</span>
                            {w.details ? <span className="text-stone-600"> · {w.details}</span> : null}
                          </div>
                          <div className={`text-xs truncate ${late ? 'text-amber-800' : 'text-stone-500'}`}>
                            {w.due_at_utc ? `${late ? 'expected ' : 'expected '}${formatDue(w.due_at_utc, w.due_precision)}${late ? ' · no word yet' : ''}` : `since ${new Date(w.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                            {parentOf.has(w.id) && <> · {parentOf.get(w.id)!.title}</>}
                            {fu.length > 0 && <> · follow-up {formatClock(fu[0].fire_at_utc)} unless resolved</>}
                          </div>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1 whitespace-nowrap"
                          title="They replied"
                          onClick={(e) => {
                            e.stopPropagation()
                            void quick('resolve_waiting', { id: w.id, outcome: 'replied' })
                          }}
                        >
                          replied ✓
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            <section className="rounded-2xl bg-white/60 p-4 flex flex-col gap-2 min-h-0 flex-1">
              <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Open ({standalone.filter((i) => !i.is_suggestion).length})</h2>
              {standalone.length === 0 && <p className="text-sm text-stone-400">Nothing open.</p>}
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {standalone.slice(0, 30).map((it) => (
                  <li
                    key={it.id}
                    className="group text-sm flex flex-col rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer"
                    onClick={() => setEditing(it.kind === 'project' ? { kind: 'project', project: it } : { kind: 'item', item: it })}
                  >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] mt-1 rounded px-1 ${it.kind === 'project' ? 'bg-[#B5836D]/25 text-[#3A2E28]' : it.kind === 'commitment' ? 'bg-rose-100 text-rose-900' : 'bg-stone-200 text-stone-600'}`} title={it.kind === 'commitment' ? `Promised to ${it.committed_to ?? 'someone'}` : undefined}>
                      {it.is_suggestion ? 'suggested' : it.kind === 'project' ? 'thing' : it.kind === 'commitment' ? `to ${it.committed_to ?? 'someone'}` : it.kind.replace('_', ' ')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate ${it.is_suggestion ? 'italic text-stone-500' : ''} ${it.kind === 'project' ? 'font-medium' : ''}`}>{it.title}</div>
                      {(it.due_at_utc || it.status !== 'open' || it.kind === 'project' || parentOf.has(it.id)) && (
                        <div className="text-xs text-stone-500 truncate">
                          {it.status !== 'open' && <span className="mr-1">{it.status.replace('_', ' ')}</span>}
                          {it.due_at_utc && <>due {formatDue(it.due_at_utc, it.due_precision)}{it.hardness === 'hard' ? ' · hard' : ''}</>}
                          {it.kind === 'project' && <span>{it.due_at_utc ? ' · ' : ''}{partsOf.get(it.id) ?? 0} open {(partsOf.get(it.id) ?? 0) === 1 ? 'part' : 'parts'}</span>}
                          {parentOf.has(it.id) && <span>{it.due_at_utc ? ' · ' : ''}part of {parentOf.get(it.id)!.title}</span>}
                        </div>
                      )}
                      {blockersOf.has(it.id) && (
                        <div className="text-xs text-amber-800 truncate">⛔ blocked by {blockersOf.get(it.id)!.map((b) => b.title).join(', ')}</div>
                      )}
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                      title="Done"
                      onClick={(e) => {
                        e.stopPropagation()
                        void quick('complete_item', { id: it.id })
                      }}
                    >
                      ✓
                    </button>
                  </div>
                  {it.kind === 'project' && (checklistOf.get(it.id)?.length ?? 0) > 0 && (
                    <ul className="ml-6 mt-1 flex flex-col gap-0.5">
                      {checklistOf.get(it.id)!.map((c, idx, arr) => (
                        <li key={c.id} className="group/step flex items-center gap-2 text-xs text-stone-700" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="w-4 h-4 rounded border border-stone-400 hover:bg-emerald-100 shrink-0"
                            title="Tick off"
                            onClick={() => void quick('complete_checklist_item', { id: c.id })}
                          />
                          <span className="truncate flex-1 cursor-pointer hover:underline" onClick={() => setEditing({ kind: 'item', item: c })}>
                            {c.title}
                          </span>
                          <span className="opacity-0 group-hover/step:opacity-100 flex gap-1 text-stone-400">
                            <button disabled={idx === 0} className="disabled:opacity-20 hover:text-stone-800" title="Move up" onClick={() => reorder(it, c.id, -1)}>↑</button>
                            <button disabled={idx === arr.length - 1} className="disabled:opacity-20 hover:text-stone-800" title="Move down" onClick={() => reorder(it, c.id, 1)}>↓</button>
                            <button className="hover:text-red-700" title="Strike off" onClick={() => void quick('remove_checklist_item', { id: c.id })}>×</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : (
          <DebugPanel info={info} logs={logs} aiCalls={aiCalls} activities={activities} extractions={extractions} reminders={reminders} say={say} refresh={refresh} onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })} />
        )}
      </aside>
      </div>
      )}

      {editing?.kind === 'item' && (
        <ItemEditor
          target={itemById.get(editing.item.id) ?? editing.item}
          reminders={reminders}
          projects={projects}
          parentId={parentOf.get(editing.item.id)?.id ?? null}
          notes={notesOnItem.get(editing.item.id) ?? []}
          blockers={blockersOf.get(editing.item.id) ?? []}
          candidates={openItems.filter((i) => i.id !== editing.item.id && i.kind !== 'project')}
          onHistory={() => setEditing(editing.item.kind === 'project' ? { kind: 'project', project: editing.item } : { kind: 'history', item: editing.item })}
          runTool={runTool}
          onDone={say}
          onClose={() => setEditing(null)}
          onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })}
        />
      )}
      {editing?.kind === 'reminder' && (
        <ReminderEditor target={reminders.find((r) => r.id === editing.reminder.id) ?? editing.reminder} runTool={runTool} onDone={say} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === 'note' && <NoteEditor note={notes.find((n) => n.id === editing.note.id) ?? editing.note} runTool={runTool} onDone={say} onClose={() => setEditing(null)} />}
      {editing?.kind === 'project' && (
        <ProjectView
          project={itemById.get(editing.project.id) ?? editing.project}
          parts={items.filter((i) => parentOf.get(i.id)?.id === editing.project.id)}
          notes={notesOnItem.get(editing.project.id) ?? []}
          reminders={reminders}
          runTool={runTool}
          onOpenItem={(i) => setEditing({ kind: 'item', item: i })}
          onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })}
          onClose={() => setEditing(null)}
          initialTab={editing.tab}
        />
      )}
      {editing?.kind === 'history' && <ItemHistory item={editing.item} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Bubble({ m }: { m: UiMessage }): React.JSX.Element {
  if (m.role === 'system') {
    return <div className="self-center text-xs text-stone-500 bg-white/60 rounded-full px-3 py-1 max-w-[85%] truncate">{m.content}</div>
  }
  const user = m.role === 'user'
  return (
    <div className={`flex flex-col gap-1 max-w-[85%] ${user ? 'self-end items-end' : 'self-start items-start'}`}>
      <div
        className={`rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${user ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'bg-[#F1E9DF] text-[#3A2E28]'} ${m.pending ? 'opacity-60' : ''}`}
      >
        {m.content}
      </div>
      {m.applied && m.applied.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {m.applied.map((a, i) => (
            <li key={i} className="text-xs text-emerald-800 flex items-center gap-1">
              <span>✓</span>
              <span>{a.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {!user && m.tier === 0 && !m.pending && <span className="text-[10px] text-stone-400">instant · no model call</span>}
      {m.error && <div className="text-xs text-red-700">{m.error}</div>}
    </div>
  )
}

function DebugPanel(props: {
  info: AppInfo | null
  logs: SchedulerLogEntry[]
  aiCalls: SchedulerLogEntry[]
  activities: Activity[]
  extractions: ExtractionEntry[]
  reminders: Reminder[]
  say: (s: string) => void
  refresh: () => Promise<void>
  onOpenReminder: (r: Reminder) => void
}): React.JSX.Element {
  const { info, logs, aiCalls, activities, extractions, reminders, say, refresh, onOpenReminder } = props
  const [tab, setTab] = useState<'scheduler' | 'ai' | 'activity' | 'extractions' | 'reminders'>('scheduler')
  const run = async (fn: () => Promise<string>): Promise<void> => {
    try {
      say(await fn())
    } catch (e) {
      say('Error: ' + (e as Error).message)
    }
    await refresh()
  }
  const tabs: [typeof tab, string][] = [
    ['scheduler', 'Scheduler'],
    ['ai', 'AI calls'],
    ['activity', 'Activity'],
    ['extractions', 'Extractions'],
    ['reminders', 'Reminders']
  ]
  return (
    <>
      <section className="rounded-2xl bg-white/70 p-3 text-[11px] flex flex-col gap-1">
        {info && (
          <>
            <Row k="AI" v={info.ai.hasKey ? `${info.ai.provider} / ${info.ai.model}` : 'no key'} />
            <Row k="DB" v={info.dbPath} />
            <Row k="Zone" v={info.timezone} />
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input type="checkbox" checked={info.openAtLogin} onChange={(e) => run(async () => ((await window.api.setOpenAtLogin(e.target.checked)) ? 'Starts with Windows' : 'Will not start with Windows'))} />
              Start with Windows
            </label>
          </>
        )}
        <div className="flex flex-wrap gap-1 pt-1">
          <Btn onClick={() => run(async () => { const r = await window.api.createTestReminder(1); return `Test reminder at ${fmtLocal(r.fire_at_utc)}` })}>+1 min</Btn>
          <Btn onClick={() => run(async () => { await window.api.createTestReminder(-10); return 'Past reminder created; should be delivered as missed now' })}>10 min ago</Btn>
          <Btn onClick={() => run(async () => { await window.api.sendTestNotification(); return 'Toast requested' })}>Test toast</Btn>
          <Btn onClick={() => run(async () => { await window.api.clearLog(); return 'Log cleared' })}>Clear log</Btn>
        </div>
      </section>
      <div className="flex gap-1 flex-wrap">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-2 py-0.5 text-[11px] ${tab === k ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'bg-white/60 text-stone-600'}`}>
            {l}
          </button>
        ))}
      </div>
      <section className="rounded-2xl bg-white/70 p-3 flex flex-col min-h-0 flex-1">
        {tab === 'scheduler' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-0.5 flex-1">
            {logs.map((l) => (
              <li key={l.id} className={levelColor[l.level] ?? ''}>
                <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span> <span className="font-semibold">{l.event}</span>
                {l.detail && <span> — {l.detail}</span>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'ai' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-0.5 flex-1">
            {aiCalls.length === 0 && <li className="text-stone-400">No AI calls yet.</li>}
            {aiCalls.map((l) => (
              <li key={l.id} className={levelColor[l.level] ?? ''}>
                <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span> <span className="font-semibold">{l.event}</span>
                {l.detail && <span> — {l.detail.slice(0, 220)}</span>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'activity' && (
          <ol className="overflow-y-auto text-[11px] leading-relaxed flex flex-col gap-1 flex-1">
            {activities.length === 0 && <li className="text-stone-400">Nothing has happened yet.</li>}
            {activities.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="text-stone-400 whitespace-nowrap">{fmtLogTime(a.created_at)}</span>
                <span className={`rounded px-1 text-[10px] ${a.actor === 'system' ? 'bg-stone-100 text-stone-500' : a.actor === 'assistant' ? 'bg-[#B5836D]/20' : 'bg-emerald-100'}`}>{a.actor}</span>
                <span className={a.reversible ? '' : 'text-stone-500'}>{a.summary}</span>
              </li>
            ))}
          </ol>
        )}
        {tab === 'extractions' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-1 flex-1">
            {extractions.length === 0 && <li className="text-stone-400">None yet.</li>}
            {extractions.map((x) => (
              <li key={x.id} className={x.applied ? 'text-stone-600' : 'text-red-700'}>
                <span className="text-stone-400">{fmtLogTime(x.created_at)}</span> {x.applied ? '✓' : '✗'} {x.tools_json.slice(0, 300)}
                {x.error && <div>error: {x.error}</div>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'reminders' && (
          <div className="overflow-y-auto text-[11px] flex-1">
            {reminders.slice(0, 40).map((r) => (
              <div key={r.id} className="flex gap-2 py-0.5 cursor-pointer hover:bg-white" onClick={() => onOpenReminder(r)}>
                <span className="w-20 shrink-0 text-stone-500">{r.state}</span>
                <span className="truncate flex-1">{r.item_title ?? 'Reminder'}{r.rrule ? ' ↻' : ''}</span>
                <span className="text-stone-500 whitespace-nowrap">{fmtLocal(r.fire_at_utc)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="rounded-lg bg-[#B5836D]/15 hover:bg-[#B5836D]/30 px-2 py-0.5 text-[11px] text-[#3A2E28]">
      {children}
    </button>
  )
}

function Row({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-stone-500 w-10 shrink-0">{k}</span>
      <span className="break-all select-all">{v}</span>
    </div>
  )
}
