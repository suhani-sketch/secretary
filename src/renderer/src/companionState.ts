import { useEffect, useRef, useState } from 'react'
import type { ChatStatus } from '../../shared/types'

/**
 * The creature's state machine (spec §8 Phase 4). Driven by what the app is actually doing, never by a timer alone.
 *
 * Priority:  process (thinking · working · writing · reading · waiting-on-throttle)
 *          > momentary (celebrating · greeting · happy · concerned)   — fixed durations, never interrupt a process
 *          > attentive (the user is typing)
 *          > ambient (sleepy at night · a slow "life of its own" rotation between idle poses)
 * Every state has a minimum dwell so nothing flickers.
 */

export type CompanionState =
  | 'idle'
  | 'attentive'
  | 'thinking'
  | 'working'
  | 'reading'
  | 'writing'
  | 'waiting'
  | 'happy'
  | 'concerned'
  | 'sleepy'
  | 'celebrating'
  | 'greeting'

/** Where the creature looks. Eye contact ("viewer") is rare and meaningful. */
export type Gaze = 'viewer' | 'away' | 'desk' | 'window' | 'closed'

export interface Signals {
  chat: ChatStatus
  typing: boolean
  /** Tool names applied by the most recent round (to tell writing/reading from working). */
  lastToolNames: string[]
  lastAppliedAt: number
  celebrateAt: number
  greetAt: number
  /** The user spoke to the creature directly ("hey", "thank you", "you"). */
  addressedAt: number
  /** Something went wrong or overdue count rose — a brief concerned moment, never a permanent frown. */
  concernedAt: number
  /** Open waiting items — the creature tends to read while you wait on others. */
  waitingOpen: number
  hour: number
  /**
   * Living activities (Phase 5): what is happening in the room right now. focus → it works at the desk; cooking → it waits
   * beside the kitchen object (the Room turns 'idle' into the kitchen pose); waiting (a wash, a charge, a download) → it reads.
   * null → nothing is happening and it simply exists.
   */
  happening: 'focus' | 'cooking' | 'waiting' | null
}

const DUR = { celebrating: 2600, greeting: 2400, happy: 1400, concerned: 6000 }
const MIN_DWELL = 700
/** Ambient pose rotation: one change every 3–6 minutes, deterministic per slot so a re-render never jumps. */
const AMBIENT_SLOT_MS = 4 * 60 * 1000

const READ_TOOLS = /^(get_|search_)/
const WRITE_TOOLS = /^(add_note|update_note|record_activity|create_waiting)$/

function ambientPose(now: number, waitingOpen: number, hour: number): CompanionState {
  const slot = Math.floor(now / AMBIENT_SLOT_MS)
  // A tiny hash so the sequence feels unplanned but is stable within a slot.
  const r = ((slot * 2654435761) >>> 0) % 100
  if (hour >= 22 || hour < 6) return r < 85 ? 'sleepy' : 'idle'
  if (hour < 8) return r < 50 ? 'sleepy' : 'idle'
  if (waitingOpen > 0 && r < 35) return 'reading'
  if (r < 55) return 'idle'
  if (r < 75) return 'reading'
  if (r < 90) return 'waiting' // looking out of the window
  return 'working' // tidying at the desk
}

export function resolveState(s: Signals, now: number): { state: CompanionState; gaze: Gaze } {
  // 1. Process states — the app is doing something right now.
  if (s.chat.kind === 'thinking') return { state: 'thinking', gaze: 'away' }
  if (s.chat.kind === 'throttled') return { state: 'waiting', gaze: 'window' }
  if (s.chat.kind === 'tools') {
    const names = s.lastToolNames
    if (names.length && names.every((n) => READ_TOOLS.test(n))) return { state: 'reading', gaze: 'desk' }
    if (names.some((n) => WRITE_TOOLS.test(n))) return { state: 'writing', gaze: 'desk' }
    return { state: 'working', gaze: 'desk' }
  }
  // 2. Momentary states with fixed durations.
  if (now - s.celebrateAt < DUR.celebrating) return { state: 'celebrating', gaze: 'viewer' }
  if (now - s.greetAt < DUR.greeting) return { state: 'greeting', gaze: 'viewer' }
  if (now - s.lastAppliedAt < DUR.happy) return { state: 'happy', gaze: now - s.addressedAt < 15000 ? 'viewer' : 'away' }
  if (now - s.concernedAt < DUR.concerned) return { state: 'concerned', gaze: 'desk' }
  // 3. Attention.
  if (s.typing) return { state: 'attentive', gaze: now - s.addressedAt < 15000 ? 'viewer' : 'away' }
  // 4. The room reflects what is happening (Phase 5): these replace the ambient rotation while something runs.
  if (s.happening === 'focus') return { state: 'working', gaze: 'desk' }
  if (s.happening === 'cooking') return { state: 'idle', gaze: 'away' } // the Room places 'idle' beside the kitchen object
  if (s.happening === 'waiting') return { state: 'reading', gaze: 'desk' }
  // 5. Ambient life.
  const pose = ambientPose(now, s.waitingOpen, s.hour)
  const gaze: Gaze = pose === 'sleepy' ? 'closed' : pose === 'reading' || pose === 'working' ? 'desk' : pose === 'waiting' ? 'window' : 'away'
  return { state: pose, gaze }
}

export function useCompanion(signals: Signals, force?: CompanionState | null): { state: CompanionState; gaze: Gaze } {
  const [out, setOut] = useState<{ state: CompanionState; gaze: Gaze }>({ state: 'idle', gaze: 'away' })
  const lastChange = useRef(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      const now = Date.now()
      const next = force ? { state: force, gaze: (force === 'greeting' || force === 'celebrating' || force === 'happy' ? 'viewer' : force === 'sleepy' ? 'closed' : 'away') as Gaze } : resolveState(signals, now)
      const sinceChange = now - lastChange.current
      setOut((cur) => {
        if (cur.state === next.state && cur.gaze === next.gaze) return cur
        if (sinceChange < MIN_DWELL) {
          timer = setTimeout(tick, MIN_DWELL - sinceChange + 10)
          return cur
        }
        lastChange.current = now
        return next
      })
    }
    tick()
    // Momentary states expire on their own; re-evaluate on a slow heartbeat too so the ambient life moves on.
    const heartbeat = setInterval(tick, 1000)
    return () => {
      clearInterval(heartbeat)
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals.chat.kind, signals.typing, signals.lastAppliedAt, signals.celebrateAt, signals.greetAt, signals.addressedAt, signals.concernedAt, signals.waitingOpen, signals.hour, signals.happening, signals.lastToolNames.join(','), force])

  return out
}
