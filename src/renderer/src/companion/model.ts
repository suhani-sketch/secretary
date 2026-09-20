/**
 * Companion model — one hook that owns her entire lifecycle (2026-09-19, architectural extraction).
 *
 * Before this file existed, "the creature" was scattered across App.tsx:
 *   - personality / seed / name loaded via getSetting effects
 *   - useCompanion(signals) called for pose selection
 *   - initialSpotId + handleSpotChange for last-spot continuity
 *   - roamingIdx + roam timer + nudgeHome for autonomous wandering
 *   - individual careSit/careSleep/careTea/careLook signals
 *
 * The App collected inputs, ran the state machine, managed roaming, and passed a dozen props to Room. That was
 * the "features individually" pattern the user called out. This module consolidates it: the App feeds Signals
 * and AwarenessEvents in; a CompanionModel comes out. Everything downstream reads from the model.
 *
 * This file deliberately does NOT yet implement the full attention / intention / clock system described in
 * companion/types.ts. Those need real thought and a follow-up pass — see the TODOs below. What this pass DOES
 * accomplish:
 *   1. A single place where the Companion's state lives.
 *   2. A stable public shape (CompanionModel) so surfaces don't reach into internal knobs.
 *   3. Awareness events wired through notice(); currently they map onto the existing roaming timer and momentary
 *      state signals, but future logic can replace those without disturbing the surfaces.
 *   4. Mood, intention, attention — derived from state + recent awareness. Low-fidelity for now, but present, so
 *      the Room can start rendering off them and richer inference can layer in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCompanion, type Signals, type CompanionState, type Gaze, type PersonalityWeights } from '../companionState'
import type { AwarenessEvent, CompanionAttention, CompanionIntention, CompanionModel, CompanionMood } from './types'

const NEUTRAL_PERSONALITY: PersonalityWeights = {
  readingLove: 0.25, windowLove: 0.2, rainAffinity: 0.4, sleepOffsetMinutes: 0,
  restingSpot: 'nest', expressiveness: 0.55, curiosity: 0.4
}

interface Options {
  /** Signals feed the underlying state machine (companionState.ts). App builds these from real app inputs. */
  signals: Signals
  /** Dev hook (matches App.tsx's #state:… URL forcing) — pin the creature to a specific state for screenshots. */
  force?: CompanionState | null
}

/** Derive her mood from current state + recent-awareness pressure. Deliberately narrow: most moments read as
 *  `calm`. Concerned/worried only when signals actually push there. */
function deriveMood(state: CompanionState, signals: Signals, recentEvents: AwarenessEvent[]): CompanionMood {
  if (state === 'sleepy' || state === 'sleeping') return 'sleepy'
  if (state === 'concerned' || signals.overwhelmed) return 'worried'
  if (state === 'celebrating' || state === 'quietlyExcited') return 'excited'
  if (state === 'listening' || state === 'attentive' || state === 'petted') return 'attentive'
  if (recentEvents.some((e) => e.kind === 'user_typing' || e.kind === 'user_sent_message')) return 'attentive'
  if (signals.deadlineHoursLeft !== null && signals.deadlineHoursLeft < 12) return 'worried'
  return 'calm'
}

/** Derive her attention. Follows recent awareness — if the user just did something, attention shifts toward
 *  them briefly; otherwise she's on her own activity. */
function deriveAttention(recentEvents: AwarenessEvent[], momentSignals: Signals): CompanionAttention {
  const now = Date.now()
  const recent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null
  if (recent && (recent.kind === 'user_petted' || recent.kind === 'user_sent_message' || recent.kind === 'user_typing')) {
    return { target: 'user', intensity: 0.85 }
  }
  if (momentSignals.addressedAt && now - momentSignals.addressedAt < 15_000) {
    return { target: 'user', intensity: 0.6 }
  }
  return { target: 'self', intensity: 0.4 }
}

/** Derive her intention. Currently thin — most of the time she `continue`s. Enough to expose the concept so
 *  future logic (a real companion clock, attention decisions) can drive richer transitions without touching
 *  the surface layer again. */
function deriveIntention(attention: CompanionAttention, roamingIdx: number | null, state: CompanionState): CompanionIntention {
  if (state === 'sleeping' || state === 'sleepy') return 'rest'
  if (state === 'greeting' || state === 'celebrating' || state === 'petted') return 'react'
  if (roamingIdx !== null) return 'approach'
  if (attention.target === 'user' && attention.intensity > 0.7) return 'observe'
  return 'continue'
}

