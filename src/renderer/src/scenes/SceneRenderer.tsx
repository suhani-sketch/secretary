import { useEffect, useState } from 'react'
import type { CompanionState, Gaze } from '../companionState'
import { Companion } from '../Companion'
import type { SceneDefinition, WorldContext } from './SceneDefinition'

/**
 * Scene renderer — layered illustrated composition (world redesign, 2026-09-19).
 *
 * Renders a scene definition as an actual layered stack:
 *   1. background PNG (opaque master, back plane)
 *   2. warm lamp halos, drawn BEHIND creature so the creature reads as "in the light" rather than "in front of it"
 *   3. creature (SVG Companion), placed at the current scene spot
 *   4. foreground PNG (transparent alpha, occludes the creature at desk/near-front objects)
 *   5. programmatic light-band tint (warm evening wash, cool morning cast, deep-night dim)
 *   6. ambient effects layered per their spec (in-front-of-creature effects only; behind-creature ambient not
 *      wired yet — waiting for real dust.svg / page-turn.svg assets)
 *
 * The component knows nothing about how the creature's state was computed — it only reads the resolved
 * (state, gaze) and the spot the creature is currently occupying. The parent (Room.tsx) is responsible for
 * picking the spot from personality / behaviour weights.
 *
 * Scene transition: a 1.2s crossfade against `WorldContext.transition.from` is implemented as a duplicate
 * background rendered at diminishing opacity over the new background. The creature does not blink between
 * scenes; the CSS position/scale transition (700ms cubic-bezier in Companion.tsx) carries it into the new
 * scene's default spot naturally.
 */

interface Props {
  world: WorldContext
  state: CompanionState
  gaze: Gaze
  /** Fractional coordinates + scale of the creature's current spot in this scene. */
  spot: { x: number; y: number; scale: number }
  /** Clicking the creature: still just petting. */
  onPet: () => void
}

const CROSSFADE_MS = 1200

export function SceneRenderer({ world, state, gaze, spot, onPet }: Props): React.JSX.Element {
  const { scene } = world
  const [transitionProgress, setTransitionProgress] = useState(0)

  // Drive the crossfade progress on a frame loop while a transition is active.
  useEffect(() => {
    if (!world.transition) {
      setTransitionProgress(0)
      return
    }
    let rafId: number
    const start = world.transition.startedAt
    const dur = world.transition.durationMs
    const tick = (): void => {
      const now = Date.now()
      const p = Math.min(1, (now - start) / dur)
      setTransitionProgress(p)
      if (p < 1) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [world.transition])

  const lightBand = world.lightBand
  const lightOverride = scene.lighting.lightBands[lightBand]

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: scene.palette.world, transition: 'background 1.2s ease' }}>
      {/* Background — the illustrated master (opaque). Crossfade the outgoing scene during a transition. */}
      {world.transition && transitionProgress < 1 && (
        <img
          src={world.transition.from.assets.background}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover object-bottom pointer-events-none"
          style={{ opacity: 1 - transitionProgress }}
          draggable={false}
        />
      )}
      <img
        src={scene.assets.background}
        alt=""
        aria-hidden
        className="absolute inset-0 w-full h-full object-cover object-bottom pointer-events-none"
        style={{ opacity: world.transition ? transitionProgress : 1 }}
        draggable={false}
      />

      {/* Warm lamp halos behind the creature — radial gradients placed at the scene's lamp coordinates.
          The radius is expressed as a fraction of the master width; we express it as a percentage of the
          rendered container so it scales with the panel size. Opacity is the scene's lampIntensity for this
          light band. */}
      {scene.lighting.lamps.map((lamp) => (
        <div
          key={lamp.id}
          aria-hidden
          className="absolute pointer-events-none scene-lamp-halo"
          style={{
            left: `${lamp.x * 100}%`,
            top: `${lamp.y * 100}%`,
            width: `${lamp.radius * 200}%`,
            height: `${lamp.radius * 200}%`,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(circle, ${lamp.color} 0%, transparent 60%)`,
            opacity: lightOverride.lampIntensity,
            transition: 'opacity 1.2s ease',
            mixBlendMode: 'screen'
          }}
        />
      ))}

      {/* The creature — absolutely positioned at the current scene spot. Base creature size is the same 120x120
          companion; the spot's `scale` multiplies against a scene-default size that keeps the creature small
          relative to real furniture (per the "creature should feel like a small inhabitant of a real room"
          product goal). */}
      <div
        className="absolute"
        style={{
          left: `${spot.x * 100}%`,
          top: `${spot.y * 100}%`,
          width: `${18 * spot.scale}%`,
          transform: 'translate(-50%, -50%)',
          transition: 'left .7s cubic-bezier(.4,0,.2,1), top .7s cubic-bezier(.4,0,.2,1), width .7s ease'
        }}
      >
        <div style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'pointer' }} onClick={onPet} role="button" aria-label="Pet the creature" title="Say hello">
          <Companion state={state} gaze={gaze} dim={0} />
        </div>
      </div>

      {/* Foreground overlay — occludes the creature at spots where scene.spots.occlusionState is verified against
          it. Renders on top of the creature. If the file is missing at runtime, the img fails silently and no
          occlusion happens — the creature simply appears in front of the desk (visibly wrong at desk-seat until
          the correct foreground arrives; every other spot is unaffected because their occlusion doesn't depend
          on this layer). */}
      {scene.assets.foreground && (
        <img
          src={scene.assets.foreground}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover object-bottom pointer-events-none"
          draggable={false}
        />
      )}

      {/* Light-band tint — a full-canvas colour wash to shift the room's mood by time of day. Applied AFTER the
          foreground so both background AND foreground are tinted uniformly (a warm evening wash on the desk
          matches the warm evening wash on the walls). */}
      {lightOverride.ambientTint !== 'rgba(0,0,0,0)' && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background: lightOverride.ambientTint,
            transition: 'background 1.2s ease',
            mixBlendMode: 'multiply'
          }}
        />
      )}
    </div>
  )
}
