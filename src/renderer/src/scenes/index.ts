import type { SceneDefinition } from './SceneDefinition'
import { LIBRARY_SCENE } from './library'

/**
 * Scene registry. ONLY scenes whose illustrated assets exist on disk register here. Every other scene id
 * (trees / rain / coast / winter / fireplace, and library too if its assets are missing) falls back to the
 * legacy inline-SVG Room.tsx implementation.
 *
 * This is the switch that keeps the "keep all existing non-Library scenes working exactly as before" invariant
 * true: sceneWithAssets returns null for anything not explicitly listed, and Room.tsx renders its existing SVG
 * composition unchanged.
 */

const REGISTRY: Record<string, SceneDefinition> = {
  library: LIBRARY_SCENE
}

export function sceneWithAssets(id: string): SceneDefinition | null {
  return REGISTRY[id] ?? null
}

export { LIBRARY_SCENE }
export type { SceneDefinition, WorldContext, SceneSpot, SceneActivityKind, SceneBehaviorWeights } from './SceneDefinition'
