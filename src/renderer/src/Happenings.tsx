import { useEffect, useState } from 'react'
import type { Happening } from '../../shared/types'
import { METAPHORS, formatRemaining, stageFor } from '../../shared/happenings'

/**
 * "Right now" (spec §8 Phase 5): the living activities. Each running happening shows its metaphor stage as words — the
 * egg is "soft", the tea is "steeping" — with the exact timer underneath. No bars, no scores, nothing accumulates.
 * Finished ones linger for a few minutes, faded, then disappear. Never part of Open.
 */
export function RightNow({ happenings, onFinish }: { happenings: Happening[]; onFinish: (id: string, outcome: 'done' | 'abandoned') => void }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!happenings.length) return null
  const running = happenings.filter((h) => h.state === 'running')
  const ended = happenings.filter((h) => h.state !== 'running')
  return (
    <section className="rounded-2xl bg-[#F3EADF]/80 p-4 flex flex-col gap-2 min-h-0">
      <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Right now</h2>
      <ul className="flex flex-col gap-1.5">
        {running.map((h) => {
          const started = new Date(h.started_at).getTime()
          const ends = h.ends_at ? new Date(h.ends_at).getTime() : null
          const stage = h.metaphor ? stageFor(h.metaphor, started, ends, now) : null
          const glyph = h.metaphor ? METAPHORS[h.metaphor].glyph : '⏱️'
          const elapsed = now - started
          return (
            <li key={h.id} className="group flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/70">
              <span className="text-base leading-6">{glyph}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">
                  <span>{capital(h.label)}</span>
                  {stage && <span className="text-stone-500"> · {stage}</span>}
                </div>
                <div className="text-xs text-stone-500 tabular-nums">
                  {ends ? (now < ends ? `${formatRemaining(ends - now)} left · until ${clock(ends)}` : 'time is up') : `${formatRemaining(elapsed)} so far · since ${clock(started)}`}
                </div>
              </div>
              <button className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1" title="Done" onClick={() => onFinish(h.id, 'done')}>
                ✓
              </button>
              <button className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-red-700 px-1" title="Never mind" onClick={() => onFinish(h.id, 'abandoned')}>
                ×
              </button>
            </li>
          )
        })}
        {ended.slice(0, 3).map((h) => (
          <li key={h.id} className="flex items-center gap-2 px-1 text-xs text-stone-400">
            <span>{h.metaphor ? METAPHORS[h.metaphor].glyph : '⏱️'}</span>
            <span className="truncate">
              <span>{capital(h.label)}</span> · {h.state === 'done' ? 'done' : 'dropped'} {h.ends_at ? clock(new Date(h.ends_at).getTime()) : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
