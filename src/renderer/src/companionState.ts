import { useEffect, useRef, useState } from 'react'
import type { ChatStatus } from '../../shared/types'

/**
 * The creature's state machine (spec §8 Phase 4, widened into a character system in 9b). Driven by what the app is
 * actually doing, never by a timer alone.
 *
 * Priority:  recording (voice) > process (thinking · working · writing · reading · waiting-on-throttle)
 *          > momentary (celebrating · greeting · quietly excited · happy · concerned · recovering) — fixed
 *            durations, never interrupt a process
 *          > attentive (the user is typing)
 *          > ambient (sleepy/sleeping at night · a slow "life of its own" rotation between idle poses)
 * Every state has a minimum dwell so nothing flickers. `awake` is a special fifth case, inserted by `useCompanion`
 * itself (not this priority list) as a brief bridge whenever something real interrupts sleepy/sleeping — it is
 * never something `resolveState` picks on its own.
 */

export type CompanionState =
  | 'idle'
  | 'awake'
  | 'attentive'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'reading'
  | 'writing'
  | 'looking'
  | 'waiting'
  | 'happy'
  | 'quietlyExcited'
  | 'concerned'
  | 'sleepy'
  | 'sleeping'
  | 'celebrating'
  | 'greeting'
  | 'recovering'
  | 'stretching'
  | 'tea'
  | 'petted'

/** Where the creature looks. Eye contact ("viewer") is rare and meaningful. */
export type Gaze = 'viewer' | 'away' | 'desk' | 'window' | 'closed'

