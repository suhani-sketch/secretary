import type { CompanionState, Gaze } from './companionState'

/**
 * The creature (spec §8 Phase 4): an original dormouse-quokka. Round pear body, round ears, small dark nose, calm
 * half-lidded eyes, tiny paws, short curling tail, one knitted scarf. Drawn as layered SVG in a 120×120 box; poses are
 * whole-body transforms plus a prop, so state changes are a single CSS transition and the rest of the time it breathes.
 */

export type Pose = 'sit' | 'desk' | 'read' | 'window' | 'curl' | 'stand' | 'stretch'

export const poseFor = (state: CompanionState): Pose => {
  switch (state) {
    case 'working':
    case 'writing':
      return 'desk'
    case 'reading':
      return 'read'
    case 'waiting':
      return 'window'
    case 'sleepy':
      return 'curl'
    case 'greeting':
      return 'stand'
    case 'celebrating':
      return 'stretch'
    default:
      return 'sit'
  }
}

const COCOA = '#8B6A55'
const COCOA_DARK = '#5E4636'
const OAT = '#D9B79F'
const CREAM = '#F3E9DD'
const NOSE = '#3A2E28'
const SCARF = '#B5836D'
const SCARF_DARK = '#9C6E5A'
const CHEEK = '#E9A48E'

interface Props {
  state: CompanionState
  gaze: Gaze
  /** 0..1 how dark the room is — dims the fur slightly at night so it sits in the scene. */
  dim?: number
}

