/**
 * CompanionUtterance — auto-sizing thought cloud (2026-09-19 v5).
 *
 * The bubble sizes itself to its text content instead of trying to stretch a fixed SVG cloud. A rounded
 * paper body holds the text; small rounded "bumps" are positioned around the perimeter to give it a cloud
 * silhouette. Text is selectable (user-select: text). Below the cloud, three trailing ellipses of decreasing
 * size fall toward the creature's head.
 *
 * Bubble persists until the user clicks the small × close button in the corner — clicking the body itself
 * does nothing so you can highlight/copy the text without dismissing.
 */

import type { CreatureBox } from './positioning'

interface Props {
  text: string | null
  box: CreatureBox
  onDismiss?: () => void
}

const PINK_FILL = '#F5DDDF'
const BRASS_BORDER = 'var(--color-accent)'

function Bump({ style }: { style: React.CSSProperties }): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        borderRadius: '50%',
        background: PINK_FILL,
        border: `2px solid ${BRASS_BORDER}`,
        ...style
      }}
    />
  )
}

export function CompanionUtterance({ text, box, onDismiss }: Props): React.JSX.Element | null {
  if (!text) return null

  // The bubble anchors above the creature. It grows down/up organically as text fills; we use max-width so
  // long poems wrap gracefully rather than turning into a single very-wide line.
  const anchorLeft = box.left
  const anchorTop = box.top - box.width * 0.55
  const trailBaseX = box.left - box.width * 0.08

  return (
    <div className="absolute" style={{ inset: 0, zIndex: 40 }}>
      {/* Three trailing thought-circles going from the cloud down toward the creature's head */}
      <svg
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: trailBaseX + box.width * 0.02,
          top: box.top - box.width * 0.12,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)'
        }}
        viewBox="0 0 20 20"
      >
        <ellipse cx="10" cy="10" rx="8" ry="7" fill={PINK_FILL} stroke={BRASS_BORDER} strokeWidth="1.8" />
      </svg>
      <svg
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: trailBaseX - box.width * 0.01,
          top: box.top - box.width * 0.22,
          width: 18,
          height: 18,
          transform: 'translate(-50%, -50%)'
        }}
        viewBox="0 0 20 20"
      >
        <ellipse cx="10" cy="10" rx="8" ry="7" fill={PINK_FILL} stroke={BRASS_BORDER} strokeWidth="1.8" />
      </svg>
      <svg
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: trailBaseX - box.width * 0.04,
          top: box.top - box.width * 0.34,
          width: 24,
          height: 24,
          transform: 'translate(-50%, -50%)'
        }}
        viewBox="0 0 20 20"
      >
        <ellipse cx="10" cy="10" rx="8" ry="7" fill={PINK_FILL} stroke={BRASS_BORDER} strokeWidth="1.8" />
      </svg>

      {/* The cloud body — auto-sizing wrapper. Positioned so its BOTTOM sits above the creature's head. */}
      <div
        className="absolute pointer-events-auto"
        style={{
          left: anchorLeft,
          top: anchorTop,
          transform: 'translate(-50%, -100%)',
          animation: 'utterance-in .4s ease-out'
        }}
      >
        {/* Decorative cloud bumps around the perimeter of the body — position them relative to the body wrap.
            Each is a rounded pink circle with brass border overlapping the main rounded rectangle. */}
        <div className="relative" style={{ padding: 14 }}>
          {/* Top bumps */}
          <Bump style={{ top: 0, left: '18%', width: 30, height: 30 }} />
          <Bump style={{ top: -6, left: '38%', width: 40, height: 40 }} />
          <Bump style={{ top: -4, left: '62%', width: 32, height: 32 }} />
          {/* Side bumps */}
          <Bump style={{ top: '32%', left: -8, width: 32, height: 32 }} />
          <Bump style={{ top: '58%', left: -6, width: 26, height: 26 }} />
          <Bump style={{ top: '30%', right: -8, width: 30, height: 30 }} />
          <Bump style={{ top: '60%', right: -6, width: 28, height: 28 }} />
          {/* Bottom bumps */}
          <Bump style={{ bottom: -4, left: '22%', width: 32, height: 32 }} />
          <Bump style={{ bottom: -6, left: '46%', width: 36, height: 36 }} />
          <Bump style={{ bottom: -4, left: '68%', width: 28, height: 28 }} />

          {/* Main text body */}
          <div
            className="relative italic whitespace-pre-line rounded-[36px] select-text"
            style={{
              fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, "Times New Roman", serif',
              fontSize: 15,
              lineHeight: 1.4,
              color: 'var(--color-espresso)',
              background: PINK_FILL,
              border: `2px solid ${BRASS_BORDER}`,
              padding: '22px 26px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              minWidth: 220,
              maxWidth: 360,
              userSelect: 'text',
              cursor: 'text',
              zIndex: 1
            }}
          >
            {text}
            {/* Small × close button in the top-right corner. Click to dismiss without disturbing selection. */}
            <button
              onClick={onDismiss}
              aria-label="Dismiss thought"
              title="Dismiss"
              style={{
                position: 'absolute',
                top: -10,
                right: -10,
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: PINK_FILL,
                border: `2px solid ${BRASS_BORDER}`,
                color: 'var(--color-espresso)',
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                fontFamily: 'Georgia, serif'
              }}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
