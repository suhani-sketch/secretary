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
          const elapsed = now - started
          return (
            <li key={h.id} className="group flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/70">
              <MetaphorIcon metaphor={h.metaphor} stage={stage} />
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

/**
 * The metaphor as a small picture, changing with the stage: the egg's yolk sets, the tea darkens, the drum spins, the
 * plant grows, the download fills, the candle burns down. Illustration only — never a bar, never a score.
 */
function MetaphorIcon({ metaphor, stage }: { metaphor: Happening['metaphor']; stage: string | null }): React.JSX.Element {
  const box = 'w-7 h-7 shrink-0'
  if (!metaphor) {
    return (
      <svg viewBox="0 0 28 28" className={box} aria-hidden>
        <circle cx="14" cy="15" r="9" fill="#FAF6F0" stroke="#5E4636" strokeWidth="1.5" />
        <rect x="12" y="3" width="4" height="3" rx="1" fill="#5E4636" />
        <path d="M14 15 L14 9" stroke="#5E4636" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M14 15 L18 17" stroke="#B5836D" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  const stages = METAPHORS[metaphor].stages
  const i = Math.max(0, stages.indexOf(stage ?? stages[0]))
  const f = stages.length > 1 ? i / (stages.length - 1) : 1 // 0 = just begun, 1 = finished
  switch (metaphor) {
    case 'egg':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <path d="M5 16 h18 v6 a3 3 0 0 1 -3 3 h-12 a3 3 0 0 1 -3 -3 z" fill="#6E6259" />
          <rect x="4" y="14" width="20" height="3" rx="1.5" fill="#8A8078" />
          <ellipse cx="14" cy="14" rx="5" ry="6" fill="#FAF6F0" stroke="#D8CDBF" strokeWidth="0.8" />
          <circle cx="14" cy="14" r={1.5 + f * 2.2} fill={f < 0.3 ? '#F6D28A' : f < 0.7 ? '#F3B25E' : '#E9A048'} opacity={0.35 + f * 0.65} />
          {f > 0.05 && f < 1 && (
            <g fill="#FFFFFF" opacity="0.7">
              <circle cx="8" cy="18" r="0.9" />
              <circle cx="20" cy="19" r="0.7" />
            </g>
          )}
        </svg>
      )
    case 'tea':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <path d="M5 10 h15 v9 a4 4 0 0 1 -4 4 h-7 a4 4 0 0 1 -4 -4 z" fill="#FAF6F0" stroke="#5E4636" strokeWidth="1.2" />
          <path d="M20 12 q5 0 5 3.5 q0 3.5 -5 3.5" stroke="#5E4636" strokeWidth="1.2" fill="none" />
          <rect x="6.5" y="11.5" width="12" height="4" rx="1" fill={`rgba(160, 96, 48, ${0.15 + f * 0.7})`} />
          {f < 1 && <path d="M10 8 q1 -2 0 -4 M14 8 q-1 -2 0 -4" stroke="#8A8078" strokeWidth="1" fill="none" opacity="0.7" />}
          <rect x="4" y="23" width="18" height="1.5" rx="0.75" fill="#D8CDBF" />
        </svg>
      )
    case 'laundry':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <rect x="4" y="3" width="20" height="22" rx="3" fill="#E8EEF3" stroke="#8A8078" strokeWidth="1.2" />
          <circle cx="14" cy="15" r="7" fill="#AEB9CC" stroke="#5E4636" strokeWidth="1.2" />
          <circle cx="14" cy="15" r="5" fill={f >= 1 ? '#DCEBF7' : '#4F94C2'} opacity="0.85" />
          {f < 1 && <path d="M11 13 q3 -2 5 1 q-1 3 -4 2" fill="#F3B25E" transform={`rotate(${Math.round(f * 300)} 14 15)`} />}
          <circle cx="8" cy="6.5" r="1" fill="#5E4636" />
          <circle cx="11" cy="6.5" r="1" fill={f >= 1 ? '#6E9560' : '#F2A65A'} />
        </svg>
      )
    case 'plant':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <path d="M8 19 h12 l-1.5 6 h-9 z" fill="#C97C5A" />
          <ellipse cx="14" cy="19" rx="6.5" ry="1.5" fill="#7A5A44" />
          {f >= 0.3 && <path d={`M14 19 v-${4 + f * 8}`} stroke="#5F8F5A" strokeWidth="1.6" strokeLinecap="round" />}
          {f >= 0.3 && <path d={`M14 ${17 - f * 3} q-5 -3 -4 -7 q4 1 4 7`} fill="#6E9560" />}
          {f >= 0.6 && <path d={`M14 ${15 - f * 4} q5 -3 4 -7 q-4 1 -4 7`} fill="#6E9560" />}
          {f < 0.3 && <circle cx="14" cy="18" r="1.6" fill="#8B6A55" />}
          {f >= 1 && <circle cx="14" cy="6" r="2" fill="#E9A48E" />}
        </svg>
      )
    case 'download':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <path d="M8 4 h12 v4 l-5 6 l5 6 v4 h-12 v-4 l5 -6 l-5 -6 z" fill="#FAF6F0" stroke="#5E4636" strokeWidth="1.2" />
          <path d={`M9.5 5.5 h9 v${Math.max(0, 2.5 * (1 - f))} l-4.5 ${5 - 2.5 * (1 - f)} l-4.5 -${5 - 2.5 * (1 - f)} z`} fill="#C99C5A" opacity="0.9" />
          <path d={`M9.5 22.5 h9 v-${Math.max(0.3, 3 * f)} l-4.5 -${5.5 - 3 * f} l-4.5 ${5.5 - 3 * f} z`} fill="#C99C5A" opacity="0.9" />
        </svg>
      )
    case 'focus':
      return (
        <svg viewBox="0 0 28 28" className={box} aria-hidden>
          <rect x="6" y="23" width="16" height="2" rx="1" fill="#8A7B6E" />
          <rect x="10" y={9 + f * 10} width="8" height={14 - f * 10} rx="1.5" fill="#F3E9DD" stroke="#D8CDBF" strokeWidth="0.8" />
          <path d={`M14 ${9 + f * 10} v-2.5`} stroke="#5E4636" strokeWidth="1" />
          {f < 1 && <path d={`M14 ${2 + f * 10} q3 3 0 6 q-3 -3 0 -6`} fill="#F2A65A" />}
          {f < 1 && <path d={`M14 ${4.5 + f * 10} q1.3 1.5 0 3 q-1.3 -1.5 0 -3`} fill="#FFD27A" />}
        </svg>
      )
  }
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