export interface Signals {
  chat: ChatStatus
  typing: boolean
  /** A voice recording is in progress (Phase 7 "Voice") — the creature watches, it does not just sit attentive. */
  recording: boolean
  /** Tool names applied by the most recent round (to tell writing/reading from working). */
  lastToolNames: string[]
  lastAppliedAt: number
  celebrateAt: number
  /** A small, ordinary completion — a task ticked off, a wait resolved — never as much as a full celebration. */
  quietlyExcitedAt: number
  /** The user clicked/petted the creature directly (9d) — interaction for its own sake, no functional purpose. */
  pettedAt: number
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

const DUR = { celebrating: 2600, greeting: 2400, happy: 1400, quietlyExcited: 1800, petted: 1700, concerned: 6000, recovering: 1400, awake: 1200 }
const MIN_DWELL = 700
/** Ambient pose rotation: one change every 3–6 minutes, deterministic per slot so a re-render never jumps. */
const AMBIENT_SLOT_MS = 4 * 60 * 1000
/** Sparse flourishes layered on top of the slot-level pose (9c) — re-rolled far more often than the slot itself,
 *  but each only WINS for a short window within its own slot, so they read as a brief aside, not a new activity. */
const FLOURISH_SLOT_MS = 90 * 1000

const READ_TOOLS = /^(get_|search_)/
const WRITE_TOOLS = /^(add_note|update_note|record_activity|create_waiting)$/

/** States the ambient rotation itself can choose — a real interruption of any of the OTHER states while asleep is
 *  what earns the brief `awake` bridge; the rotation moving itself from sleepy to idle at 6 a.m. does not. */
const AMBIENT_STATES = new Set<CompanionState>(['idle', 'looking', 'reading', 'working', 'sleepy', 'sleeping', 'tea', 'stretching'])

/** Personality vector (the "attachment" reshape): each creature has its own tastes, seeded once and forever, and
 *  they nudge the ambient rotation's weights so the same room reliably feels different across users. Defaults are
 *  the neutral midpoint of every range so a null/missing personality behaves identically to the old rotation. */
export interface PersonalityWeights {
  readingLove: number // 0.15..0.40
  windowLove: number // 0.10..0.30
  rainAffinity: number
  sleepOffsetMinutes: number // -90..+90
  restingSpot: 'nest' | 'armchair' | 'bench' | 'rug'
  expressiveness: number
  curiosity: number
}
const NEUTRAL_PERSONALITY: PersonalityWeights = { readingLove: 0.25, windowLove: 0.2, rainAffinity: 0.4, sleepOffsetMinutes: 0, restingSpot: 'nest', expressiveness: 0.55, curiosity: 0.4 }

function ambientPose(now: number, waitingOpen: number, hour: number, seed: number, p: PersonalityWeights): CompanionState {
  const slot = Math.floor(now / AMBIENT_SLOT_MS)
  // Hash includes the personality seed — every creature has its own rotation sequence, deterministic per (slot, seed).
  const r = ((slot * 2654435761 + seed * 2246822519) >>> 0) % 100
  // Sleep-timing drift: a positive offset means "this one stays up later", a negative one "this one goes to bed
  // earlier". The offset shifts the calendar hour we use for the night gate, without reshaping the overall shape.
  const shiftedHour = ((hour * 60 + p.sleepOffsetMinutes + 24 * 60) % (24 * 60)) / 60
  if (shiftedHour >= 1 && shiftedHour < 5) return r < 92 ? 'sleeping' : 'sleepy'
  if (shiftedHour >= 22 || shiftedHour < 6) return r < 80 ? 'sleepy' : 'idle'
  if (shiftedHour < 8) return r < 45 ? 'sleepy' : 'idle'
  // Daytime rotation, weighted by personality. Reading and window-love are the two most character-defining traits,
  // so they're what earns the largest range in the vector. Everything else compresses proportionally.
  const readingThresh = 50 + p.readingLove * 100 // ~65..90
  const windowThresh = readingThresh + p.windowLove * 100 // adds ~10..30 more window pull
  if (waitingOpen > 0 && r < 35 * (1 + p.readingLove)) return 'reading'
  if (r < 50 - p.readingLove * 20) return 'idle'
  if (r < readingThresh) return 'reading'
  if (r < windowThresh) return 'looking' // gazing out the window, for no particular reason
  if (r < windowThresh + 8) return 'working' // tidying at the desk
  if (r < windowThresh + 13) return 'tea' // decided to make tea, entirely on its own — no task, no happening row, just the room
  return 'idle'
}

/** A short, low-probability window inside its own re-roll period — the mechanism behind both flourishes below.
 *  `seed` keeps the two independent so they don't always coincide or always avoid each other. */
function inFlourishWindow(now: number, seed: number, chancePct: number, windowMs: number): boolean {
  const slot = Math.floor(now / FLOURISH_SLOT_MS)
  const r = ((slot * 2654435761 + seed * 97) >>> 0) % 100
  return r < chancePct && now % FLOURISH_SLOT_MS < windowMs
}

export function resolveState(s: Signals, now: number, seed = 0, personality: PersonalityWeights = NEUTRAL_PERSONALITY): { state: CompanionState; gaze: Gaze } {
  // 0. Recording outranks everything — you are actively speaking to it.
  if (s.recording) return { state: 'listening', gaze: 'viewer' }
  // 1. Process states — the app is doing something right now.
  if (s.chat.kind === 'thinking') return { state: 'thinking', gaze: 'away' }
  if (s.chat.kind === 'throttled') return { state: 'waiting', gaze: 'window' }
  if (s.chat.kind === 'tools') {
    const names = s.lastToolNames
    if (names.length && names.every((n) => READ_TOOLS.test(n))) return { state: 'reading', gaze: 'desk' }
    if (names.some((n) => WRITE_TOOLS.test(n))) return { state: 'writing', gaze: 'desk' }
    return { state: 'working', gaze: 'desk' }
  }
  // 2. Momentary states with fixed durations — biggest news wins when more than one is still live.
  if (now - s.celebrateAt < DUR.celebrating) return { state: 'celebrating', gaze: 'viewer' }
  if (now - s.greetAt < DUR.greeting) return { state: 'greeting', gaze: 'viewer' }
  // Direct interaction (9d) — clicking it is deliberate, so it outranks the ordinary "something happened" blips
  // below, but never a real process or genuine news (celebrating/greeting already returned above this).
  if (now - s.pettedAt < DUR.petted) return { state: 'petted', gaze: 'viewer' }
  if (now - s.quietlyExcitedAt < DUR.quietlyExcited) return { state: 'quietlyExcited', gaze: now - s.addressedAt < 15000 ? 'viewer' : 'away' }
  if (now - s.lastAppliedAt < DUR.happy) return { state: 'happy', gaze: now - s.addressedAt < 15000 ? 'viewer' : 'away' }
  if (now - s.concernedAt < DUR.concerned) return { state: 'concerned', gaze: 'desk' }
  // A brief settling moment right after concern passes — never snap straight back to neutral.
  if (now - s.concernedAt < DUR.concerned + DUR.recovering) return { state: 'recovering', gaze: 'away' }
  // 3. Attention.
  if (s.typing) return { state: 'attentive', gaze: now - s.addressedAt < 15000 ? 'viewer' : 'away' }
  // 4. The room reflects what is happening (Phase 5): these replace the ambient rotation while something runs.
  if (s.happening === 'focus') return { state: 'working', gaze: 'desk' }
  if (s.happening === 'cooking') return { state: 'idle', gaze: 'away' } // the Room places 'idle' beside the kitchen object
  if (s.happening === 'waiting') return { state: 'reading', gaze: 'desk' }
  // 5. Ambient life — independent of anything the user did (spec 9c). The slot-level rotation above picks the
  //    "activity"; these two are brief, sparse asides layered on top of it, each reverting to that activity on its
  //    own once its short window passes. Neither is attention-seeking: a stretch does not pause for acknowledgement,
  //    and the glance below is a look, not a request.
  const pose = ambientPose(now, s.waitingOpen, s.hour, seed, personality)
  if ((pose === 'idle' || pose === 'working') && inFlourishWindow(now, 17, 6, 2500)) return { state: 'stretching', gaze: 'away' }
  if (pose === 'idle' && inFlourishWindow(now, 41, 8, 1600)) return { state: 'idle', gaze: 'viewer' } // looks toward the user, then back to what it was doing
  const gaze: Gaze = pose === 'sleepy' || pose === 'sleeping' ? 'closed' : pose === 'reading' || pose === 'working' ? 'desk' : pose === 'looking' ? 'window' : 'away'
  return { state: pose, gaze }
}

const EYE_CONTACT = new Set<CompanionState>(['greeting', 'celebrating', 'happy', 'quietlyExcited', 'listening', 'petted'])

export function useCompanion(signals: Signals, force?: CompanionState | null, seed = 0, personality: PersonalityWeights = NEUTRAL_PERSONALITY): { state: CompanionState; gaze: Gaze } {
  const [out, setOut] = useState<{ state: CompanionState; gaze: Gaze }>({ state: 'idle', gaze: 'away' })
  const lastChange = useRef(0)
  // Tracks what was actually SHOWN last (not the raw signal), so the awake bridge below can tell "we were just
  // asleep" reliably without depending on a stale closure over `out`.
  const lastShown = useRef<CompanionState>('idle')
  const awakeUntil = useRef(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      const now = Date.now()
      let next: { state: CompanionState; gaze: Gaze }
      if (force) {
        next = { state: force, gaze: (EYE_CONTACT.has(force) ? 'viewer' : force === 'sleepy' || force === 'sleeping' ? 'closed' : force === 'looking' || force === 'waiting' ? 'window' : 'away') as Gaze }
      } else {
        const raw = resolveState(signals, now, seed, personality)
        const wasAsleep = lastShown.current === 'sleepy' || lastShown.current === 'sleeping'
        // A real interruption of sleep (anything the ambient rotation would not have picked on its own) earns a
        // brief "waking up" moment first — it is never appropriate to snap straight from curled-up-asleep to
        // mid-conversation. The rotation moving itself on from sleepy at dawn is not an interruption; it is ignored.
        if (wasAsleep && !AMBIENT_STATES.has(raw.state) && awakeUntil.current === 0) awakeUntil.current = now + DUR.awake
        if (awakeUntil.current && now < awakeUntil.current) {
          next = { state: 'awake', gaze: 'away' }
        } else {
          if (awakeUntil.current) awakeUntil.current = 0
          next = raw
        }
      }
      const sinceChange = now - lastChange.current
      setOut((cur) => {
        if (cur.state === next.state && cur.gaze === next.gaze) return cur
        if (sinceChange < MIN_DWELL) {
          timer = setTimeout(tick, MIN_DWELL - sinceChange + 10)
          return cur
        }
        lastChange.current = now
        lastShown.current = next.state
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
  }, [signals.chat.kind, signals.typing, signals.recording, signals.lastAppliedAt, signals.celebrateAt, signals.quietlyExcitedAt, signals.pettedAt, signals.greetAt, signals.addressedAt, signals.concernedAt, signals.waitingOpen, signals.hour, signals.happening, signals.lastToolNames.join(','), force, seed, personality.readingLove, personality.windowLove, personality.sleepOffsetMinutes])

  return out
}