export function Companion({ state, gaze, dim = 0 }: Props): React.JSX.Element {
  const pose = poseFor(state)
  const eyes = eyeShape(state, gaze)
  const pupilDx = gaze === 'viewer' ? 0 : gaze === 'window' ? 3 : gaze === 'desk' ? -1 : 2
  const pupilDy = gaze === 'viewer' ? 0 : gaze === 'desk' ? 2 : gaze === 'window' ? -1 : 0
  const bodyTilt = pose === 'desk' ? 8 : pose === 'read' ? 4 : pose === 'window' ? -6 : pose === 'stretch' ? 0 : 0
  const bodyScaleY = pose === 'curl' ? 0.82 : pose === 'stretch' ? 1.08 : 1
  const headTilt = state === 'thinking' ? -10 : state === 'concerned' ? 4 : pose === 'window' ? -8 : pose === 'read' || pose === 'desk' ? 8 : 0

  return (
    <svg viewBox="0 0 120 120" width="100%" height="100%" className="companion" aria-hidden style={{ filter: dim ? `brightness(${1 - dim * 0.25})` : undefined, overflow: 'visible' }}>
      <style>{`
        .companion .breath { animation: breathe 4.6s ease-in-out infinite; transform-origin: 60px 104px; }
        .companion .breath.sleepy { animation-duration: 6.5s; }
        .companion .blink { animation: blink 7s ease-in-out infinite; transform-origin: center; }
        .companion .pose { transition: transform .55s cubic-bezier(.4,0,.2,1); transform-origin: 60px 104px; }
        .companion .head { transition: transform .55s cubic-bezier(.4,0,.2,1); transform-origin: 60px 58px; }
        .companion .pupil { transition: transform .3s ease; }
        .companion .prop { transition: opacity .35s ease; }
        .companion .tail { animation: tail 9s ease-in-out infinite; transform-origin: 96px 96px; }
        .companion .sparkle { animation: sparkle 1.3s ease-out infinite; }
        .companion .dots circle { animation: dots 1.6s ease-in-out infinite; }
        .companion .dots circle:nth-child(2) { animation-delay: .25s } .companion .dots circle:nth-child(3) { animation-delay: .5s }
        .companion .wave { animation: wave 1.1s ease-in-out 2; transform-origin: 34px 76px; }
        @keyframes breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.012,1.03); } }
        @keyframes blink { 0%,93%,100% { transform: scaleY(1); } 96% { transform: scaleY(.08); } }
        @keyframes tail { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-6deg); } }
        @keyframes sparkle { 0% { opacity: 0; transform: translateY(0) scale(.6); } 40% { opacity: 1; } 100% { opacity: 0; transform: translateY(-10px) scale(1); } }
        @keyframes dots { 0%,100% { opacity: .25; } 50% { opacity: .9; } }
        @keyframes wave { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-35deg); } }
      `}</style>

      {/* shadow on the floor */}
      <ellipse cx="60" cy="110" rx={pose === 'curl' ? 34 : 26} ry="4" fill={NOSE} opacity="0.10" />

      <g className="pose" style={{ transform: `rotate(${bodyTilt}deg) scale(1, ${bodyScaleY})` }}>
        <g className={`breath ${pose === 'curl' ? 'sleepy' : ''}`}>
          {/* tail */}
          <path className="tail" d="M88 96 C 104 96, 108 84, 100 78 C 96 75, 92 80, 95 84" stroke={COCOA} strokeWidth="7" fill="none" strokeLinecap="round" />
          {/* body */}
          <path d="M60 44 C 90 44, 98 76, 96 92 C 94 106, 80 110, 60 110 C 40 110, 26 106, 24 92 C 22 76, 30 44, 60 44 Z" fill={COCOA} />
          <path d="M60 60 C 78 60, 84 80, 82 94 C 80 104, 70 106, 60 106 C 50 106, 40 104, 38 94 C 36 80, 42 60, 60 60 Z" fill={OAT} opacity="0.85" />
          {/* paws */}
          <ellipse cx="44" cy="100" rx="8" ry="5" fill={COCOA_DARK} />
          <ellipse cx="76" cy="100" rx="8" ry="5" fill={COCOA_DARK} />
          {/* arms (one may wave) */}
          <g className={state === 'greeting' ? 'wave' : ''}>
            <path d={state === 'greeting' ? 'M34 80 C 26 72, 24 60, 30 54' : 'M34 82 C 30 88, 34 96, 42 96'} stroke={COCOA} strokeWidth="7" fill="none" strokeLinecap="round" />
          </g>
          <path d={pose === 'desk' || pose === 'read' ? 'M86 82 C 88 90, 80 96, 70 92' : 'M86 82 C 90 88, 86 96, 78 96'} stroke={COCOA} strokeWidth="7" fill="none" strokeLinecap="round" />

          {/* scarf — the one accessory */}
          <path d="M40 66 C 50 74, 70 74, 80 66 C 82 70, 82 74, 80 76 C 68 82, 52 82, 40 76 C 38 74, 38 70, 40 66 Z" fill={SCARF} />
          <path d="M42 70 C 52 77, 68 77, 78 70" stroke={SCARF_DARK} strokeWidth="1.5" fill="none" opacity="0.7" />
          <path d="M72 76 C 78 84, 78 92, 74 98" stroke={SCARF} strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M74 97 l-2 4 M77 96 l0 5 M71 96 l-3 3" stroke={SCARF_DARK} strokeWidth="1.5" strokeLinecap="round" />

          {/* head */}
          <g className="head" style={{ transform: `rotate(${headTilt}deg)` }}>
            {/* ears */}
            <ellipse cx="38" cy="36" rx="11" ry="12" fill={COCOA} transform={`rotate(-10 38 36) ${state === 'attentive' || state === 'greeting' ? 'translate(0 -3)' : state === 'concerned' || state === 'sleepy' ? 'translate(-1 3)' : ''}`} />
            <ellipse cx="38" cy="37" rx="6" ry="7" fill={CHEEK} opacity="0.55" transform="rotate(-10 38 36)" />
            <ellipse cx="82" cy="36" rx="11" ry="12" fill={COCOA} transform={`rotate(10 82 36) ${state === 'attentive' || state === 'greeting' ? 'translate(0 -3)' : state === 'concerned' || state === 'sleepy' ? 'translate(1 3)' : ''}`} />
            <ellipse cx="82" cy="37" rx="6" ry="7" fill={CHEEK} opacity="0.55" transform="rotate(10 82 36)" />
            {/* face */}
            <ellipse cx="60" cy="52" rx="30" ry="26" fill={COCOA} />
            <ellipse cx="60" cy="58" rx="20" ry="15" fill={OAT} />
            {/* cheeks */}
            <circle cx="42" cy="58" r="4.5" fill={CHEEK} opacity={state === 'happy' || state === 'celebrating' || state === 'greeting' ? 0.75 : 0.4} />
            <circle cx="78" cy="58" r="4.5" fill={CHEEK} opacity={state === 'happy' || state === 'celebrating' || state === 'greeting' ? 0.75 : 0.4} />
            {/* eyes */}
            <Eyes shape={eyes} dx={pupilDx} dy={pupilDy} />
            {/* brows for concern */}
            {state === 'concerned' && (
              <>
                <path d="M42 40 q6 -3 12 0" stroke={COCOA_DARK} strokeWidth="2" fill="none" strokeLinecap="round" />
                <path d="M66 40 q6 -3 12 0" stroke={COCOA_DARK} strokeWidth="2" fill="none" strokeLinecap="round" />
              </>
            )}
            {/* nose + mouth */}
            <ellipse cx="60" cy="61" rx="3.2" ry="2.4" fill={NOSE} />
            <Mouth state={state} />
          </g>
        </g>
      </g>

      {/* props by pose */}
      <g className="prop" opacity={pose === 'read' ? 1 : 0}>
        <rect x="46" y="84" width="30" height="20" rx="2" fill={CREAM} stroke={COCOA_DARK} strokeWidth="1.2" transform="rotate(-6 61 94)" />
        <line x1="61" y1="85" x2="61" y2="103" stroke={COCOA_DARK} strokeWidth="1" transform="rotate(-6 61 94)" />
      </g>
      <g className="prop" opacity={pose === 'desk' ? 1 : 0}>
        <line x1="70" y1="92" x2="84" y2="76" stroke="#C99C5A" strokeWidth="3" strokeLinecap="round" />
        <path d="M84 76 l3 -4" stroke={NOSE} strokeWidth="3" strokeLinecap="round" />
      </g>

      {/* thinking dots */}
      {state === 'thinking' && (
        <g className="dots" fill={COCOA_DARK}>
          <circle cx="96" cy="30" r="2.2" />
          <circle cx="104" cy="22" r="3" />
          <circle cx="113" cy="12" r="3.8" />
        </g>
      )}
      {/* celebration sparkles */}
      {state === 'celebrating' && (
        <g fill={SCARF}>
          <path className="sparkle" d="M22 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />
          <path className="sparkle" d="M98 20 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" style={{ animationDelay: '.3s' }} />
          <path className="sparkle" d="M60 8 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5z" style={{ animationDelay: '.6s' }} />
        </g>
      )}
      {/* sleepy z */}
      {state === 'sleepy' && (
        <g className="dots" fill={COCOA_DARK} fontSize="9" fontFamily="ui-sans-serif, system-ui" opacity="0.6">
          <text x="92" y="34">z</text>
          <text x="100" y="24" fontSize="11">z</text>
        </g>
      )}
    </svg>
  )
}

