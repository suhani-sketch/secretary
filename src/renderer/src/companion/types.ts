/**
 * Companion — first-class application entity (2026-09-19, architectural extraction).
 *
 * The Companion is not a feature of the Room. She is a persistent presence that inhabits the whole application.
 * The World is her physical environment (available spots, furniture, lighting); Conversation is where the user
 * works with Secretary. Both layers run simultaneously. This module owns the Companion's *identity, state,
 * awareness, intention, and continuity*. The renderer surfaces read from her; the App feeds her awareness events.
 *
 * Key separation:
 *   - CompanionState (pose/animation vocabulary, unchanged from Phase 4/9b): reading, working, sleepy, awake, …
 *   - CompanionMood (this file, new): the higher emotional register underneath — calm, attentive, quiet, worried.
 *   - CompanionIntention (this file, new): what she plans to do next — continue, observe, approach, react, initiate.
 *   - CompanionAttention (this file, new): what she's currently attending to (self, user, or the world) and how
 *     strongly. This is the ingredient the earlier tactical patches were missing — the reason she looks up when
 *     the user types is because attention shifted toward user, not because a "typing" flag flipped a switch.
 *
 * Nothing about persistence, roaming, or scene-spot resolution is decided here. This file is types only.
 */

import type { CompanionState, Gaze, PersonalityWeights } from '../companionState'

/** What the creature is emotionally holding right now. Distinct from CompanionState (which is her pose) — a
 *  creature can be `reading` in state but `worried` in mood if a deadline is close. */
export type CompanionMood = 'calm' | 'attentive' | 'quiet' | 'worried' | 'sleepy' | 'excited'

/** Her plan for the next few moments. `continue` is the null hypothesis and by far the most common — she
 *  keeps doing what she's doing. `observe` is a shift of gaze without moving. `approach` moves her toward the
 *  chat or the user; `react` is a brief visible acknowledgement (a small bounce, a look up); `initiate` is
 *  the rare moment when she prompts the user (a proactive line via personality.ts). */
export type CompanionIntention = 'continue' | 'observe' | 'approach' | 'react' | 'initiate' | 'rest'

/** What she is currently attending to. `intensity` is 0..1; low intensity means her attention is on her own
 *  activity, high intensity means whatever `target` is has captured her focus. */
export interface CompanionAttention {
  target: 'self' | 'user' | 'world'
  intensity: number
}

/** Events the Companion is fed by the App. She *notices* these; she does not necessarily act on them. Her own
 *  internal clock (companion/clock.ts, follow-up) decides whether an event rises to a reaction. Kept small and
 *  concrete — every kind here corresponds to something real the app already knows about. */
export type AwarenessEvent =
  | { kind: 'user_arrived' }
  | { kind: 'user_typing' }
  | { kind: 'user_sent_message' }
  | { kind: 'assistant_replied' }
  | { kind: 'user_completed_item'; importance: 'critical' | 'high' | 'normal' | 'low' }
  | { kind: 'user_idle'; minutes: number }
  | { kind: 'deadline_approaching' }
  | { kind: 'overwhelmed' }
  | { kind: 'user_planning' }
  | { kind: 'user_petted' }
  | { kind: 'user_returned_after_away' }

/** The Companion's public model — everything a UI consumer needs to render her, plus the APIs to feed her
 *  awareness of events. This is the ONE shape App/Room/Renderer surfaces read from. */
export interface CompanionModel {
  // ---- identity (persistent across sessions via settings) ----
  seed: number
  name: string | null
  personality: PersonalityWeights

  // ---- state (currently derived from Signals + companionState.ts state machine) ----
  state: CompanionState
  mood: CompanionMood
  intention: CompanionIntention
  attention: CompanionAttention
  gaze: Gaze

  // ---- location (where she is in the world OR at a roam waypoint outside it) ----
  restingSpot: PersonalityWeights['restingSpot']
  initialSpotId: string | null   // last spot from previous session — Room honours it briefly on mount
  roamingIdx: number | null       // if non-null, she's out at a roam waypoint defined in the World layer

  // ---- APIs surfaces call ----
  /** Feed her an awareness event. She may or may not react; that's her decision. */
  notice(event: AwarenessEvent): void
  /** Direct interaction — user clicked her. */
  pet(): void
  /** Renderer tells her which spot she just landed at; she uses this for last-spot persistence. */
  reportSpot(spotId: string): void
}
