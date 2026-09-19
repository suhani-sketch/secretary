import { useEffect, useMemo, useState } from 'react'
import { Companion, poseFor } from './Companion'
import type { CompanionState, Gaze } from './companionState'
import { sceneWithAssets } from './scenes'
import { SceneRenderer } from './scenes/SceneRenderer'
import type { WorldContext, SceneSpot, SceneActivityKind } from './scenes/SceneDefinition'

/**
 * The room (spec §8 Phase 4, redone as a place in Phase 9a): a composed, layered environment the creature actually
 * inhabits, not a flat illustration behind it. Five real positions connect directly to what the creature is doing —
 * the desk and chair (working/writing), the armchair reading nook (reading), the window bench (waiting/looking out),
 * the sleeping nest (sleepy/curled up), and the open rug (everything else, idle). Depth comes from three honest,
 * cheap tricks rather than true 3D: a receding floor (the back edge is narrower than the front — forced perspective),
 * soft contact shadows under every piece of furniture so nothing floats, and near-things-are-bigger sizing on the
 * creature's own spot scale. Environments change the window and a few objects; time of day changes the light over
 * any environment, crossfading rather than swapping abruptly (9g). Favourites and rotation, weather, and objects
 * quietly accumulating with real use are all 9g too — none of it gamified: no unlock moment, no progress bar, no
 * "you earned a mug", just a room that is honestly a little different depending on what has actually happened.
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

/** A tiny deterministic hash of a calendar date — the same "changes slowly, restores identically after a
 *  restart" trick the ambient rotation (9c) already uses, so weather and scene rotation (9g) need no storage
 *  of their own: a fresh render on the same day always recomputes the same answer. */
function hashDay(dateISO: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < dateISO.length; i++) h = (Math.imul(h, 31) + dateISO.charCodeAt(i)) >>> 0
  return h
}

export type Weather = 'clear' | 'cloudy' | 'misty'
/** Weather-driven atmosphere (9g): changes once a day, mostly clear — a mood layered over whichever environment
 *  is showing, not a replacement for it (a literal rainstorm is already the "Rainy window" environment choice). */
export function weatherForDate(dateISO: string): Weather {
  const r = hashDay(dateISO, 7) % 100
  if (r < 60) return 'clear'
  if (r < 85) return 'cloudy'
  return 'misty'
}

/** Scene rotation (9g): a deterministic daily pick from the user's favourites, or all six if none are favourited. */
export function rotatedEnvironment(dateISO: string, favorites: EnvironmentId[]): EnvironmentId {
  const pool = favorites.length ? favorites : ENVIRONMENTS.map((e) => e.id)
  return pool[hashDay(dateISO, 13) % pool.length]
}

/** Light for each band: wall, floor, window sky gradient, sun/moon, lamp, and how much to dim the creature. */
const LIGHT: Record<Band, { wall: string; wall2: string; floor: string; floor2: string; sky: [string, string]; sun: string | null; moon: boolean; lamp: boolean; dim: number; desk: string }> = {
  morning: { wall: '#F6E9D8', wall2: '#EFDCC5', floor: '#D9C3A8', floor2: '#C7AC8C', sky: ['#BFD9EE', '#F7E3C9'], sun: '#F6D28A', moon: false, lamp: false, dim: 0, desk: '#B98F6A' },
  day: { wall: '#F1E9DF', wall2: '#E8DCCB', floor: '#D3BEA3', floor2: '#C0A583', sky: ['#A9CDEB', '#DCEBF7'], sun: '#FBE7A1', moon: false, lamp: false, dim: 0, desk: '#B48A66' },
  evening: { wall: '#EDD6BE', wall2: '#DFBE9E', floor: '#C7A98A', floor2: '#B4926F', sky: ['#E9A46B', '#F6D2A6'], sun: '#F3B25E', moon: false, lamp: true, dim: 0.05, desk: '#A87F5C' },
  night: { wall: '#4A4652', wall2: '#3B3843', floor: '#37343E', floor2: '#2C2A33', sky: ['#1E2340', '#2F3457'], sun: null, moon: true, lamp: true, dim: 0.35, desk: '#6E5745' }
}

