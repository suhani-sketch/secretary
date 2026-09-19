/**
 * Scene / World system types (product-thesis reshape — world redesign, 2026-09-19).
 *
 * A scene is a complete self-contained environment: illustrated background + optional foreground overlay layer +
 * lighting model + creature behaviour weights + creature spots + ambient effect specs + palette. The renderer
 * loads a SceneDefinition and produces the layered composition. The state machine reads the scene's behaviour
 * weights to bias the ambient rotation to what belongs in this world.
 *
 * Only scenes that HAVE their illustrated assets on disk register here; every other scene continues to render
 * via the legacy inline-SVG room (unchanged). This means turning on the illustrated Library world does not
 * change what happens for a user still on Sunny/Rain/Beach/Winter/Fireplace — those keep their current behaviour
 * exactly, per the "keep all existing non-Library scenes working exactly as before" constraint.
 */

export type SceneActivityKind =
  | 'idle'
  | 'reading'
  | 'writing'
  | 'working'
  | 'looking'
  | 'sleepy'
  | 'sleeping'
  | 'tea'
  | 'stretching'
  | 'wandering'
  | 'browsing'
  | 'attentive'

export type SceneGaze = 'viewer' | 'book' | 'window' | 'desk' | 'away' | 'closed' | 'away-up'

/** Fractional coordinates (0..1) of the master illustration. Independent of panel size. */
export interface SceneSpot {
  id: string
  x: number
  y: number
  scale: number
  activity: SceneActivityKind
  /** Which furniture piece this spot sits on/at, purely informational. */
  furniture: string | null
  gaze: SceneGaze
  /**
   * Occlusion is fully verified against the produced foreground layer for THIS spot.
   * When false, the spot works visually but a future foreground iteration may adjust the coordinates.
   * When 'incomplete-until-foreground-final', we know occlusion cannot be trusted yet.
   */
  occlusionState: 'verified' | 'pending' | 'incomplete-until-foreground-final'
}

export interface SceneLampSource {
  id: string
  x: number
  y: number
  radius: number
  color: string
  intensity: number
}

export interface SceneLightBandOverride {
  ambientTint: string
  lampIntensity: number
}

export interface SceneLighting {
  lamps: SceneLampSource[]
  lightBands: {
    morning: SceneLightBandOverride
    day: SceneLightBandOverride
    evening: SceneLightBandOverride
    night: SceneLightBandOverride
  }
}

export type SceneAmbientSpec =
  | {
      id: string
      layer: 'behind-creature' | 'in-front-of-creature'
      kind: 'svg'
      assetUrl: string
      showInBands: ('morning' | 'day' | 'evening' | 'night')[]
      alwaysOn: boolean
      opacity: number
    }
  | {
      id: string
      layer: 'behind-creature' | 'in-front-of-creature'
      kind: 'css-flicker'
      target: 'lamp-halos'
      showInBands: ('morning' | 'day' | 'evening' | 'night')[]
      alwaysOn: boolean
      amplitude: number
      periodMs: number
    }

export interface ScenePalette {
  world: string
  wall?: string
  floor?: string
  accent: string
  warmLamp: string
  shadow: string
  surface: string
}

/** Behaviour weights the ambient rotation reads in place of the personality-neutral defaults. */
export interface SceneBehaviorWeights {
  /** Sum should be approximately 1.0. Missing keys default to 0 (that activity does not occur in this scene). */
  weights: Partial<Record<SceneActivityKind, number>>
  /** How long each ambient state lingers, multiplied against the base slot length. > 1 = calmer, < 1 = livelier. */
  dwellMultiplier: number
  /** Small text hint for future voice styling — no code path uses this today. */
  speechToneHints: string
}

export interface SceneAssets {
  /** URL served via the `scene://` protocol, e.g. "scene://library/library.background.png". */
  background: string
  /** Optional foreground layer above the creature. Null → no foreground for this scene. */
  foreground: string | null
  /** Optional reference master, purely for documentation / future re-derivation. Not rendered. */
  reference: string | null
}

export interface SceneDefinition {
  id: string
  displayName: string
  emoji: string
  master: { width: number; height: number }
  assets: SceneAssets
  palette: ScenePalette
  lighting: SceneLighting
  ambient: SceneAmbientSpec[]
  spots: SceneSpot[]
  behavior: SceneBehaviorWeights
  /** Maps personality.restingSpot → a spot id in this scene, so a creature seeded with 'armchair' still has
   *  a natural idle location even in a room that has no armchair. Missing keys default to `rug-center` if present,
   *  otherwise the first spot in `spots`. */
  restingSpotMap: Partial<Record<'nest' | 'armchair' | 'bench' | 'rug', string>>
}

/**
 * The runtime world state. Derived from the current scene + real clock + weather + creature state. Read by both
 * the SceneRenderer (to draw the layered composition) and by the ambient rotation (to bias activity selection).
 */
export interface WorldContext {
  scene: SceneDefinition
  lightBand: 'morning' | 'day' | 'evening' | 'night'
  /** Non-null while a scene crossfade is running. */
  transition: {
    from: SceneDefinition
    startedAt: number
    durationMs: number
  } | null
}
