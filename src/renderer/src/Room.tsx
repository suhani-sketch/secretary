import { useEffect, useState } from 'react'
import { Companion, poseFor } from './Companion'
import type { CompanionState, Gaze } from './companionState'

/**
 * The room (spec §8 Phase 4): a place, not a background. Layered SVG in a tall panel. Environments change the window and a
 * few objects; time of day changes the light over any environment. The creature moves between spots by pose.
 * Nothing here is gamified and nothing accumulates.
 */

export type EnvironmentId = 'trees' | 'rain' | 'coast' | 'winter' | 'library' | 'fireplace'
export type Band = 'morning' | 'day' | 'evening' | 'night'
export type TimeChoice = 'auto' | Band

export const ENVIRONMENTS: { id: EnvironmentId; label: string; emoji: string }[] = [
  { id: 'trees', label: 'Trees and sky', emoji: '🌳' },
  { id: 'rain', label: 'Rainy window', emoji: '🌧️' },
  { id: 'coast', label: 'Coastal', emoji: '🌊' },
  { id: 'winter', label: 'Winter', emoji: '❄️' },
  { id: 'library', label: 'Library', emoji: '📚' },
  { id: 'fireplace', label: 'Fireplace room', emoji: '🔥' }
]
export const TIMES: { id: TimeChoice; label: string }[] = [
  { id: 'auto', label: 'Follow the clock' },
  { id: 'morning', label: 'Morning' },
  { id: 'day', label: 'Day' },
  { id: 'evening', label: 'Evening' },
  { id: 'night', label: 'Night' }
]

export function bandForHour(h: number): Band {
  if (h >= 6 && h < 11) return 'morning'
  if (h >= 11 && h < 17) return 'day'
  if (h >= 17 && h < 21) return 'evening'
  return 'night'
}

/** Light for each band: wall, floor, window sky gradient, sun/moon, lamp, and how much to dim the creature. */
const LIGHT: Record<Band, { wall: string; wall2: string; floor: string; sky: [string, string]; sun: string | null; moon: boolean; lamp: boolean; dim: number; desk: string }> = {
  morning: { wall: '#F6E9D8', wall2: '#EFDCC5', floor: '#D9C3A8', sky: ['#BFD9EE', '#F7E3C9'], sun: '#F6D28A', moon: false, lamp: false, dim: 0, desk: '#B98F6A' },
  day: { wall: '#F1E9DF', wall2: '#E8DCCB', floor: '#D3BEA3', sky: ['#A9CDEB', '#DCEBF7'], sun: '#FBE7A1', moon: false, lamp: false, dim: 0, desk: '#B48A66' },
  evening: { wall: '#EDD6BE', wall2: '#DFBE9E', floor: '#C7A98A', sky: ['#E9A46B', '#F6D2A6'], sun: '#F3B25E', moon: false, lamp: true, dim: 0.05, desk: '#A87F5C' },
  night: { wall: '#4A4652', wall2: '#3B3843', floor: '#37343E', sky: ['#1E2340', '#2F3457'], sun: null, moon: true, lamp: true, dim: 0.35, desk: '#6E5745' }
}

interface Props {
  state: CompanionState
  gaze: Gaze
  environment: EnvironmentId
  time: TimeChoice
  /** Living activities (Phase 5): 'cooking' puts a small kitchen object in the room and the creature beside it. */
  happening: 'focus' | 'cooking' | 'waiting' | null
  onChangeEnvironment: (e: EnvironmentId) => void
  onChangeTime: (t: TimeChoice) => void
}

