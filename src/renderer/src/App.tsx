import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  AppliedChange,
  ChatMessage,
  ChatStatus,
  ExtractionEntry,
  Item,
  Reminder,
  SchedulerLogEntry
} from '../../shared/types'
import { Companion } from './Companion'
import { formatClock, formatDue } from '../../shared/format'

const fmtLocal = (utcIso: string | null): string => (utcIso ? formatClock(utcIso) : '—')

const fmtLogTime = (utcIso: string): string =>
  new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const levelColor: Record<string, string> = {
  info: 'text-stone-600',
  warn: 'text-amber-700 font-medium',
  error: 'text-red-700 font-semibold'
}

type UiMessage = ChatMessage & { applied?: AppliedChange[]; error?: string | null; pending?: boolean }

export default function App(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [logs, setLogs] = useState<SchedulerLogEntry[]>([])
  const [extractions, setExtractions] = useState<ExtractionEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<ChatStatus>({ kind: 'idle' })
  const [showDebug, setShowDebug] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [i, r, l, a, x] = await Promise.all([
        window.api.listItems(),
        window.api.listReminders(),
        window.api.listLog(50),
        window.api.getAppInfo(),
        window.api.listExtractions(20)
      ])
      setItems(i)
      setReminders(r)
      setLogs(l)
      setInfo(a)
      setExtractions(x)
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

  const say = (msg: string): void => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 5000)
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || status.kind !== 'idle') return
    setDraft('')
    const tempId = `tmp-${Date.now()}`
    setMessages((m) => [...m, { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString(), pending: true }])
    try {
      const res = await window.api.sendChat(text)
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        res.userMessage,
        { ...res.assistantMessage, applied: res.applied, error: res.error }
      ])
    } catch (e) {
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString() },
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Something went wrong on my side: ${(e as Error).message}`,
          tier: null,
          created_at: new Date().toISOString(),
          error: (e as Error).message
        }
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

  const openItems = items.filter((i) => i.status === 'open')
  const pending = reminders.filter((r) => r.state === 'pending' || r.state === 'snoozed')

  // Coming Up reflects exactly what exists (spec §5): alarms AND dated items, told apart, next 7 days.
  const horizon = Date.now() + 7 * 24 * 3600 * 1000
  type Upcoming = { key: string; at: number; label: string; when: string; kind: 'alarm' | 'due'; suggestion: boolean }
  const upcoming: Upcoming[] = [
    ...pending
      .filter((r) => new Date(r.fire_at_utc).getTime() <= horizon)
      .map((r) => ({
        key: 'r' + r.id,
        at: new Date(r.fire_at_utc).getTime(),
        label: r.item_title ?? 'Reminder',
        when: formatClock(r.fire_at_utc),
        kind: 'alarm' as const,
        suggestion: false
      })),
    ...openItems
      .filter((i) => i.due_at_utc && new Date(i.due_at_utc).getTime() <= horizon)
      .map((i) => ({
        key: 'i' + i.id,
        at: new Date(i.due_at_utc!).getTime(),
        label: i.title,
        when: formatDue(i.due_at_utc, i.due_precision),
        kind: 'due' as const,
        suggestion: !!i.is_suggestion
      }))
  ].sort((a, b) => a.at - b.at)
  const companionState =
    status.kind === 'thinking' ? 'thinking' : status.kind === 'tools' ? 'working' : status.kind === 'throttled' ? 'waiting' : 'idle'

  return (
    <div className="h-full grid grid-cols-[260px_minmax(0,1fr)_280px] gap-5 p-5 overflow-hidden">
      {/* ROOM + COMPANION */}
      <aside className="rounded-3xl bg-[#F1E9DF] shadow-inner flex flex-col items-center justify-end p-5 overflow-hidden relative">
        <div className="absolute top-5 left-5 right-5 text-xs text-stone-500">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <Companion state={companionState} />
        <p className="mt-4 text-xs text-stone-500 text-center min-h-[1.5em]">
          {status.kind === 'thinking' && 'thinking…'}
          {status.kind === 'tools' && 'writing it down…'}
          {status.kind === 'throttled' && `one moment — busy, retrying in ${status.retryInSeconds}s`}
          {status.kind === 'idle' && ' '}
        </p>
      </aside>

      {/* CONVERSATION */}
      <main className="flex flex-col min-h-0">
        <header className="flex items-baseline justify-between mb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Secretary</h1>
          <button onClick={() => setShowDebug((v) => !v)} className="text-xs text-stone-500 hover:text-stone-800">
            {showDebug ? 'hide debug' : 'debug'}
          </button>
        </header>

        {info && !info.ai.hasKey && (
          <div className="mb-3 rounded-xl bg-amber-50 text-amber-900 text-sm px-4 py-2">
            No API key found. Put <code>GEMINI_API_KEY=…</code> in the <code>.env</code> file next to <code>package.json</code>, then quit and reopen the app.
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-3xl bg-white/50 p-5 flex flex-col gap-3">
          {messages.length === 0 && (
            <p className="text-sm text-stone-400 m-auto text-center max-w-sm">
              Tell me what's on your mind. "Remind me to call the bank Thursday at 3", "the CV is done", "actually make it 4".
            </p>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {status.kind !== 'idle' && (
            <div className="self-start rounded-2xl bg-[#F1E9DF] px-4 py-2 text-sm text-stone-500 animate-pulse">…</div>
          )}
        </div>

        <div className="mt-3 rounded-2xl bg-white shadow-sm flex items-end gap-2 p-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="type or dump here — Enter to send, Shift+Enter for a new line"
            className="flex-1 resize-none bg-transparent px-3 py-2 outline-none text-[15px] leading-relaxed"
          />
          <button
            onClick={() => void send()}
            disabled={!draft.trim() || status.kind !== 'idle'}
            className="rounded-xl bg-[#3A2E28] text-[#FAF6F0] px-4 py-2 text-sm disabled:opacity-30"
          >
            Send
          </button>
        </div>
        {flash && <p className="mt-2 text-xs text-stone-500">{flash}</p>}
      </main>

      {/* TODAY RAIL (or DEBUG) */}
      <aside className="flex flex-col gap-4 min-h-0 overflow-hidden">
        {!showDebug ? (
          <>
            <section className="rounded-2xl bg-white/60 p-4 flex flex-col gap-2 min-h-0">
              <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Coming up · 7 days</h2>
              {upcoming.length === 0 && <p className="text-sm text-stone-400">Nothing dated, no alarms set.</p>}
              <ul className="flex flex-col gap-1.5 overflow-y-auto">
                {upcoming.slice(0, 10).map((u) => (
                  <li key={u.key} className="text-sm flex items-start gap-2">
                    <span className="mt-0.5 text-xs" title={u.kind === 'alarm' ? 'Reminder will fire' : 'Due date, no reminder'}>
                      {u.kind === 'alarm' ? '🔔' : '📅'}
                    </span>
                    <div className="min-w-0">
                      <div className={`truncate ${u.suggestion ? 'italic text-stone-500' : ''}`}>
                        {u.label}
                        {u.suggestion && <span className="ml-1 text-[10px] not-italic text-stone-400">suggested</span>}
                      </div>
                      <div className="text-xs text-stone-500">
                        {u.when}
                        {u.kind === 'due' && <span className="text-stone-400"> · no reminder</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl bg-white/60 p-4 flex flex-col gap-2 min-h-0 flex-1">
              <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">
                Open ({openItems.filter((i) => !i.is_suggestion).length})
              </h2>
              {openItems.length === 0 && <p className="text-sm text-stone-400">Nothing open.</p>}
              <ul className="flex flex-col gap-1.5 overflow-y-auto">
                {openItems.slice(0, 20).map((it) => (
                  <li key={it.id} className="text-sm flex items-start gap-2">
                    <span className="text-[10px] mt-1 rounded px-1 bg-stone-200 text-stone-600">{it.is_suggestion ? 'suggested' : it.kind}</span>
                    <div className="min-w-0">
                      <div className={`truncate ${it.is_suggestion ? 'italic text-stone-500' : ''}`}>{it.title}</div>
                      {it.due_at_utc && <div className="text-xs text-stone-500">due {formatDue(it.due_at_utc, it.due_precision)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : (
          <DebugPanel info={info} logs={logs} extractions={extractions} reminders={reminders} say={say} refresh={refresh} />
        )}
      </aside>
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
        className={`rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${
          user ? 'bg-[#3A2E28] text-[#FAF6F0]' : 'bg-[#F1E9DF] text-[#3A2E28]'
        } ${m.pending ? 'opacity-60' : ''}`}
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
      {m.error && <div className="text-xs text-red-700">{m.error}</div>}
    </div>
  )
}

function DebugPanel(props: {
  info: AppInfo | null
  logs: SchedulerLogEntry[]
  extractions: ExtractionEntry[]
  reminders: Reminder[]
  say: (s: string) => void
  refresh: () => Promise<void>
}): React.JSX.Element {
  const { info, logs, extractions, reminders, say, refresh } = props
  const run = async (fn: () => Promise<string>): Promise<void> => {
    try {
      say(await fn())
    } catch (e) {
      say('Error: ' + (e as Error).message)
    }
    await refresh()
  }
  return (
    <>
      <section className="rounded-2xl bg-white/70 p-3 text-[11px] flex flex-col gap-1">
        {info && (
          <>
            <Row k="AI" v={info.ai.hasKey ? `${info.ai.provider} / ${info.ai.model}` : 'no key'} />
            <Row k="DB" v={info.dbPath} />
            <Row k="Zone" v={info.timezone} />
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={info.openAtLogin}
                onChange={(e) =>
                  run(async () => ((await window.api.setOpenAtLogin(e.target.checked)) ? 'Starts with Windows' : 'Will not start with Windows'))
                }
              />
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
      <section className="rounded-2xl bg-white/70 p-3 flex flex-col min-h-0 flex-1">
        <h2 className="text-xs font-medium text-stone-600 mb-1">Scheduler log</h2>
        <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-0.5 flex-1">
          {logs.map((l) => (
            <li key={l.id} className={levelColor[l.level] ?? ''}>
              <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span> <span className="font-semibold">{l.event}</span>
              {l.detail && <span> — {l.detail}</span>}
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-2xl bg-white/70 p-3 flex flex-col min-h-0 max-h-[30%]">
        <h2 className="text-xs font-medium text-stone-600 mb-1">Extractions (model proposed → applied?)</h2>
        <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-1">
          {extractions.length === 0 && <li className="text-stone-400">None yet.</li>}
          {extractions.map((x) => (
            <li key={x.id} className={x.applied ? 'text-stone-600' : 'text-red-700'}>
              <span className="text-stone-400">{fmtLogTime(x.created_at)}</span> {x.applied ? '✓' : '✗'} {x.tools_json.slice(0, 300)}
              {x.error && <div>error: {x.error}</div>}
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-2xl bg-white/70 p-3 text-[11px] max-h-[20%] overflow-y-auto">
        <h2 className="text-xs font-medium text-stone-600 mb-1">All reminders</h2>
        {reminders.slice(0, 15).map((r) => (
          <div key={r.id} className="flex gap-2">
            <span className="w-20 shrink-0 text-stone-500">{r.state}</span>
            <span className="truncate flex-1">{r.item_title ?? 'Reminder'}</span>
            <span className="text-stone-500 whitespace-nowrap">{fmtLocal(r.fire_at_utc)}</span>
          </div>
        ))}
      </section>
    </>
  )
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg bg-[#B5836D]/15 hover:bg-[#B5836D]/30 px-2 py-0.5 text-[11px] text-[#3A2E28]"
    >
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
