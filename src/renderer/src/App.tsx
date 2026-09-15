import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, Item, Reminder, SchedulerLogEntry } from '../../shared/types'

const fmtLocal = (utcIso: string | null): string =>
  utcIso
    ? new Date(utcIso).toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '—'

const fmtLogTime = (utcIso: string): string =>
  new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const stateColor: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-900',
  delivered: 'bg-emerald-100 text-emerald-900',
  acknowledged: 'bg-stone-200 text-stone-700',
  snoozed: 'bg-sky-100 text-sky-900',
  cancelled: 'bg-stone-100 text-stone-500 line-through'
}

const levelColor: Record<string, string> = {
  info: 'text-stone-600',
  warn: 'text-amber-700 font-medium',
  error: 'text-red-700 font-semibold'
}

export default function App(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [logs, setLogs] = useState<SchedulerLogEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [title, setTitle] = useState('')
  const [remindAt, setRemindAt] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [i, r, l, a] = await Promise.all([
        window.api.listItems(),
        window.api.listReminders(),
        window.api.listLog(50),
        window.api.getAppInfo()
      ])
      setItems(i)
      setReminders(r)
      setLogs(l)
      setInfo(a)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.api.onChanged(() => void refresh())
    const t = setInterval(() => void refresh(), 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])

  const say = (msg: string): void => {
    setFlash(msg)
    setError(null)
    setTimeout(() => setFlash(null), 5000)
  }

  const run = async (fn: () => Promise<string>): Promise<void> => {
    try {
      say(await fn())
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      const res = await window.api.createItem({ title, remindAtLocal: remindAt || null })
      setTitle('')
      setRemindAt('')
      return res.reminder
        ? `Saved "${res.item.title}" with a reminder for ${fmtLocal(res.reminder.fire_at_utc)}`
        : `Saved "${res.item.title}" (no reminder)`
    })
  }

  const pending = reminders.filter((r) => r.state === 'pending')

  return (
    <div className="h-full grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 p-6 overflow-hidden">
      {/* LEFT: input + data */}
      <div className="flex flex-col gap-5 overflow-y-auto pr-1">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Secretary</h1>
          <span className="text-xs text-stone-500">
            Phase 0 skeleton · scheduler ticks every {info ? info.schedulerIntervalMs / 1000 : '?'}s
          </span>
        </header>

        <form onSubmit={submit} className="rounded-2xl bg-white/70 shadow-sm p-4 flex flex-col gap-3">
          <label className="text-sm text-stone-600">What should I remember?</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Call the bank"
            className="rounded-xl bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-[#B5836D]/40"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-stone-600">Remind me at</label>
            <input
              type="datetime-local"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
              className="rounded-xl bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#B5836D]/40"
            />
            <button
              type="submit"
              disabled={!title.trim()}
              className="ml-auto rounded-xl bg-[#3A2E28] text-[#FAF6F0] px-4 py-2 text-sm disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <span className="text-xs text-stone-500 self-center">Quick tests:</span>
            <Btn
              onClick={() =>
                run(async () => {
                  const r = await window.api.createTestReminder(1)
                  return `Test reminder set for ${fmtLocal(r.fire_at_utc)} (fires within 30s of that)`
                })
              }
            >
              +1 min
            </Btn>
            <Btn
              onClick={() =>
                run(async () => {
                  const r = await window.api.createTestReminder(5)
                  return `Test reminder set for ${fmtLocal(r.fire_at_utc)}`
                })
              }
            >
              +5 min
            </Btn>
            <Btn
              onClick={() =>
                run(async () => {
                  await window.api.createTestReminder(-10)
                  return 'Past-dated reminder created. It should be delivered as missed right away.'
                })
              }
            >
              10 min in the past
            </Btn>
            <Btn
              onClick={() =>
                run(async () => {
                  await window.api.sendTestNotification()
                  return 'Test toast requested. Check the log for notify.shown.'
                })
              }
            >
              Test toast
            </Btn>
          </div>
          {flash && <p className="text-sm text-emerald-800">{flash}</p>}
          {error && <p className="text-sm text-red-700">Error: {error}</p>}
        </form>

        <section>
          <h2 className="text-sm font-medium text-stone-600 mb-2">Reminders ({pending.length} pending)</h2>
          <ul className="flex flex-col gap-1.5">
            {reminders.length === 0 && <li className="text-sm text-stone-400">None yet.</li>}
            {reminders.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-xl bg-white/60 px-3 py-2 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs ${stateColor[r.state] ?? ''}`}>{r.state}</span>
                <span className="truncate flex-1">{r.item_title ?? 'Reminder'}</span>
                <span className="text-stone-500 whitespace-nowrap">{fmtLocal(r.fire_at_utc)}</span>
                {r.delivered_at && (
                  <span className="text-xs text-stone-400 whitespace-nowrap">delivered {fmtLocal(r.delivered_at)}</span>
                )}
                {(r.state === 'pending' || r.state === 'delivered') && (
                  <button
                    onClick={() =>
                      run(async () => {
                        await window.api.cancelReminder(r.id)
                        return 'Reminder cancelled'
                      })
                    }
                    className="text-xs text-stone-500 hover:text-red-700"
                  >
                    cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-medium text-stone-600 mb-2">Items</h2>
          <ul className="flex flex-col gap-1.5">
            {items.length === 0 && <li className="text-sm text-stone-400">Nothing saved yet.</li>}
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 rounded-xl bg-white/60 px-3 py-2 text-sm">
                <span className={`truncate flex-1 ${it.status === 'done' ? 'line-through text-stone-400' : ''}`}>
                  {it.title}
                </span>
                <span className="text-xs text-stone-400">{it.kind}</span>
                {it.status === 'open' && (
                  <button
                    onClick={() =>
                      run(async () => {
                        await window.api.completeItem(it.id)
                        return `Done: "${it.title}"`
                      })
                    }
                    className="text-xs text-stone-500 hover:text-emerald-700"
                  >
                    done
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* RIGHT: debug log + app info */}
      <div className="flex flex-col gap-4 overflow-hidden">
        <section className="rounded-2xl bg-white/70 shadow-sm p-4 text-xs flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-stone-600">App</h2>
            {info && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={info.openAtLogin}
                  onChange={(e) =>
                    run(async () => {
                      const actual = await window.api.setOpenAtLogin(e.target.checked)
                      return actual ? 'Secretary will start with Windows' : 'Secretary will NOT start with Windows'
                    })
                  }
                />
                Start with Windows
              </label>
            )}
          </div>
          {info && (
            <>
              <Row k="Database" v={info.dbPath} />
              <Row k="Time zone" v={info.timezone} />
              <Row k="Electron" v={info.electron} />
              <Row k="Started hidden" v={String(info.startedHidden)} />
              <Row k="Startup command" v={`"${info.execPath}" "${info.appPath}" --hidden`} />
            </>
          )}
        </section>

        <section className="rounded-2xl bg-white/70 shadow-sm p-4 flex flex-col min-h-0 flex-1">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-stone-600">Scheduler log (last 50)</h2>
            <button
              onClick={() =>
                run(async () => {
                  await window.api.clearLog()
                  return 'Log cleared'
                })
              }
              className="text-xs text-stone-500 hover:text-red-700"
            >
              clear
            </button>
          </div>
          <ol className="overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-0.5">
            {logs.length === 0 && <li className="text-stone-400">Empty.</li>}
            {logs.map((l) => (
              <li key={l.id} className={levelColor[l.level] ?? ''}>
                <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span>{' '}
                <span className="font-semibold">{l.event}</span>
                {l.detail && <span> — {l.detail}</span>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg bg-[#B5836D]/15 hover:bg-[#B5836D]/30 px-2.5 py-1 text-xs text-[#3A2E28]"
    >
      {children}
    </button>
  )
}

function Row({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-stone-500 w-28 shrink-0">{k}</span>
      <span className="break-all select-all">{v}</span>
    </div>
  )
}
