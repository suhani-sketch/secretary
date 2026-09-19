import { useEffect, useState } from 'react'
import type { CompanionState, Gaze } from '../companionState'
import { Companion } from '../Companion'
import type { SceneDefinition, WorldContext } from './SceneDefinition'
import { LibraryScene } from './LibraryScene'

/**
 * Scene renderer — final direction (2026-09-19 pass 3):
 *
 * The previous version rendered the illustrated master PNG as a giant background image. That approach made the
 * room read as a photograph with a mascot pasted on top. Corrected: for the Library, we render a stylized SVG
 * interior inspired by the illustrated reference (walnut bookshelves, wingback chair, wooden floor, desk, ladder,
 * window with cool light, warm lamp pools). The reference PNG is the design intent; the runtime environment is
 * illustrated composition that the creature can genuinely inhabit at correct scale.
 *
 * Layered stack:
 *   1. LibraryScene (SVG background: architecture, floor, midground furniture, back-plane props)
 *   2. Creature at the chosen scene spot — visibly present, integrated with a soft contact shadow
 *   3. LibraryScene foreground (SVG desk / front-plane props) — occludes creature when at desk
 *   4. Warm lamp CSS halos with gentle animation
 *   5. Light-band tint overlay for time-of-day mood
 *
 * The illustrated PNG assets loaded via `scene://` are intentionally NOT rendered — kept on disk for reference
 * and future iteration. The runtime world is entirely stylized SVG that the creature can visually coexist with.
 */

interface Props {
  world: WorldContext
  state: CompanionState
  gaze: Gaze
  spot: { x: number; y: number; scale: number }
  onPet: () => void
}

const CROSSFADE_MS = 1200

export function SceneRenderer({ world, state, gaze, spot, onPet }: Props): React.JSX.Element {
  const { scene } = world
  const [, setTransitionProgress] = useState(0)

  useEffect(() => {
    if (!world.transition) return
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

  // The stylized illustrated Library SVG. Only one scene registered; others fall to the legacy SVG Room.
  const SceneBody = scene.id === 'library' ? LibraryScene : null

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ background: scene.palette.world, transition: 'background 1.2s ease' }}>
      {/* Illustrated background composition */}
      {SceneBody && (
        <div className="absolute inset-0 pointer-events-none">
          <SceneBody band={lightBand} layer="background" />
        </div>
      )}

      {/* Warm lamp halos — behind creature, soft radial gradient, gentle flicker */}
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
            background: `radial-gradient(circle, ${lamp.color} 0%, ${lamp.color}55 32%, transparent 68%)`,
            opacity: lightOverride.lampIntensity,
            transition: 'opacity 1.2s ease',
            mixBlendMode: 'screen',
            filter: 'blur(4px)'
          }}
        />
      ))}

      {/* Creature — visibly present, correctly scaled, with a soft contact shadow to integrate with the world */}
      <div
        className="absolute"
        style={{
          left: `${spot.x * 100}%`,
          top: `${spot.y * 100}%`,
          width: `${28 * spot.scale}%`,
          transform: 'translate(-50%, -50%)',
          transition: 'left .8s cubic-bezier(.4,0,.2,1), top .8s cubic-bezier(.4,0,.2,1), width .8s ease'
        }}
      >
        {/* Contact shadow — sits BEHIND the creature body but rendered as a sibling underneath so it doesn't
            travel with the pose transform. Softly grounds the creature in the world. */}
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            left: '10%',
            right: '10%',
            bottom: '3%',
            height: '9%',
            background: 'radial-gradient(ellipse at center, rgba(45,31,26,0.35) 0%, transparent 75%)',
            filter: 'blur(3px)'
          }}
        />
        <div style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'pointer' }} onClick={onPet} role="button" aria-label="Pet the creature" title="Say hello">
          <Companion state={state} gaze={gaze} dim={lightBand === 'night' ? 0.28 : lightBand === 'evening' ? 0.08 : 0} />
        </div>
      </div>

      {/* Illustrated foreground composition — occludes creature at desk-region spots */}
      {SceneBody && (
        <div className="absolute inset-0 pointer-events-none">
          <SceneBody band={lightBand} layer="foreground" />
        </div>
      )}

      {/* Restrained ambient dust motes in the lamp pools — SVG circles drifting slowly upward. Only visible
          when the lamps are actually on (evening/night). Very low opacity, small radius; the user does not
          consciously notice them unless they linger. */}
      {(lightBand === 'evening' || lightBand === 'night') && scene.lighting.lamps.map((lamp) => (
        <svg key={`dust-${lamp.id}`} className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => {
            const cx = lamp.x * 100 + (Math.cos((lamp.x + i) * 7) * lamp.radius * 100 * 0.4)
            const cyBase = lamp.y * 100 + 6
            const delay = (i * 1.7 + lamp.x * 3) % 8
            return (
              <circle key={i} cx={cx} cy={cyBase} r="0.28" fill={lamp.color} opacity="0.5" style={{ animation: `dust-drift 8s ease-in-out ${delay}s infinite` }} />
            )
          })}
        </svg>
      ))}

      {/* Light-band tint — only applied for evening / night (day and morning use the scene's baked lighting) */}
      {(lightBand === 'evening' || lightBand === 'night') && (
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