type EyeShape = 'half' | 'open' | 'wide' | 'closed' | 'smile'

function eyeShape(state: CompanionState, gaze: Gaze): EyeShape {
  if (gaze === 'closed' || state === 'sleepy') return 'closed'
  if (state === 'happy' || state === 'celebrating' || state === 'greeting') return 'smile'
  if (state === 'attentive' || state === 'concerned') return 'open'
  if (state === 'thinking') return 'half'
  return 'half'
}

function Eyes({ shape, dx, dy }: { shape: EyeShape; dx: number; dy: number }): React.JSX.Element {
  const L = 48
  const R = 72
  const y = 50
  if (shape === 'closed') {
    return (
      <>
        <path d={`M${L - 5} ${y + 1} q5 3 10 0`} stroke={NOSE} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <path d={`M${R - 5} ${y + 1} q5 3 10 0`} stroke={NOSE} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      </>
    )
  }
  if (shape === 'smile') {
    return (
      <>
        <path d={`M${L - 5} ${y + 2} q5 -5 10 0`} stroke={NOSE} strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <path d={`M${R - 5} ${y + 2} q5 -5 10 0`} stroke={NOSE} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      </>
    )
  }
  const ry = shape === 'wide' ? 5.5 : shape === 'open' ? 4.6 : 3.2
  return (
    <>
      <g className="blink">
        <ellipse cx={L} cy={y} rx="4.6" ry={ry} fill={NOSE} />
        <ellipse cx={R} cy={y} rx="4.6" ry={ry} fill={NOSE} />
      </g>
      <g className="pupil" style={{ transform: `translate(${dx}px, ${dy}px)` }}>
        <circle cx={L + 1.4} cy={y - 1.2} r="1.3" fill={CREAM} />
        <circle cx={R + 1.4} cy={y - 1.2} r="1.3" fill={CREAM} />
      </g>
    </>
  )
}

function Mouth({ state }: { state: CompanionState }): React.JSX.Element {
  if (state === 'working' || state === 'writing') return <ellipse cx="60" cy="67" rx="2.6" ry="2" fill={NOSE} opacity="0.7" />
  if (state === 'concerned') return <path d="M56 68 q4 -1.5 8 0" stroke={NOSE} strokeWidth="1.8" fill="none" strokeLinecap="round" />
  if (state === 'celebrating' || state === 'greeting' || state === 'happy') return <path d="M54 65 q6 6 12 0" stroke={NOSE} strokeWidth="2" fill="none" strokeLinecap="round" />
  return <path d="M56 66 q4 3 8 0" stroke={NOSE} strokeWidth="1.8" fill="none" strokeLinecap="round" />
}