/** Autonomous roaming timer. Randomized cycles: every 90–180 s she has a 75% chance of wandering to one of
 *  four waypoints for 25–55 s. Same behaviour as the previous inline implementation, moved here so the App
 *  never touches it again. */
function useRoamingCycle(): [number | null, () => void] {
  const [roamingIdx, setRoamingIdx] = useState<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      const shouldRoam = Math.random() < 0.75
      if (!shouldRoam) {
        timeoutRef.current = window.setTimeout(tick, (90 + Math.random() * 90) * 1000)
        return
      }
      const dwellMs = (25 + Math.random() * 30) * 1000
      setRoamingIdx(Math.floor(Math.random() * 4))
      timeoutRef.current = window.setTimeout(() => {
        if (cancelled) return
        setRoamingIdx(null)
        timeoutRef.current = window.setTimeout(tick, (90 + Math.random() * 90) * 1000)
      }, dwellMs)
    }
    timeoutRef.current = window.setTimeout(tick, (10 + Math.random() * 20) * 1000)
    return () => {
      cancelled = true
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
    }
  }, [])
  const nudgeHome = useCallback(() => {
    setRoamingIdx(null)
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current)
  }, [])
  return [roamingIdx, nudgeHome]
}

export function useCompanionModel({ signals, force = null }: Options): CompanionModel {
  // ---- identity ----
  const [seed, setSeed] = useState(0)
  const [name, setName] = useState<string | null>(null)
  const [personality, setPersonality] = useState<PersonalityWeights>(NEUTRAL_PERSONALITY)
  useEffect(() => {
    void window.api.getSetting('creature.seed').then((v) => {
      const n = v ? parseInt(v, 10) : 0
      if (Number.isFinite(n)) setSeed(n >>> 0)
    })
    void window.api.getSetting('creature.personality').then((v) => {
      if (!v) return
      try { setPersonality(JSON.parse(v) as PersonalityWeights) } catch { /* keep neutral */ }
    })
    void window.api.getSetting('creature.name').then((v) => { if (v) setName(v) })
  }, [])

  // ---- state machine ----
  const moment = useCompanion(signals, force, seed, personality)

  // ---- last-spot continuity ----
  const [initialSpotId, setInitialSpotId] = useState<string | null>(null)
  const lastPersistedSpotRef = useRef<string | null>(null)
  useEffect(() => {
    void window.api.getSetting('companion.last_spot').then((v) => {
      if (typeof v === 'string' && v.length > 0) setInitialSpotId(v)
    })
  }, [])
  const reportSpot = useCallback((spotId: string) => {
    if (lastPersistedSpotRef.current === spotId) return
    lastPersistedSpotRef.current = spotId
    void window.api.setSetting('companion.last_spot', spotId).catch(() => { /* best-effort */ })
  }, [])

  // ---- roaming ----
  const [roamingIdx, nudgeHome] = useRoamingCycle()

  // ---- awareness buffer ----
  const [recentEvents, setRecentEvents] = useState<AwarenessEvent[]>([])
  const notice = useCallback((event: AwarenessEvent) => {
    setRecentEvents((prev) => {
      const next = [...prev, event]
      return next.length > 8 ? next.slice(next.length - 8) : next
    })
    // A minimum reactive coupling: certain events pull her out of roaming immediately, since a real interaction
    // beats a random wander. The full attention model (companion/clock.ts, follow-up) will decide subtler
    // reactions like "shift gaze without moving" or "approach the chat area".
    if (event.kind === 'user_petted' || event.kind === 'user_returned_after_away') {
      nudgeHome()
    }
  }, [nudgeHome])
  const pet = useCallback(() => { notice({ kind: 'user_petted' }) }, [notice])

  // ---- derivations ----
  const mood = useMemo(() => deriveMood(moment.state, signals, recentEvents), [moment.state, signals, recentEvents])
  const attention = useMemo(() => deriveAttention(recentEvents, signals), [recentEvents, signals])
  const intention = useMemo(() => deriveIntention(attention, roamingIdx, moment.state), [attention, roamingIdx, moment.state])

  return {
    seed,
    name,
    personality,
    state: moment.state,
    mood,
    intention,
    attention,
    gaze: moment.gaze,
    restingSpot: personality.restingSpot,
    initialSpotId,
    roamingIdx,
    notice,
    pet,
    reportSpot
  }
}