interface Props {
  state: CompanionState
  gaze: Gaze
  environment: EnvironmentId
  time: TimeChoice
  /** Living activities (Phase 5): 'cooking' puts a small kitchen object in the room and the creature beside it. */
  happening: 'focus' | 'cooking' | 'waiting' | null
  /** Direct interaction (9d) — clicking the creature itself, for no functional reason. */
  onPet: () => void
  onChangeEnvironment: (e: EnvironmentId) => void
  onChangeTime: (t: TimeChoice) => void
  /** Room persistence (9g): favourited environments and whether the room is rotating through them on its own. */
  favorites: EnvironmentId[]
  rotation: boolean
  onToggleFavorite: (e: EnvironmentId) => void
  onToggleRotation: () => void
  /** Objects accumulate naturally (9g) — a real, always-freshly-computed count, never a stored "unlock". */
  completedCount: number
  /** Dev/test hook only (matches the existing #state:/#light: forcing): overrides the computed weather. */
  weatherOverride?: Weather
  /** Personality's preferred idle resting spot (creature-presence pass, 2026-09-19). Small, single wiring
   *  change: when the creature is idle (pose === 'sit'), the default position picks based on this instead of
   *  always the rug — two creatures with different `restingSpot` values visibly idle in different places. */
  restingSpot?: 'nest' | 'armchair' | 'bench' | 'rug'
}