export function Room({ state, gaze, environment, time, happening, onChangeEnvironment, onChangeTime }: Props): React.JSX.Element {
  const [hour, setHour] = useState(new Date().getHours())
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 60_000)
    return () => clearInterval(t)
  }, [])
  const band: Band = time === 'auto' ? bandForHour(hour) : time
  const L = LIGHT[band]
  // While something cooks, an idle or window-gazing creature waits beside the kitchen object instead (spec Phase 5).
  const basePose = poseFor(state)
  const pose = happening === 'cooking' && (basePose === 'sit' || basePose === 'window') ? 'kitchen' : basePose
  const [menu, setMenu] = useState(false)

  // Where the creature sits for each pose (SVG coordinates of the 120-box's top-left).
  const spot =
    pose === 'desk' ? { x: 64, y: 672, s: 0.9 } : pose === 'read' ? { x: 140, y: 750, s: 1 } : pose === 'window' ? { x: 22, y: 316, s: 0.85 } : pose === 'curl' ? { x: 150, y: 760, s: 1 } : pose === 'kitchen' ? { x: 82, y: 752, s: 0.95 } : { x: 132, y: 748, s: 1 }

  return (
    <div className="relative h-full w-full rounded-3xl overflow-hidden shadow-inner" style={{ background: L.wall, transition: 'background 2s ease' }}>
      <svg viewBox="0 0 260 900" preserveAspectRatio="xMidYMax meet" className="absolute inset-0 w-full h-full" aria-hidden>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={L.sky[0]} style={{ transition: 'stop-color 2s ease' }} />
            <stop offset="1" stopColor={L.sky[1]} style={{ transition: 'stop-color 2s ease' }} />
          </linearGradient>
          <radialGradient id="lampglow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#FFD79A" stopOpacity="0.55" />
            <stop offset="1" stopColor="#FFD79A" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="fireglow" cx="0.5" cy="0.6" r="0.5">
            <stop offset="0" stopColor="#FFB067" stopOpacity="0.6" />
            <stop offset="1" stopColor="#FFB067" stopOpacity="0" />
          </radialGradient>
          <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.4" fill="#000" opacity="0.035" />
            <circle cx="3" cy="3" r="0.4" fill="#000" opacity="0.025" />
          </pattern>
        </defs>

        {/* wall + floor */}
        <rect x="0" y="0" width="260" height="900" fill={L.wall} style={{ transition: 'fill 2s ease' }} />
        <rect x="0" y="0" width="260" height="900" fill={L.wall2} opacity="0.35" />
        <g transform="translate(0 280)">
        <path d="M0 520 L260 520 L260 620 L0 620 Z" fill={L.floor} style={{ transition: 'fill 2s ease' }} />
        <path d="M0 520 L260 520 L260 526 L0 526 Z" fill="#000" opacity="0.08" />
        </g>

        <g transform="translate(0 60)">
        {/* window or bookcase */}
        {environment === 'library' ? <Bookcase night={band === 'night'} /> : <Window env={environment} band={band} L={L} />}

        {/* shelf */}
        <rect x="24" y="238" width="212" height="6" rx="2" fill={L.desk} style={{ transition: 'fill 2s ease' }} />
        <Books x={30} y={212} />
        <rect x="118" y="220" width="30" height="18" rx="3" fill="#C9B29A" />
        <rect x="118" y="218" width="30" height="5" rx="2" fill="#B39B82" />
        <Plant x={196} y={200} winter={environment === 'winter'} />
        </g>

        <g transform="translate(0 280)">
        {/* rug */}
        <ellipse cx="150" cy="575" rx="86" ry="18" fill="#B5836D" opacity={band === 'night' ? 0.35 : 0.28} />
        <ellipse cx="150" cy="575" rx="70" ry="13" fill="none" stroke="#FAF6F0" strokeWidth="1.5" opacity="0.5" />

        {/* desk */}
        <rect x="18" y="446" width="180" height="10" rx="3" fill={L.desk} style={{ transition: 'fill 2s ease' }} />
        <rect x="26" y="456" width="8" height="64" fill={L.desk} opacity="0.9" />
        <rect x="176" y="456" width="8" height="64" fill={L.desk} opacity="0.9" />
        {/* laptop: lid open only while working */}
        <g style={{ transition: 'transform .6s ease', transformOrigin: '96px 446px', transform: pose === 'desk' ? 'none' : 'scaleY(0.12)' }}>
          <rect x="72" y="412" width="50" height="34" rx="3" fill="#6E6259" />
          <rect x="75" y="415" width="44" height="26" rx="2" fill={pose === 'desk' ? '#E8EEF3' : '#8A8078'} />
        </g>
        <rect x="70" y="444" width="54" height="4" rx="1.5" fill="#8A7B6E" />
        {/* notebook + pencil */}
        <rect x="132" y="434" width="34" height="14" rx="2" fill="#FAF6F0" transform="rotate(-8 149 441)" />
        <line x1="136" y1="438" x2="160" y2="435" stroke="#D8CDBF" strokeWidth="1" transform="rotate(-8 149 441)" />
        <line x1="136" y1="442" x2="158" y2="439" stroke="#D8CDBF" strokeWidth="1" transform="rotate(-8 149 441)" />
        {/* mug (steam in the morning) */}
        <rect x="42" y="430" width="14" height="16" rx="3" fill="#E7D9C9" />
        <path d="M56 434 q6 0 6 5 q0 5 -6 5" stroke="#E7D9C9" strokeWidth="2.5" fill="none" />
        {band === 'morning' && (
          <g stroke="#FFFFFF" strokeWidth="1.2" fill="none" opacity="0.6" className="steam">
            <path d="M46 426 q2 -4 0 -8" />
            <path d="M51 426 q-2 -4 0 -8" />
          </g>
        )}
        {/* pencil cup */}
        <rect x="160" y="436" width="10" height="12" rx="2" fill="#B5836D" />
        <line x1="163" y1="436" x2="163" y2="426" stroke="#C99C5A" strokeWidth="2" />
        <line x1="167" y1="436" x2="168" y2="427" stroke="#6E6259" strokeWidth="2" />
        {/* lamp */}
        <g>
          <rect x="188" y="430" width="3" height="18" fill="#5E4636" />
          <path d="M176 432 L204 432 L198 420 L182 420 Z" fill="#B5836D" />
          <ellipse cx="190" cy="448" rx="8" ry="2.5" fill="#5E4636" />
          {L.lamp && <ellipse cx="190" cy="470" rx="70" ry="50" fill="url(#lampglow)" style={{ transition: 'opacity 2s ease' }} />}
        </g>

        {/* fireplace environment: a small hearth on the left */}
        {environment === 'fireplace' && <Hearth x={14} y={462} />}

        {/* living activities: a small kitchen object appears only while something cooks (spec Phase 5) */}
        {happening === 'cooking' && <Kitchen x={190} y={474} night={band === 'night'} />}

        {/* cushion */}
        <ellipse cx="188" cy="592" rx="40" ry="10" fill="#C9A88F" opacity={band === 'night' ? 0.5 : 0.9} />
        </g>

        {/* paper grain */}
        <rect x="0" y="0" width="260" height="900" fill="url(#grain)" />
      </svg>

      {/* the creature, placed by pose */}
      <div
        className="absolute"
        style={{
          left: `${(spot.x / 260) * 100}%`,
          top: `${(spot.y / 900) * 100}%`,
          width: `${(120 * spot.s) / 2.6}%`,
          transition: 'left .7s cubic-bezier(.4,0,.2,1), top .7s cubic-bezier(.4,0,.2,1), width .7s ease'
        }}
      >
        <div style={{ width: '100%', aspectRatio: '1 / 1' }}>
          <Companion state={state} gaze={gaze} dim={L.dim} pose={pose} />
        </div>
      </div>

      {/* scene chooser — small, out of the way */}
      <button
        onClick={() => setMenu((v) => !v)}
        className="absolute top-3 right-3 text-[11px] rounded-full px-2 py-0.5 bg-white/40 hover:bg-white/70 text-stone-600 backdrop-blur-sm"
        title="Change the scene"
      >
        scene
      </button>
      {menu && (
        <div className="absolute top-9 right-3 left-3 rounded-2xl bg-cream/95 shadow-lg p-3 text-xs flex flex-col gap-2 z-10" onMouseLeave={() => setMenu(false)}>
          <div className="text-stone-500">Window</div>
          <div className="flex flex-wrap gap-1">
            {ENVIRONMENTS.map((e) => (
              <button key={e.id} onClick={() => onChangeEnvironment(e.id)} className={`rounded-lg px-2 py-1 ${environment === e.id ? 'bg-cocoa text-cream' : 'bg-white/70 text-stone-700 hover:bg-white'}`}>
                {e.emoji} {e.label}
              </button>
            ))}
          </div>
          <div className="text-stone-500 mt-1">Light</div>
          <div className="flex flex-wrap gap-1">
            {TIMES.map((t) => (
              <button key={t.id} onClick={() => onChangeTime(t.id)} className={`rounded-lg px-2 py-1 ${time === t.id ? 'bg-cocoa text-cream' : 'bg-white/70 text-stone-700 hover:bg-white'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Window({ env, band, L }: { env: EnvironmentId; band: Band; L: (typeof LIGHT)[Band] }): React.JSX.Element {
  return (
    <g>
      <rect x="40" y="30" width="180" height="170" rx="10" fill="url(#sky)" />
      {/* view */}
      {env === 'trees' && (
        <g>
          <path d="M40 160 Q 90 130 130 150 T 220 140 L220 200 L40 200 Z" fill={band === 'night' ? '#26303A' : '#7FA36A'} opacity="0.9" />
          <Tree x={78} y={132} h={40} band={band} />
          <Tree x={150} y={124} h={50} band={band} />
          <Tree x={196} y={140} h={34} band={band} />
        </g>
      )}
      {env === 'rain' && (
        <g>
          <path d="M40 150 Q 100 135 160 150 T 220 145 L220 200 L40 200 Z" fill={band === 'night' ? '#2A323C' : '#8C9E8A'} />
          <g stroke={band === 'night' ? '#AEB9CC' : '#E9F1F8'} strokeWidth="1" opacity="0.6" className="rain">
            {Array.from({ length: 14 }).map((_, i) => (
              <line key={i} x1={48 + i * 12} y1={40 + (i % 3) * 20} x2={44 + i * 12} y2={62 + (i % 3) * 20} />
            ))}
          </g>
          <g fill={band === 'night' ? '#AEB9CC' : '#E9F1F8'} opacity="0.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <circle key={i} cx={52 + i * 22} cy={186 + (i % 2) * 6} r="1.4" />
            ))}
          </g>
        </g>
      )}
      {env === 'coast' && (
        <g>
          <rect x="40" y="135" width="180" height="65" fill={band === 'night' ? '#1F3A55' : '#4F94C2'} opacity="0.9" />
          <path d="M40 150 q20 -4 40 0 t40 0 t40 0 t40 0 t20 0" stroke="#FFFFFF" strokeWidth="1.2" fill="none" opacity="0.5" />
          <path d="M40 168 q20 -4 40 0 t40 0 t40 0 t40 0 t20 0" stroke="#FFFFFF" strokeWidth="1.2" fill="none" opacity="0.35" />
          <path d="M40 200 L40 182 Q 130 170 220 182 L220 200 Z" fill="#E8D6B5" />
          {band !== 'night' && <path d="M150 70 q4 -4 8 0 q-4 -1 -8 0 M162 76 q4 -4 8 0 q-4 -1 -8 0" stroke="#FFFFFF" strokeWidth="1.2" fill="none" opacity="0.8" />}
        </g>
      )}
      {env === 'winter' && (
        <g>
          <path d="M40 150 Q 90 128 130 148 T 220 140 L220 200 L40 200 Z" fill={band === 'night' ? '#3B4552' : '#F3F6F9'} />
          <Tree x={80} y={132} h={40} band={band} snow />
          <Tree x={160} y={126} h={48} band={band} snow />
          <g fill="#FFFFFF" opacity="0.85">
            {Array.from({ length: 16 }).map((_, i) => (
              <circle key={i} cx={46 + ((i * 37) % 170)} cy={40 + ((i * 53) % 140)} r={i % 3 === 0 ? 1.6 : 1} />
            ))}
          </g>
        </g>
      )}
      {env === 'fireplace' && (
        <g>
          <path d="M40 158 Q 100 140 160 156 T 220 148 L220 200 L40 200 Z" fill={band === 'night' ? '#26303A' : '#8DA37A'} />
          <Tree x={100} y={130} h={44} band={band} />
        </g>
      )}
      {/* sun / moon */}
      {L.sun && <circle cx={band === 'morning' ? 70 : band === 'day' ? 130 : 190} cy={band === 'day' ? 60 : 92} r="14" fill={L.sun} opacity="0.95" />}
      {L.moon && (
        <g>
          <circle cx="176" cy="66" r="12" fill="#F2EBDD" opacity="0.95" />
          <circle cx="182" cy="62" r="11" fill={LIGHT.night.sky[0]} />
          <g fill="#F2EBDD">
            <circle cx="70" cy="52" r="1.2" />
            <circle cx="98" cy="70" r="0.9" />
            <circle cx="130" cy="46" r="1.1" />
            <circle cx="112" cy="96" r="0.8" />
            <circle cx="205" cy="110" r="1" />
          </g>
        </g>
      )}
      {/* frame */}
      <rect x="40" y="30" width="180" height="170" rx="10" fill="none" stroke="#FAF6F0" strokeWidth="8" />
      <line x1="130" y1="34" x2="130" y2="196" stroke="#FAF6F0" strokeWidth="5" />
      <line x1="44" y1="115" x2="216" y2="115" stroke="#FAF6F0" strokeWidth="5" />
      <rect x="32" y="198" width="196" height="8" rx="3" fill="#EDE3D4" />
    </g>
  )
}

function Tree({ x, y, h, band, snow }: { x: number; y: number; h: number; band: Band; snow?: boolean }): React.JSX.Element {
  const leaf = snow ? '#8FAA8F' : band === 'night' ? '#3C5A48' : band === 'evening' ? '#6E9560' : '#5F8F5A'
  return (
    <g>
      <rect x={x - 3} y={y + h * 0.55} width="6" height={h * 0.5} fill="#7A5A44" />
      <ellipse cx={x} cy={y + h * 0.35} rx={h * 0.45} ry={h * 0.42} fill={leaf} />
      {snow && <ellipse cx={x} cy={y + h * 0.1} rx={h * 0.3} ry={h * 0.12} fill="#FFFFFF" opacity="0.9" />}
    </g>
  )
}

function Books({ x, y }: { x: number; y: number }): React.JSX.Element {
  const spines = ['#B5836D', '#8FA3B5', '#C9B27A', '#9A8DA8', '#A8B59A']
  return (
    <g>
      {spines.map((c, i) => (
        <rect key={i} x={x + i * 12} y={y + (i % 2) * 3} width="10" height={26 - (i % 2) * 3} rx="1.5" fill={c} />
      ))}
      <rect x={x + 62} y={y + 14} width="26" height="12" rx="1.5" fill="#C9B27A" transform={`rotate(-90 ${x + 75} ${y + 20})`} />
    </g>
  )
}

function Plant({ x, y, winter }: { x: number; y: number; winter: boolean }): React.JSX.Element {
  return (
    <g>
      <path d={`M${x - 10} ${y + 22} L${x + 10} ${y + 22} L${x + 7} ${y + 38} L${x - 7} ${y + 38} Z`} fill="#C97C5A" />
      {winter ? (
        <path d={`M${x} ${y - 6} L${x + 11} ${y + 22} L${x - 11} ${y + 22} Z`} fill="#5F8F5A" />
      ) : (
        <g fill="#6E9560">
          <path d={`M${x} ${y + 22} q-14 -8 -8 -22 q10 6 8 22`} />
          <path d={`M${x} ${y + 22} q14 -8 8 -22 q-10 6 -8 22`} />
          <path d={`M${x} ${y + 22} q-2 -14 0 -26 q2 12 0 26`} />
        </g>
      )}
    </g>
  )
}

function Bookcase({ night }: { night: boolean }): React.JSX.Element {
  const spines = ['#B5836D', '#8FA3B5', '#C9B27A', '#9A8DA8', '#A8B59A', '#C48A7A', '#7F9C9A']
  return (
    <g>
      <rect x="36" y="26" width="188" height="180" rx="6" fill={night ? '#5A4636' : '#8B6A55'} />
      {[0, 1, 2].map((row) => (
        <g key={row}>
          <rect x="44" y={78 + row * 56} width="172" height="5" fill={night ? '#3E3026' : '#6A4F3E'} />
          {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x={48 + i * 14} y={46 + row * 56 + (i % 3) * 3} width="11" height={32 - (i % 3) * 3} rx="1.5" fill={spines[(i + row) % spines.length]} opacity={night ? 0.7 : 1} />
          ))}
        </g>
      ))}
    </g>
  )
}

/** A small side table with a pot on a single ring — only present while something is cooking. Steam rises gently. */
function Kitchen({ x, y, night }: { x: number; y: number; night: boolean }): React.JSX.Element {
  return (
    <g opacity={night ? 0.85 : 1}>
      {/* table */}
      <rect x={x} y={y + 30} width="62" height="6" rx="2" fill="#A87F5C" />
      <rect x={x + 6} y={y + 36} width="6" height="24" fill="#A87F5C" opacity="0.9" />
      <rect x={x + 50} y={y + 36} width="6" height="24" fill="#A87F5C" opacity="0.9" />
      {/* ring */}
      <ellipse cx={x + 31} cy={y + 30} rx="16" ry="3.5" fill="#5E4636" />
      <ellipse cx={x + 31} cy={y + 30} rx="10" ry="2" fill="#F2A65A" opacity="0.8" />
      {/* pot */}
      <rect x={x + 17} y={y + 10} width="28" height="20" rx="3" fill="#6E6259" />
      <rect x={x + 15} y={y + 8} width="32" height="4" rx="2" fill="#8A8078" />
      <path d={`M${x + 15} ${y + 18} h-6 M${x + 47} ${y + 18} h6`} stroke="#8A8078" strokeWidth="3" strokeLinecap="round" />
      <circle cx={x + 31} cy={y + 6} r="2.5" fill="#8A8078" />
      {/* steam */}
      <g stroke="#FFFFFF" strokeWidth="1.3" fill="none" opacity="0.6" className="steam">
        <path d={`M${x + 25} ${y + 2} q2 -5 0 -10`} />
        <path d={`M${x + 32} ${y} q-2 -5 0 -10`} />
        <path d={`M${x + 39} ${y + 2} q2 -5 0 -10`} />
      </g>
    </g>
  )
}

function Hearth({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g>
      <rect x={x} y={y} width="44" height="58" rx="4" fill="#8A7466" />
      <rect x={x + 6} y={y + 8} width="32" height="44" rx="3" fill="#2E2622" />
      <ellipse cx={x + 22} cy={y + 46} rx="30" ry="22" fill="url(#fireglow)" />
      <path d={`M${x + 14} ${y + 46} q4 -14 8 -6 q2 -10 6 -2 q3 -6 6 4 q2 8 -10 10 q-12 -2 -10 -6z`} fill="#F2A65A" opacity="0.95" />
      <path d={`M${x + 18} ${y + 46} q3 -8 5 -3 q2 -6 4 0 q2 6 -5 7 q-6 -1 -4 -4z`} fill="#FFD27A" />
      <rect x={x + 8} y={y + 48} width="28" height="4" rx="1" fill="#5E4636" />
    </g>
  )
}
