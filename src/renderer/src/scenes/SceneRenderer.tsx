import { useEffect, useState } from 'react'
import type { WorldContext } from './SceneDefinition'
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
}

const CROSSFADE_MS = 1200

/**
 * Phase 2 (2026-09-19): SceneRenderer is now purely the world's visual layer — background art, lamp halos,
 * foreground, dust motes, light-band tint. The Companion is no longer rendered here; she's rendered at app
 * level by CompanionRenderer, positioned in pixel coordinates against the world panel's measured bounds. This
 * lets her leave the world (roam over chat/rail) and persist across surfaces without the world component
 * needing to know about her.
 */
export function SceneRenderer({ world }: Props): React.JSX.Element {
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
    /* Background is deliberately transparent so the world aside's theme-aware --color-zone-world shows through
       the letterbox regions around the SVG (viewBox aspect ≠ panel aspect ⇒ horizontal letterbox on both sides).
       Earlier this div was filled with scene.palette.world (a fixed illustrated cream), which lit up as bright
       vertical bands in dark mode along the world panel's left edge and the world/chat divider. Making it
       transparent lets the aside's background inherit whatever the current theme uses (dark walnut charcoal in
       dark mode; warm walnut cream in light mode) — no bright letterbox in either. */
    <div className="relative w-full h-full" style={{ background: 'transparent' }}>
      {/* Illustrated background composition */}
      {SceneBody && (
        <div className="absolute inset-0 pointer-events-none">
          <SceneBody band={lightBand} layer="background" />
        </div>
      )}

      {/* Warm lamp halos — tuned tightly to the drawn shade (companion-home v3, 2026-09-19). Previous versions
          bled a warm cream glow past the world panel's right edge, reading as a bright "white" vertical band
          against the divider — since the chair-lamp sits at x=0.88 and world aside is now overflow-visible for
          roaming, the halo's outer edge crossed into the merged window's chat region. Fixed by shrinking the
          halo footprint hard: 65% of radius (was 130%), lower opacity, tighter gradient stops. The lamp still
          reads as a lit lamp; it no longer paints the panel boundary. */}
      {scene.lighting.lamps.map((lamp) => (
        <div
          key={lamp.id}
          aria-hidden
          className="absolute pointer-events-none scene-lamp-halo"
          style={{
            left: `${lamp.x * 100}%`,
            top: `${lamp.y * 100}%`,
            width: `${lamp.radius * 65}%`,
            height: `${lamp.radius * 65}%`,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(circle, ${lamp.color} 0%, ${lamp.color}33 40%, transparent 78%)`,
            opacity: lightOverride.lampIntensity * 0.38,
            transition: 'opacity 1.2s ease',
            mixBlendMode: 'soft-light',
            filter: 'blur(4px)'
          }}
        />
      ))}

      {/* Illustrated foreground composition (no more creature layer between background and foreground — she is
          app-level now, so the foreground simply sits above the background). */}
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