export function Room({ state, gaze, environment, time, happening, onPet, onChangeEnvironment, onChangeTime, favorites, rotation, onToggleFavorite, onToggleRotation, completedCount, weatherOverride, restingSpot = 'rug' }: Props): React.JSX.Element {
  const [hour, setHour] = useState(new Date().getHours())
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  useEffect(() => {
    const t = setInterval(() => {
      setHour(new Date().getHours())
      setToday(new Date().toISOString().slice(0, 10))
    }, 60_000)
    return () => clearInterval(t)
  }, [])
  const band: Band = time === 'auto' ? bandForHour(hour) : time
  const L = LIGHT[band]
  // Rotation (9g) picks the environment on its own, once a day, from favourites; a manual pick (below) turns it off.
  const activeEnvironment = rotation ? rotatedEnvironment(today, favorites) : environment
  const weather = weatherOverride ?? weatherForDate(today)
  // World redesign (2026-09-19) — scene-with-assets short-circuit. All hooks below run every render regardless of
  // which branch we take, so the hook-order rule is preserved when the scene switches.
  const scene = sceneWithAssets(activeEnvironment)
  const worldContext: WorldContext | null = useMemo(() => (scene ? { scene, lightBand: band, transition: null } : null), [scene, band])
  // While something cooks, an idle or window-gazing creature waits beside the kitchen object instead (spec Phase 5).
  const basePose = poseFor(state)
  const pose = happening === 'cooking' && (basePose === 'sit' || basePose === 'window') ? 'kitchen' : basePose
  const [menu, setMenu] = useState(false)

  // World redesign — if the current scene has assets, render via SceneRenderer. Every existing hook above has
  // already run; the branch happens after the hook block so the hook-order rule stays satisfied.
  if (scene && worldContext) {
    const preferredSpot = pickSceneSpot(scene.spots, mapStateToSceneActivity(state), restingSpot, scene.restingSpotMap)
    const sceneGaze: Gaze =
      preferredSpot.gaze === 'book' ? 'desk'
      : preferredSpot.gaze === 'closed' ? 'closed'
      : preferredSpot.gaze === 'window' ? 'window'
      : preferredSpot.gaze === 'desk' ? 'desk'
      : preferredSpot.gaze === 'viewer' ? 'viewer'
      : preferredSpot.gaze === 'away-up' ? 'away'
      : 'away'
    return (
      <div className="relative h-full w-full">
        <SceneRenderer world={worldContext} state={state} gaze={sceneGaze} spot={{ x: preferredSpot.x, y: preferredSpot.y, scale: preferredSpot.scale }} onPet={onPet} />
        {/* Preserve the scene menu so the user can still switch worlds (back to a legacy SVG environment or to
            the same illustrated scene). Same visual pill as the legacy path. */}
        <button className="absolute top-3 right-3 z-10 rounded-full text-[10px] tracking-[0.14em] uppercase px-2.5 py-1 font-medium" style={{ background: 'rgba(233,219,193,0.75)', color: '#3A2D28', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }} onClick={() => setMenu((v) => !v)}>
          {ENVIRONMENTS.find((e) => e.id === activeEnvironment)?.label ?? 'Scene'}
        </button>
        {menu && (
          <div className="absolute top-11 right-3 z-10 rounded-xl shadow-lg p-2 text-xs flex flex-col gap-0.5 min-w-52 border border-[color:var(--color-zone-border)]" style={{ background: 'var(--color-paper)' }} onMouseLeave={() => setMenu(false)}>
            <div className="uppercase tracking-[0.16em] text-ash text-[10px] px-2 py-1">Scene</div>
            {ENVIRONMENTS.map((e) => (
              <button key={e.id} onClick={() => { setMenu(false); onChangeEnvironment(e.id) }} className={`px-2 py-1.5 rounded text-left text-[12px] ${activeEnvironment === e.id ? 'bg-cocoa text-cream' : 'hover:bg-[color:var(--color-paper-2)] text-cocoa'}`}>
                <span className="mr-1.5">{e.emoji}</span>{e.label}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Five real positions, each tied to a piece of furniture the creature actually occupies (spec 9a) — never a bare
  // spot on the floor. Scale rises slightly for anything nearer the viewer (further down the receding floor), the
  // same forced-perspective cue the floor itself uses, so the creature's own size stays honest to where it is sitting.
  /* Product-thesis reshape (2026-09-19): the default idle position moved upstage on the floor, and scaled down
     slightly, so the creature reads as inhabiting the room rather than posing at the very front of the frame.
     Furniture positions unchanged — those already sit naturally on the floor plane.
     Creature-presence pass: personality.restingSpot varies the DEFAULT (sit) position between four real spots
     that already exist in the room — so two creatures with different seeds visibly idle in different places
     without any new furniture or new state. All active poses (desk/read/window/curl/kitchen) stay untouched. */
  const defaultSpot = restingSpot === 'armchair' ? { x: 138, y: 440, s: 0.82 } // perched on the armchair, awake
    : restingSpot === 'bench' ? { x: 30, y: 288, s: 0.74 } // near the window bench, standing
    : restingSpot === 'nest' ? { x: 30, y: 730, s: 0.86 } // near the nest but not curled up
    : { x: 128, y: 620, s: 0.92 } // the open rug (rug preference or default)
  const spot =
    pose === 'desk' ? { x: 60, y: 610, s: 0.88 } // at the desk chair, facing the laptop
    : pose === 'read' ? { x: 138, y: 420, s: 0.82 } // sitting in the reading armchair
    : pose === 'window' ? { x: 22, y: 249, s: 0.74 } // perched on the window bench
    : pose === 'curl' ? { x: 10, y: 765, s: 0.78 } // asleep in the nest
    : pose === 'kitchen' ? { x: 82, y: 692, s: 0.95 }
    : defaultSpot // sit / attentive / thinking / concerned / etc — biased by personality

  return (
    /* Product-thesis reshape (2026-09-19): no rounded outline, no inner shadow, no distinct wall colour — the
       room bleeds into the world. Cream page background shows through wherever no furniture, floor, window or
       creature is drawn. The window frame is now the only rectangular element in the room, exactly as intended:
       the window is the frame IN the world, not the frame OF the world. */
    <div className="relative h-full w-full">
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
          <linearGradient id="floorShade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={L.floor} style={{ transition: 'stop-color 2s ease' }} />
            <stop offset="1" stopColor={L.floor2} style={{ transition: 'stop-color 2s ease' }} />
          </linearGradient>
          <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.4" fill="#000" opacity="0.035" />
            <circle cx="3" cy="3" r="0.4" fill="#000" opacity="0.025" />
          </pattern>
        </defs>

        {/* No wall rectangle — the page cream shows through, so the room bleeds into the world instead of
            reading as a framed illustration. A single very-soft warm wash covers where the wall used to be, so
            the room still has *some* atmospheric warmth against the outside cream. */}
        <rect x="0" y="0" width="260" height="900" fill={L.wall2} opacity="0.18" />

        {/* the window zone — unchanged from Phase 4: view, shelf, books, plant */}
        <g transform="translate(0 60)">
          {activeEnvironment === 'library' ? <Bookcase night={band === 'night'} /> : <Window env={activeEnvironment} band={band} L={L} weather={weather} />}
          <rect x="24" y="238" width="212" height="6" rx="2" fill={L.desk} style={{ transition: 'fill 2s ease' }} />
          <rect x="24" y="244" width="212" height="3" fill="#000" opacity="0.06" />
          <Books x={30} y={212} />
          <rect x="118" y="220" width="30" height="18" rx="3" fill="#C9B29A" />
          <rect x="118" y="218" width="30" height="5" rx="2" fill="#B39B82" />
          <Plant x={196} y={200} winter={activeEnvironment === 'winter'} />
          {/* objects accumulate naturally (9g): a small stack of mementos once real project history has actually
              accumulated — no announcement, no unlock moment, just quietly true or not each time the room renders */}
          {completedCount >= 3 && <Mementos x={168} y={214} />}
        </g>

        {/* the reading nook — new (9a): fills what used to be a flat, empty stretch of wall with an actual place to
            sit and read, plus a low bench tucked under the window so "by the window" is somewhere to perch, not just
            standing in open floor. Both sit against the back wall, above where the floor begins. */}
        <ellipse cx="66" cy="366" rx="30" ry="6" fill="#000" opacity="0.08" />
        <Bench x={36} y={330} desk={L.desk} />
        <ellipse cx="118" cy="536" rx="24" ry="5" fill="#000" opacity="0.1" />
        <ellipse cx="187" cy="538" rx="52" ry="9" fill="#000" opacity="0.1" />
        <SideTable x={98} y={478} desk={L.desk} />
        <Armchair x={140} y={368} night={band === 'night'} />

        {/* the floor — a forced-perspective trapezoid (narrower where it meets the wall, full width at the front)
            so the room visibly recedes instead of the furniture just floating on a flat band of colour. */}
        <path d="M72 562 L188 562 L258 900 L2 900 Z" fill="url(#floorShade)" style={{ transition: 'fill 2s ease' }} />
        <path d="M72 562 L188 562" stroke="#000" strokeWidth="3" opacity="0.1" />
        <ellipse cx="150" cy="792" rx="98" ry="20" fill="#B5836D" opacity={band === 'night' ? 0.32 : 0.26} />
        <ellipse cx="150" cy="792" rx="80" ry="15" fill="none" stroke="#FAF6F0" strokeWidth="1.5" opacity="0.45" />

        {/* the sleeping nest — new (9a): a small woven basket with a soft cushion, tucked to one side, away from
            the desk. Its own place, not a repurposed rug corner. */}
        <ellipse cx="54" cy="856" rx="42" ry="10" fill="#000" opacity="0.12" />
        <Nest x={16} y={806} night={band === 'night'} />

        {/* the desk, its chair, and everything on the desktop */}
        <ellipse cx="108" cy="828" rx="98" ry="14" fill="#000" opacity="0.12" />
        <Chair x={44} y={706} desk={L.desk} />
        <rect x="18" y="666" width="180" height="10" rx="3" fill={L.desk} style={{ transition: 'fill 2s ease' }} />
        <rect x="26" y="676" width="8" height="64" fill={L.desk} opacity="0.9" />
        <rect x="176" y="676" width="8" height="64" fill={L.desk} opacity="0.9" />
        {/* laptop: lid open only while working */}
        <g style={{ transition: 'transform .6s ease', transformOrigin: '96px 666px', transform: pose === 'desk' ? 'none' : 'scaleY(0.12)' }}>
          <rect x="72" y="632" width="50" height="34" rx="3" fill="#6E6259" />
          <rect x="75" y="635" width="44" height="26" rx="2" fill={pose === 'desk' ? '#E8EEF3' : '#8A8078'} />
        </g>
        <rect x="70" y="664" width="54" height="4" rx="1.5" fill="#8A7B6E" />
        {/* notebook + pencil */}
        <rect x="132" y="654" width="34" height="14" rx="2" fill="#FAF6F0" transform="rotate(-8 149 661)" />
        <line x1="136" y1="658" x2="160" y2="655" stroke="#D8CDBF" strokeWidth="1" transform="rotate(-8 149 661)" />
        <line x1="136" y1="662" x2="158" y2="659" stroke="#D8CDBF" strokeWidth="1" transform="rotate(-8 149 661)" />
        {/* mug (steam in the morning) */}
        <rect x="42" y="650" width="14" height="16" rx="3" fill="#E7D9C9" />
        <path d="M56 654 q6 0 6 5 q0 5 -6 5" stroke="#E7D9C9" strokeWidth="2.5" fill="none" />
        {band === 'morning' && (
          <g stroke="#FFFFFF" strokeWidth="1.2" fill="none" opacity="0.6" className="steam">
            <path d="M46 646 q2 -4 0 -8" />
            <path d="M51 646 q-2 -4 0 -8" />
          </g>
        )}
        {/* pencil cup */}
        <rect x="160" y="656" width="10" height="12" rx="2" fill="#B5836D" />
        <line x1="163" y1="656" x2="163" y2="646" stroke="#C99C5A" strokeWidth="2" />
        <line x1="167" y1="656" x2="168" y2="647" stroke="#6E6259" strokeWidth="2" />
        {/* lamp */}
        <g>
          <rect x="188" y="650" width="3" height="18" fill="#5E4636" />
          <path d="M176 652 L204 652 L198 640 L182 640 Z" fill="#B5836D" />
          <ellipse cx="190" cy="668" rx="8" ry="2.5" fill="#5E4636" />
          {L.lamp && <ellipse cx="190" cy="690" rx="70" ry="50" fill="url(#lampglow)" style={{ transition: 'opacity 2s ease' }} />}
        </g>

        {/* fireplace environment: a small hearth on the left */}
        {activeEnvironment === 'fireplace' && <Hearth x={14} y={682} />}

        {/* living activities: a small kitchen object appears only while something cooks (spec Phase 5) */}
        {/* a real cooking happening (Phase 5) OR the creature's own ambient decision to make tea (9c) — either
            way the room shows the same small kitchen object; only one of the two ever creates a real row. */}
        {(happening === 'cooking' || pose === 'kitchen') && <Kitchen x={190} y={694} night={band === 'night'} />}

        {/* paper grain, over everything */}
        <rect x="0" y="0" width="260" height="900" fill="url(#grain)" />
      </svg>

      {/* the creature, placed by pose at one of the five real positions above */}
      <div
        className="absolute"
        style={{
          left: `${(spot.x / 260) * 100}%`,
          top: `${(spot.y / 900) * 100}%`,
          width: `${(120 * spot.s) / 2.6}%`,
          transition: 'left .7s cubic-bezier(.4,0,.2,1), top .7s cubic-bezier(.4,0,.2,1), width .7s ease'
        }}
      >
        {/* clicking is its own interaction (9d) — no functional purpose, just because the user likes to */}
        <div style={{ width: '100%', aspectRatio: '1 / 1', cursor: 'pointer' }} onClick={onPet} role="button" aria-label="Pet the creature" title="Say hello">
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
          <div className="flex items-center justify-between">
            <span className="text-stone-500">Window</span>
            {/* rotation (9g): the room picks among favourites on its own, once a day, instead of staying fixed */}
            <button
              onClick={onToggleRotation}
              className={`rounded-lg px-2 py-0.5 ${rotation ? 'bg-cocoa text-cream' : 'bg-white/70 text-stone-700 hover:bg-white'}`}
              title="Let the room change its own view, day to day, from your favourites"
            >
              🔀 rotate
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {ENVIRONMENTS.map((e) => (
              <span key={e.id} className={`rounded-lg flex items-center overflow-hidden ${activeEnvironment === e.id ? 'bg-cocoa text-cream' : 'bg-white/70 text-stone-700'}`}>
                <button onClick={() => onChangeEnvironment(e.id)} className="px-2 py-1 hover:opacity-80" title="Pick this view directly (turns rotation off)">
                  {e.emoji} {e.label}
                </button>
                {/* favourite (9g) — only meaningful once rotation is on, but can be set any time */}
                <button onClick={() => onToggleFavorite(e.id)} className="pr-1.5 opacity-70 hover:opacity-100" title={favorites.includes(e.id) ? 'Remove from favourites' : 'Add to favourites'}>
                  {favorites.includes(e.id) ? '★' : '☆'}
                </button>
              </span>
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

function Window({ env, band, L, weather }: { env: EnvironmentId; band: Band; L: (typeof LIGHT)[Band]; weather: Weather }): React.JSX.Element {
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
      {/* weather (9g): clouds soften the sky before the sun/moon; kept subtle, a mood over the scene rather than
          a replacement for it — a literal storm is already the "Rainy window" environment. */}
      {weather === 'cloudy' && (
        <g opacity="0.6" style={{ transition: 'opacity 2.5s ease' }}>
          <ellipse cx="82" cy="52" rx="30" ry="12" fill="#EDEAE3" />
          <ellipse cx="116" cy="46" rx="22" ry="10" fill="#EDEAE3" />
          <ellipse cx="58" cy="58" rx="16" ry="7" fill="#EDEAE3" />
        </g>
      )}
      {/* sun / moon: always mounted, crossfading via opacity — a band change used to pop one out and the other in
          with no transition at all; this is the "no abrupt swap" fix (9g). */}
      <circle
        cx={band === 'morning' ? 70 : band === 'day' ? 130 : 190}
        cy={band === 'day' ? 60 : 92}
        r="14"
        fill={L.sun ?? LIGHT.evening.sun!}
        opacity={L.sun ? 0.95 : 0}
        style={{ transition: 'opacity 2.5s ease, cx 2.5s ease, cy 2.5s ease' }}
      />
      <g opacity={L.moon ? 1 : 0} style={{ transition: 'opacity 2.5s ease' }}>
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
      {/* misty weather (9g) sits closest to the viewer, a soft ground fog over whatever else is in the window */}
      {weather === 'misty' && (
        <g style={{ transition: 'opacity 2.5s ease' }}>
          <ellipse cx="130" cy="176" rx="95" ry="16" fill="#D9D5CB" opacity="0.7" />
          <ellipse cx="130" cy="190" rx="95" ry="12" fill="#D9D5CB" opacity="0.85" />
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

/** Objects accumulate naturally (9g) — a small, quiet stack of finished things once there genuinely have been a
 *  few, sitting on the shelf like any other small object. No badge, no counter, no fanfare on the shelf itself —
 *  just there, or not, exactly like everything else in the room. */
function Mementos({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g style={{ transition: 'opacity 1.5s ease' }}>
      <ellipse cx={x + 8} cy={y + 20} rx="9" ry="3" fill="#B5836D" />
      <ellipse cx={x + 8} cy={y + 16} rx="9" ry="3" fill="#C9A688" />
      <ellipse cx={x + 8} cy={y + 12} rx="9" ry="3" fill="#D9B79F" />
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

/** The desk chair (9a) — a real place to sit at the desk, not just a spot on the floor beside it. A plain ladder
 *  back reads clearly even where the creature covers most of it, unlike the earlier wedge-shaped silhouette. */
function Chair({ x, y, desk }: { x: number; y: number; desk: string }): React.JSX.Element {
  return (
    <g>
      <rect x={x + 8} y={y - 54} width="26" height="42" rx="4" fill={desk} opacity="0.88" />
      <rect x={x + 12} y={y - 44} width="18" height="4" rx="1.5" fill="#000" opacity="0.08" />
      <rect x={x + 12} y={y - 34} width="18" height="4" rx="1.5" fill="#000" opacity="0.08" />
      <rect x={x} y={y - 6} width="40" height="9" rx="2" fill={desk} />
      <rect x={x + 4} y={y + 3} width="5" height="34" fill={desk} opacity="0.85" />
      <rect x={x + 31} y={y + 3} width="5" height="34" fill={desk} opacity="0.85" />
    </g>
  )
}

/** The reading armchair (9a) — deep seat, rolled arms, a soft blanket over one side; the room's second real place
 *  to be, distinct in feel from the desk's upright working posture. Dusty blue-grey, the app's own "slate-soft"
 *  tone — muted pastel, not an invented colour outside the established palette. */
function Armchair({ x, y, night }: { x: number; y: number; night: boolean }): React.JSX.Element {
  const body = night ? '#5F7588' : '#8FA3B5'
  const bodyDark = night ? '#4C5F70' : '#758DA0'
  return (
    <g>
      {/* legs */}
      <rect x={x + 6} y={y + 154} width="6" height="16" fill="#5E4636" />
      <rect x={x + 82} y={y + 154} width="6" height="16" fill="#5E4636" />
      {/* back */}
      <path d={`M${x} ${y + 40} Q${x - 4} ${y - 6} ${x + 47} ${y - 10} Q${x + 98} ${y - 6} ${x + 94} ${y + 40} L${x + 94} ${y + 108} L${x} ${y + 108} Z`} fill={body} />
      {/* seat cushion */}
      <path d={`M${x - 6} ${y + 96} Q${x - 6} ${y + 132} ${x + 8} ${y + 138} L${x + 86} ${y + 138} Q${x + 100} ${y + 132} ${x + 100} ${y + 96} Z`} fill={bodyDark} />
      {/* arms */}
      <path d={`M${x - 14} ${y + 46} Q${x - 20} ${y + 46} ${x - 20} ${y + 66} L${x - 20} ${y + 118} Q${x - 20} ${y + 132} ${x - 4} ${y + 132} L${x - 4} ${y + 60} Z`} fill={body} />
      <path d={`M${x + 108} ${y + 46} Q${x + 114} ${y + 46} ${x + 114} ${y + 66} L${x + 114} ${y + 118} Q${x + 114} ${y + 132} ${x + 98} ${y + 132} L${x + 98} ${y + 60} Z`} fill={body} />
      {/* a folded blanket over the near arm — lived-in, not staged */}
      <path d={`M${x - 18} ${y + 72} Q${x - 4} ${y + 66} ${x + 6} ${y + 76} L${x + 2} ${y + 100} Q${x - 12} ${y + 96} ${x - 20} ${y + 100} Z`} fill="#D9B79F" opacity="0.9" />
      <path d={`M${x - 14} ${y + 78} q10 -4 16 2`} stroke="#C9A688" strokeWidth="1.2" fill="none" opacity="0.7" />
    </g>
  )
}

/** A small side table beside the armchair — two stacked books and a tiny succulent, the only "extras" this slice
 *  allows itself, since they make the reading spot legible without turning into clutter. */
function SideTable({ x, y, desk }: { x: number; y: number; desk: string }): React.JSX.Element {
  return (
    <g>
      <rect x={x + 6} y={y + 40} width="4" height="20" fill={desk} opacity="0.85" />
      <rect x={x + 30} y={y + 40} width="4" height="20" fill={desk} opacity="0.85" />
      <ellipse cx={x + 20} cy={y + 40} rx="22" ry="6" fill={desk} />
      <rect x={x + 6} y={y + 26} width="24" height="7" rx="1.5" fill="#9A8DA8" transform={`rotate(-3 ${x + 18} ${y + 30})`} />
      <rect x={x + 8} y={y + 20} width="20" height="7" rx="1.5" fill="#B5836D" transform={`rotate(2 ${x + 18} ${y + 24})`} />
      <path d={`M${x + 30} ${y + 32} l6 0 l-1 6 l-4 0z`} fill="#C97C5A" />
      <g fill="#6E9560">
        <path d={`M${x + 33} ${y + 32} q-4 -8 0 -14 q3 6 0 14`} />
        <path d={`M${x + 33} ${y + 32} q4 -6 1 -12 q-2 5 -1 12`} />
      </g>
    </g>
  )
}

/** The low bench under the window (9a) — somewhere to actually perch while looking out, not just standing on bare
 *  floor beneath the glass. */
function Bench({ x, y, desk }: { x: number; y: number; desk: string }): React.JSX.Element {
  return (
    <g>
      <rect x={x} y={y + 18} width="60" height="8" rx="3" fill={desk} />
      <rect x={x + 4} y={y + 26} width="5" height="12" fill={desk} opacity="0.85" />
      <rect x={x + 51} y={y + 26} width="5" height="12" fill={desk} opacity="0.85" />
      <ellipse cx={x + 30} cy={y + 12} rx="26" ry="9" fill="#C9A88F" />
      <ellipse cx={x + 30} cy={y + 9} rx="26" ry="8" fill="#D9B79F" />
    </g>
  )
}

/** The sleeping nest (9a) — a woven basket with a soft cushion, the room's own answer to "where does it sleep". */
function Nest({ x, y, night }: { x: number; y: number; night: boolean }): React.JSX.Element {
  const weave = night ? '#6E5745' : '#A87F5C'
  return (
    <g>
      <ellipse cx={x + 40} cy={y + 40} rx="42" ry="18" fill={weave} />
      <ellipse cx={x + 40} cy={y + 34} rx="38" ry="15" fill={night ? '#5E4636' : '#96694A'} />
      {Array.from({ length: 6 }).map((_, i) => (
        <path key={i} d={`M${x + 6 + i * 13} ${y + 24} q4 10 0 20`} stroke={weave} strokeWidth="1.2" fill="none" opacity="0.55" />
      ))}
      <ellipse cx={x + 40} cy={y + 30} rx="30" ry="10" fill="#D9B79F" opacity={night ? 0.75 : 0.95} />
      <ellipse cx={x + 40} cy={y + 27} rx="30" ry="8" fill="#E7D9C9" opacity={night ? 0.7 : 0.9} />
    </g>
  )
}

/**
 * Maps a CompanionState to the scene-scoped activity kind. Every ambient state resolves to something the scene's
 * spot list understands. Kept small: the scene's behavior weights are the real driver of which activity a
 * creature ends up doing; this function only bridges the SIGNALS-driven state machine to the scene's activity
 * vocabulary. Unknown states fall through to 'idle'.
 */
function mapStateToSceneActivity(state: CompanionState): SceneActivityKind {
  switch (state) {
    case 'reading': return 'reading'
    case 'writing': return 'writing'
    case 'working': return 'working'
    case 'looking': return 'looking'
    case 'sleepy': return 'sleepy'
    case 'sleeping': return 'sleeping'
    case 'tea': return 'tea'
    case 'stretching': return 'stretching'
    case 'attentive':
    case 'petted':
    case 'greeting':
    case 'listening':
    case 'happy':
    case 'celebrating':
    case 'quietlyExcited':
      return 'attentive'
    case 'concerned':
    case 'recovering':
    case 'thinking':
    case 'waiting':
    case 'awake':
    default:
      return 'idle'
  }
}

/**
 * Picks the best scene spot for the current activity + personality preferences. Strategy:
 *   1. Prefer any spot whose activity exactly matches the requested activity.
 *   2. If multiple match, prefer the one whose furniture matches the personality's restingSpot mapping.
 *   3. If no exact match, fall back to the personality's restingSpot mapping directly.
 *   4. If that spot doesn't exist in this scene, fall back to 'rug-center' or the first spot in the list.
 */
function pickSceneSpot(
  spots: SceneSpot[],
  activity: SceneActivityKind,
  restingSpot: 'nest' | 'armchair' | 'bench' | 'rug',
  restingSpotMap: Record<string, string | undefined>
): SceneSpot {
  const exactMatches = spots.filter((s) => s.activity === activity)
  if (exactMatches.length) {
    // Bias toward the resting-spot-derived preference when multiple options exist.
    const preferredId = restingSpotMap[restingSpot]
    const preferred = preferredId ? exactMatches.find((s) => s.id === preferredId) : undefined
    return preferred ?? exactMatches[0]
  }
  const restingSpotId = restingSpotMap[restingSpot]
  if (restingSpotId) {
    const spot = spots.find((s) => s.id === restingSpotId)
    if (spot) return spot
  }
  return spots.find((s) => s.id === 'rug-center') ?? spots[0]
}
