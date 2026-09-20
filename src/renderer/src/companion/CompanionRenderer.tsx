/**
 * CompanionRenderer — the Companion's visual presence, at app level (Phase 2, 2026-09-19).
 *
 * Before Phase 2, `<Companion>` was rendered inside SceneRenderer, which meant the creature was structurally a
 * child of the world panel — she could never leave. Phase 2 lifts her out. This component paints her at
 * absolute pixel coordinates inside whichever container the App passes it to (currently the merged Conversation
 * window). It contains only *positioning* + click surface + a soft contact shadow; the visual character lives
 * in Companion.tsx (unchanged). Kept minimal so multi-surface follow-up (rendering her over Calendar/Things/
 * Settings) is a matter of positioning her against a different rect, not another component.
 */

import { Companion } from '../Companion'
import type { CompanionState, Gaze } from '../companionState'
import type { CreatureBox } from './positioning'

interface Props {
  state: CompanionState
  gaze: Gaze
  /** 0..1 dim factor for evening/night lighting on the creature itself — passes through to Companion. */
  dim: number
  /** Absolute position + width in the container's own coordinate space. */
  box: CreatureBox
  /** Direct interaction — user clicked her. */
  onPet: () => void
  /** Double-click summons a thought bubble unconditionally (bypasses rate limit + cooldown). */
  onDoubleClick?: () => void
}

export function CompanionRenderer({ state, gaze, dim, box, onPet, onDoubleClick }: Props): React.JSX.Element {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        transform: 'translate(-50%, -50%)',
        transition: 'left .8s cubic-bezier(.4,0,.2,1), top .8s cubic-bezier(.4,0,.2,1), width .8s ease',
        // Ensure she renders ABOVE the curtain overlays (which are z-index 20) so the curtain never covers
        // her when she peeks near the window.
        zIndex: 25
      }}
    >
      {/* Contact shadow beneath her, soft radial gradient — grounds her against the floor/rug/chair no matter
          which spot she's landed at. Rendered as a sibling INSIDE the transform container so it moves with her
          but doesn't take part in the pose's own inline rotate/scale (9b's `.pose` group). */}
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
      <div
        className="pointer-events-auto"
        style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'pointer' }}
        onClick={onPet}
        onDoubleClick={onDoubleClick}
        role="button"
        aria-label="Pet the creature"
        title="Say hello (double-click to hear her thoughts)"
      >
        <Companion state={state} gaze={gaze} dim={dim} />
      </div>
    </div>
  )
}
