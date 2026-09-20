/**
 * Companion positioning — pure math (Phase 2, 2026-09-19).
 *
 * The Companion is no longer rendered inside the Room panel. She lives at the app level (specifically inside the
 * merged Conversation window's outer div), positioned absolutely in pixel coordinates. This module maps her
 * "spot" (a fraction of the world panel's coordinate space, where 0..1 covers the world and >1 crosses into the
 * chat/rail regions since the outer window is overflow-hidden) plus a measured world-panel rect → the pixel
 * box the CompanionRenderer paints into.
 *
 * Kept pure and no-React so it can be tested trivially and reused when a follow-up pass adds Calendar/Things/
 * Settings surfaces (the same spot fractions can then map against a different "home" rectangle).
 */

export interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

export interface SpotLike {
  x: number
  y: number
  scale: number
}

export interface CreatureBox {
  left: number
  top: number
  width: number
}

/** Base creature width as a fraction of the world panel's width. 50% larger than the prior 46% baseline —
 *  she's a first-class presence, not a mascot in a corner. */
export const BASE_CREATURE_WIDTH_FRACTION = 0.68

/**
 * Compute the creature's absolute box inside the merged-window reference frame. `worldBounds` is the world
 * panel's rect *relative to the merged conversation window* (call getBoundingClientRect on both and subtract).
 *
 * A spot x/y in [0, 1] plants her inside the world (a chair, the rug, the window bench). A spot x > 1 pushes
 * her past the world's right edge into the chat region — this is how the roam waypoints work. Width scales
 * with the world's own width so the creature stays proportional to her environment regardless of viewport.
 */
export function computeCreatureBox(spot: SpotLike, worldBounds: Bounds): CreatureBox {
  return {
    left: worldBounds.left + spot.x * worldBounds.width,
    top: worldBounds.top + spot.y * worldBounds.height,
    width: worldBounds.width * BASE_CREATURE_WIDTH_FRACTION * spot.scale
  }
}

/**
 * Compute a rect relative to another rect. Given the outer container's bounding rect and an inner element's
 * bounding rect, return the inner's position expressed in the outer's local coordinate space.
 */
export function localRect(inner: DOMRectReadOnly | DOMRect, outer: DOMRectReadOnly | DOMRect): Bounds {
  return {
    left: inner.left - outer.left,
    top: inner.top - outer.top,
    width: inner.width,
    height: inner.height
  }
}
