/**
 * Library scene — stylized illustrated interior (2026-09-19).
 *
 * Hand-crafted SVG interior inspired by the illustrated Library reference. NOT a photograph, NOT clip-art — a
 * stylized editorial illustration with muted gradients, warm shadows, and believable furniture proportions the
 * creature can genuinely inhabit at correct scale.
 *
 * Composition (portrait viewBox 500 x 900):
 *   - Back wall: warm walnut with subtle vertical panel divisions
 *   - Right ~60%: tall floor-to-ceiling walnut bookshelves with textural spines
 *   - Left ~25%: tall narrow walnut-framed window with cool cloudy sky and hint of trees
 *   - Rolling library ladder against the shelves, brass rail at top
 *   - Wingback chair (olive leather) mid-right on the floor plane
 *   - Small round side table beside the chair with a stack of books + steaming mug
 *   - Brass floor lamp beside the chair with cream shade — warm halo
 *   - Rug beneath the chair with warm rust + olive pattern
 *   - Wooden floor with visible plank grain and forced perspective receding to shelves
 *   - Reading desk on the left with wooden desk chair (in the foreground layer)
 *   - Brass desk lamp, open book, quill (in the foreground layer)
 *
 * Split as two rendered layers to allow creature occlusion at the desk. The `background` layer covers everything
 * behind and beside the creature; the `foreground` layer contains the desk + desk lamp + on-desk objects,
 * rendered ABOVE the creature.
 */

interface Props {
  band: 'morning' | 'day' | 'evening' | 'night'
  layer: 'background' | 'foreground'
}

// Palette — one coordinated system (colour-coordination pass, 2026-09-19). Previously each element was tuned
// on its own and the palette drifted: cool blue-gray sky, cool olive chair, cool navy books, warm walnut room.
// Now everything sits on ONE axis: warm cocoa base, mossy-mocha midtones, brass highlights, dusty rose accents
// echoing the pink dawn sky. No cool blues, no bright creams, no rainbow spines. The room feels like one place
// under one light.
const P = {
  // Warm cocoa base — the room's foundational browns
  wall: '#3A2822',
  wallLight: '#553A2E',
  wallHighlight: '#75543F',
  shelf: '#251712',
  shelfEdge: '#4A3226',
  shelfHighlight: '#6B4A38',
  // Book spines: an earthen palette that harmonizes with the room, no cool navy or bright cream. Deep moss,
  // warm ox-blood, warm sand, dusty rose, burnt brass, dark cocoa — five neighbours on the warm side of the
  // wheel, no primary colors.
  bookGreen: '#4E5942',
  bookOxblood: '#6E362E',
  bookCream: '#B49C7E',
  bookNavy: '#4A3E38',   // no longer navy — a warm dark cocoa
  bookBrass: '#9E7A44',
  bookMuted: '#3F352B',
  bookRose: '#8E5C57',   // dusty rose spine echoing the sky
  // Wooden floor + warm rug that pulls the pink from the window down into the room
  floor: '#4A3222',
  floorHigh: '#68452F',
  floorPlank: '#382217',
  rug: '#6E4232',        // warm rust
  rugPattern: '#8E5C57', // dusty rose pattern (echoes sky)
  rugRust: '#A87266',
  // Wingback — mossy mocha, warmer than the previous pure olive. Sits comfortably beside the walnut.
  chairOlive: '#4C4E3E',
  chairOliveDark: '#363828',
  chairOliveLight: '#666852',
  chairHighlight: '#7A7C65',
  chairShadow: '#252718',
  // Warm brass, less bright so it doesn't blow out in dark mode
  brass: '#A0793F',
  brassDark: '#7E5C24',
  lampShade: '#D6C08E',   // warmer cream shade
  lampShadeDark: '#B6A16E',
  lampWarm: '#D69863',
  // Window sky: dusty pink dawn — the source of the room's rose accents. Kept from the previous pass.
  sky: '#E6C7C0',
  skyLower: '#F1DAC7',
  skyHighlight: '#F4DFD7',
  cloud: '#F0DAD0',
  cloudDeep: '#D8B2A6',
  sun: '#F5D1A6',
  bird: '#5A3E36',
  tree: '#4E5442',       // warm mossy — matches the wingback family
  treeDark: '#353A2C',
  windowFrame: '#4A3226',
  // Desk warms up alongside the floor
  desk: '#3A2317',
  deskHigh: '#5A3A28',
  deskShadow: '#1F130D',
  paper: '#D6C08E',      // paper matches lamp shades, one warm cream instead of many
  paperShadow: '#B6A16E',
  mug: '#D5C8A5',
  mugShadow: '#9F8E6A',
  steam: '#E8DEC9'
}

export function LibraryScene({ band, layer }: Props): React.JSX.Element {
  const dim = band === 'night' ? 0.35 : band === 'evening' ? 0.12 : 0
  return (
    <svg viewBox="0 0 500 900" preserveAspectRatio="xMidYMax meet" className="absolute inset-0 w-full h-full" aria-hidden>
      <defs>
        {/* Grain filter to give surfaces a painterly texture */}
        <filter id="lib-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence baseFrequency="0.9" numOctaves="2" seed="4" />
          <feColorMatrix values="0 0 0 0 0.15   0 0 0 0 0.1   0 0 0 0 0.06   0 0 0 0.08 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
        {/* Wooden plank grain */}
        <filter id="lib-wood" x="0" y="0" width="100%" height="100%">
          <feTurbulence baseFrequency="0.02 0.15" numOctaves="2" seed="8" />
          <feColorMatrix values="0 0 0 0 0.12   0 0 0 0 0.06   0 0 0 0 0.02   0 0 0 0.22 0" />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
        <linearGradient id="lib-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.wall} />
          <stop offset="0.4" stopColor={P.wallLight} />
          <stop offset="1" stopColor={P.wall} />
        </linearGradient>
        <linearGradient id="lib-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.floorPlank} />
          <stop offset="1" stopColor={P.floorHigh} />
        </linearGradient>
        <linearGradient id="lib-desk-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.deskHigh} />
          <stop offset="1" stopColor={P.desk} />
        </linearGradient>
        <linearGradient id="lib-chair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.chairOliveLight} />
          <stop offset="0.5" stopColor={P.chairOlive} />
          <stop offset="1" stopColor={P.chairOliveDark} />
        </linearGradient>
        <linearGradient id="lib-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.sky} />
          <stop offset="1" stopColor={P.skyLower} />
        </linearGradient>
        <radialGradient id="lib-lamp-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={P.lampWarm} stopOpacity="0.75" />
          <stop offset="0.5" stopColor={P.lampWarm} stopOpacity="0.25" />
          <stop offset="1" stopColor={P.lampWarm} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lib-mug-steam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={P.steam} stopOpacity="0.6" />
          <stop offset="1" stopColor={P.steam} stopOpacity="0" />
        </linearGradient>
      </defs>

      {layer === 'background' && (
        <g>
          {/* --- Back wall --- */}
          <rect x="0" y="0" width="500" height="700" fill="url(#lib-wall)" />
          <rect x="0" y="0" width="500" height="700" fill="url(#lib-wall)" filter="url(#lib-grain)" />
          {/* Subtle vertical panel divisions on the wall */}
          {[80, 160, 240].map((x) => (
            <rect key={x} x={x} y="0" width="1" height="700" fill={P.shelf} opacity="0.25" />
          ))}

          {/* --- Left window --- dusty pink dawn (creature-cuter pass, 2026-09-19). A calm neutral pink sky
              instead of the previous blue-gray daylight, with a soft sun, rim-lit clouds, small silhouette
              birds, and warmer green trees to complement the palette. Not candy pink, not sunset — an early
              overcast dawn painted the way the rest of the room is painted: warm and considered. */}
          <g>
            {/* Frame — slightly softer than pitch-dark */}
            <rect x="18" y="60" width="102" height="500" fill={P.wall} opacity="0.5" />
            <rect x="24" y="66" width="90" height="488" fill={P.shelfEdge} />
            {/* Glass — pink→apricot gradient */}
            <rect x="30" y="72" width="78" height="470" fill="url(#lib-sky)" />
            {/* Soft warm sun disk, upper-right of the top pane */}
            <circle cx="92" cy="110" r="12" fill={P.sun} opacity="0.85" />
            <circle cx="92" cy="110" r="18" fill={P.sun} opacity="0.28" />
            {/* Cloud band across the top pane — layered so they have soft undersides and lit rims */}
            <ellipse cx="55" cy="140" rx="28" ry="8" fill={P.cloudDeep} opacity="0.55" />
            <ellipse cx="55" cy="137" rx="26" ry="7" fill={P.cloud} opacity="0.85" />
            <ellipse cx="55" cy="135" rx="18" ry="4" fill={P.skyHighlight} opacity="0.55" />
            <ellipse cx="85" cy="180" rx="20" ry="6" fill={P.cloudDeep} opacity="0.5" />
            <ellipse cx="85" cy="177" rx="19" ry="5" fill={P.cloud} opacity="0.8" />
            <ellipse cx="45" cy="225" rx="24" ry="7" fill={P.cloudDeep} opacity="0.45" />
            <ellipse cx="45" cy="222" rx="22" ry="6" fill={P.cloud} opacity="0.75" />
            <ellipse cx="80" cy="265" rx="16" ry="5" fill={P.cloud} opacity="0.6" />
            {/* Tiny silhouette birds — two, offset, evoking distance without noise */}
            <path d="M 42 195 q 3 -3 5 0 q 2 -3 5 0" stroke={P.bird} strokeWidth="1" fill="none" opacity="0.7" strokeLinecap="round" />
            <path d="M 74 215 q 2.5 -2 4 0 q 1.5 -2 4 0" stroke={P.bird} strokeWidth="0.9" fill="none" opacity="0.55" strokeLinecap="round" />
            {/* Mullion cross — thinner */}
            <rect x="66" y="72" width="3" height="470" fill={P.shelfEdge} opacity="0.85" />
            <rect x="30" y="305" width="78" height="3" fill={P.shelfEdge} opacity="0.85" />
            {/* Distant tree canopy at the base of the window — warmer olive for pink-sky harmony */}
            <path d="M 30 460 Q 40 445 55 452 Q 68 438 82 448 Q 96 442 108 458 L 108 542 L 30 542 Z" fill={P.tree} opacity="0.9" />
            <path d="M 30 470 Q 45 458 60 465 Q 78 452 95 462 Q 105 460 108 468 L 108 542 L 30 542 Z" fill={P.treeDark} opacity="0.75" />
            {/* A soft canopy highlight suggesting rim lighting from the pink sky */}
            <path d="M 30 460 Q 40 445 55 452 Q 68 438 82 448 Q 96 442 108 458" stroke={P.skyHighlight} strokeWidth="1.5" fill="none" opacity="0.35" strokeLinecap="round" />
            {/* Window sill */}
            <rect x="16" y="548" width="106" height="10" fill={P.shelfEdge} />
            <rect x="12" y="556" width="114" height="6" fill={P.shelf} />
          </g>

          {/* --- Right-side bookshelves (dominant back wall element) --- */}
          <g>
            {/* Shelf frame */}
            <rect x="140" y="30" width="350" height="680" fill={P.shelf} />
            <rect x="140" y="30" width="350" height="680" fill={P.shelf} filter="url(#lib-grain)" />
            {/* Shelf horizontal boards */}
            {[30, 155, 280, 405, 530, 655].map((y) => (
              <g key={y}>
                <rect x="140" y={y} width="350" height="10" fill={P.shelfEdge} />
                <rect x="140" y={y + 6} width="350" height="4" fill={P.shelf} opacity="0.5" />
              </g>
            ))}
            {/* Vertical shelf dividers */}
            {[260, 380].map((x) => (
              <rect key={x} x={x} y="30" width="6" height="640" fill={P.shelfEdge} />
            ))}
            {/* Books — arranged as textural vertical rectangles at varying heights */}
            {(() => {
              const spines: React.JSX.Element[] = []
              const shelfYs = [45, 170, 295, 420, 545]
              const shelfSectionsX = [
                { start: 148, end: 258 },
                { start: 268, end: 378 },
                { start: 388, end: 484 }
              ]
              // Cohesive earthen palette across the shelves — moss, ox-blood, warm sand, cocoa, brass, dusty
              // rose. Rose appears sparsely so it registers as a subtle echo of the pink window, not a stripe.
              const spineColors = [P.bookGreen, P.bookOxblood, P.bookCream, P.bookNavy, P.bookMuted, P.bookGreen, P.bookOxblood, P.bookRose, P.bookNavy, P.bookMuted, P.bookBrass, P.bookCream, P.bookGreen, P.bookOxblood]
              let key = 0
              for (const sy of shelfYs) {
                for (const sec of shelfSectionsX) {
                  let x = sec.start + 2
                  // Deterministic per-row pattern rather than Math.random — stable across renders
                  const seedBase = (sy * 31 + sec.start * 17)
                  while (x < sec.end - 6) {
                    const wSeed = ((seedBase + x * 13) >>> 0) % 5
                    const w = 5 + wSeed // 5-9px wide
                    const hSeed = ((seedBase + x * 29 + 7) >>> 0) % 4
                    const h = 100 + hSeed * 4 // 100-112px tall
                    const c = spineColors[(seedBase + x) % spineColors.length]
                    const skew = ((seedBase + x * 41) >>> 0) % 100 < 8 // occasionally tilted book
                    spines.push(
                      <g key={`s${key++}`} transform={skew ? `rotate(-3 ${x + w / 2} ${sy + h - 4})` : undefined}>
                        <rect x={x} y={sy + 115 - h} width={w} height={h} fill={c} />
                        <rect x={x} y={sy + 115 - h} width={w} height="3" fill={c} opacity="0.6" />
                        {/* Subtle brass detail on some spines */}
                        {((seedBase + x * 7) >>> 0) % 5 === 0 && (
                          <rect x={x + 1} y={sy + 115 - h / 2} width={w - 2} height="1" fill={P.brass} opacity="0.5" />
                        )}
                        <rect x={x} y={sy + 112} width={w} height="3" fill={P.shelf} opacity="0.7" />
                      </g>
                    )
                    x += w + 1
                  }
                }
              }
              return spines
            })()}
            {/* Brass rail across the top of the shelves for the ladder */}
            <line x1="140" y1="90" x2="490" y2="90" stroke={P.brass} strokeWidth="2.5" opacity="0.9" />
            <circle cx="145" cy="90" r="4" fill={P.brass} />
            <circle cx="485" cy="90" r="4" fill={P.brass} />

            {/* --- Stained-glass panel v3 (aesthetic pass §12 v3, 2026-09-19) --- */}
            {/* Redesigned to match a real Victorian botanical stained-glass window: hummingbirds and roses on a
                frosted ivory ground with a border of jewel-tone quarrels. Two hummingbirds (one in pink+blue, one
                in blue) with sweeping wings and beaks; three roses (ruby, gold, dusty pink) on green stems with
                scattered leaves; complex organic leaded came. Colours: ruby, cobalt, magenta, emerald, amber,
                dusty pink, purple, ivory. */}
            <g>
              {/* Walnut carved backing — larger, portrait proportion for the botanical design */}
              <rect x="262" y="163" width="114" height="230" fill={P.shelfEdge} />
              <rect x="264" y="165" width="110" height="226" fill={P.shelf} />
              {/* Aperture — full portrait rectangle */}
              <rect x="270" y="170" width="98" height="216" fill="#2A1B10" />
              {/* Frosted ivory ground — the milky "white" glass */}
              <rect x="272" y="172" width="94" height="212" fill="#EAE1CE" opacity="0.9" />

              {/* --- Border quarrels — jewel-toned tiles ringing the design --- */}
              {/* Top row */}
              <rect x="272" y="172" width="9" height="9" fill="#2E4A6E" opacity="0.92" />
              <rect x="281" y="172" width="9" height="9" fill="#C89A5C" opacity="0.9" />
              <rect x="290" y="172" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="302" y="172" width="9" height="9" fill="#8A2A25" opacity="0.92" />
              <rect x="311" y="172" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="323" y="172" width="9" height="9" fill="#7A3E5C" opacity="0.9" />
              <rect x="332" y="172" width="9" height="9" fill="#C89A5C" opacity="0.9" />
              <rect x="341" y="172" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="353" y="172" width="9" height="9" fill="#3F5F3E" opacity="0.9" />
              <rect x="362" y="172" width="4" height="9" fill="#2E4A6E" opacity="0.9" />
              {/* Bottom row */}
              <rect x="272" y="375" width="9" height="9" fill="#2E4A6E" opacity="0.92" />
              <rect x="281" y="375" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="293" y="375" width="9" height="9" fill="#7A3E5C" opacity="0.9" />
              <rect x="302" y="375" width="9" height="9" fill="#3F5F3E" opacity="0.9" />
              <rect x="311" y="375" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="323" y="375" width="9" height="9" fill="#C89A5C" opacity="0.9" />
              <rect x="332" y="375" width="12" height="9" fill="#EAE1CE" opacity="0.7" />
              <rect x="344" y="375" width="9" height="9" fill="#8A2A25" opacity="0.92" />
              <rect x="353" y="375" width="9" height="9" fill="#7A3E5C" opacity="0.9" />
              <rect x="362" y="375" width="4" height="9" fill="#3F5F3E" opacity="0.9" />
              {/* Left column */}
              {[
                { y: 181, h: 20, c: '#EAE1CE', o: 0.7 },
                { y: 201, h: 10, c: '#7A3E5C', o: 0.9 },
                { y: 211, h: 20, c: '#EAE1CE', o: 0.7 },
                { y: 231, h: 10, c: '#3F5F3E', o: 0.9 },
                { y: 241, h: 22, c: '#EAE1CE', o: 0.7 },
                { y: 263, h: 10, c: '#C89A5C', o: 0.9 },
                { y: 273, h: 24, c: '#EAE1CE', o: 0.7 },
                { y: 297, h: 10, c: '#8A2A25', o: 0.92 },
                { y: 307, h: 22, c: '#EAE1CE', o: 0.7 },
                { y: 329, h: 10, c: '#2E4A6E', o: 0.92 },
                { y: 339, h: 36, c: '#EAE1CE', o: 0.7 }
              ].map((t, i) => (
                <rect key={`l${i}`} x="272" y={t.y} width="9" height={t.h} fill={t.c} opacity={t.o} />
              ))}
              {/* Right column */}
              {[
                { y: 181, h: 20, c: '#3F5F3E', o: 0.9 },
                { y: 201, h: 22, c: '#EAE1CE', o: 0.7 },
                { y: 223, h: 10, c: '#8A2A25', o: 0.92 },
                { y: 233, h: 22, c: '#EAE1CE', o: 0.7 },
                { y: 255, h: 10, c: '#7A3E5C', o: 0.9 },
                { y: 265, h: 26, c: '#EAE1CE', o: 0.7 },
                { y: 291, h: 10, c: '#C89A5C', o: 0.9 },
                { y: 301, h: 26, c: '#EAE1CE', o: 0.7 },
                { y: 327, h: 10, c: '#3F5F3E', o: 0.9 },
                { y: 337, h: 38, c: '#EAE1CE', o: 0.7 }
              ].map((t, i) => (
                <rect key={`r${i}`} x="357" y={t.y} width="9" height={t.h} fill={t.c} opacity={t.o} />
              ))}

              {/* --- Central design field: x=281-357, y=181-375. Long green stems with roses + hummingbirds --- */}
              {/* Long curving stems from the base upward */}
              <path d="M 315 375 Q 312 350 316 320 Q 322 290 314 260 Q 310 230 320 205 Q 325 190 324 178"
                    stroke="#3F5F3E" strokeWidth="2.2" fill="none" opacity="0.9" />
              <path d="M 330 375 Q 334 355 330 335 Q 324 310 336 285 Q 344 260 340 240"
                    stroke="#3F5F3E" strokeWidth="1.8" fill="none" opacity="0.85" />
              <path d="M 305 375 Q 302 355 306 335"
                    stroke="#3F5F3E" strokeWidth="1.6" fill="none" opacity="0.8" />

              {/* Leaves scattered along stems (dark emerald with lighter highlights) */}
              <g fill="#3F5F3E" opacity="0.92">
                <ellipse cx="308" cy="288" rx="6" ry="2.6" transform="rotate(-25 308 288)" />
                <ellipse cx="319" cy="232" rx="7" ry="2.8" transform="rotate(20 319 232)" />
                <ellipse cx="326" cy="278" rx="5" ry="2.2" transform="rotate(45 326 278)" />
                <ellipse cx="335" cy="315" rx="6" ry="2.5" transform="rotate(-28 335 315)" />
                <ellipse cx="303" cy="345" rx="5" ry="2" transform="rotate(20 303 345)" />
                <ellipse cx="342" cy="270" rx="6" ry="2.5" transform="rotate(35 342 270)" />
                <ellipse cx="322" cy="200" rx="5" ry="2" transform="rotate(-15 322 200)" />
              </g>
              {/* Leaf mid-vein highlights */}
              <g stroke="#6E8547" strokeWidth="0.5" fill="none" opacity="0.65">
                <line x1="304" y1="288" x2="312" y2="288" />
                <line x1="315" y1="231" x2="323" y2="233" />
                <line x1="331" y1="315" x2="339" y2="315" />
              </g>

              {/* --- Rose 1: ruby red with amber outer petals, upper-left --- */}
              <g>
                <circle cx="301" cy="258" r="13" fill="#3F5F3E" opacity="0.75" />  {/* leaf backing */}
                <circle cx="301" cy="256" r="11" fill="#C89A5C" opacity="0.92" />  {/* amber outer */}
                <circle cx="301" cy="254" r="8" fill="#8A2A25" opacity="0.94" />   {/* ruby */}
                <circle cx="301" cy="254" r="5" fill="#5A1B18" opacity="0.9" />    {/* deep centre */}
                <path d="M 297 250 Q 301 246 305 250 M 295 254 Q 301 250 307 254 M 297 258 Q 301 254 305 258"
                      stroke="#EAB8A2" strokeWidth="0.5" fill="none" opacity="0.7" />
              </g>

              {/* --- Rose 2: golden yellow-orange, mid-right --- */}
              <g>
                <circle cx="342" cy="303" r="14" fill="#3F5F3E" opacity="0.75" />
                <circle cx="342" cy="301" r="12" fill="#C89A5C" opacity="0.94" />
                <circle cx="342" cy="299" r="9" fill="#E8AB48" opacity="0.94" />
                <circle cx="342" cy="299" r="5.5" fill="#B87B32" opacity="0.92" />
                <circle cx="342" cy="299" r="2.5" fill="#7A4E1E" opacity="0.88" />
                <path d="M 337 296 Q 342 292 347 296 M 335 300 Q 342 296 349 300 M 337 304 Q 342 300 347 304"
                      stroke="#F5D18C" strokeWidth="0.5" fill="none" opacity="0.65" />
              </g>

              {/* --- Rose 3: dusty pink, bottom-centre --- */}
              <g>
                <circle cx="318" cy="352" r="12" fill="#3F5F3E" opacity="0.75" />
                <circle cx="318" cy="350" r="10" fill="#B98286" opacity="0.94" />
                <circle cx="318" cy="348" r="7" fill="#D6A4A8" opacity="0.94" />
                <circle cx="318" cy="348" r="4" fill="#A05E62" opacity="0.92" />
                <path d="M 314 345 Q 318 341 322 345 M 312 349 Q 318 345 324 349"
                      stroke="#F0DAD0" strokeWidth="0.5" fill="none" opacity="0.65" />
              </g>

              {/* --- Hummingbird 1: pink/magenta wings + blue body, upper-left area --- */}
              <g transform="translate(310, 218) scale(0.7)">
                {/* Left wing — magenta, swept back */}
                <path d="M -2 -1 Q -14 -8 -20 -3 Q -16 2 -6 3 Z" fill="#A03E5C" opacity="0.94" />
                <path d="M -2 -1 Q -12 -6 -17 -3 Q -14 0 -5 2 Z" fill="#C55879" opacity="0.85" />
                {/* Body — cobalt blue */}
                <ellipse cx="0" cy="0" rx="8" ry="5" fill="#2E4A6E" />
                {/* Belly — lighter */}
                <ellipse cx="0" cy="2" rx="6" ry="3" fill="#4A6688" opacity="0.9" />
                {/* Head — deeper blue */}
                <circle cx="6" cy="-1" r="3.5" fill="#1E3555" />
                {/* Beak — long thin */}
                <path d="M 9 -1 L 18 -2 L 9 0 Z" fill="#241010" />
                {/* Eye */}
                <circle cx="7" cy="-1.5" r="0.7" fill="#EAE1CD" />
                <circle cx="7.2" cy="-1.5" r="0.3" fill="#241010" />
                {/* Right wing — purple, folded */}
                <path d="M 0 3 Q -6 8 -10 6 Q -5 4 0 2 Z" fill="#7A3E5C" opacity="0.9" />
                {/* Tail feathers */}
                <path d="M -8 0 L -14 -2 L -13 2 Z" fill="#4A2650" />
              </g>

              {/* --- Hummingbird 2: blue, centre-right area --- */}
              <g transform="translate(348, 240) scale(0.6)">
                {/* Wing — sky blue, swept up */}
                <path d="M 2 -1 Q 12 -8 17 -3 Q 12 1 5 2 Z" fill="#6E8EAE" opacity="0.94" />
                <path d="M 2 -1 Q 10 -6 14 -3 Q 10 0 4 1 Z" fill="#8FA4BE" opacity="0.85" />
                {/* Body */}
                <ellipse cx="0" cy="0" rx="7.5" ry="4.5" fill="#4A6E8E" />
                {/* Belly */}
                <ellipse cx="0" cy="1.5" rx="5.5" ry="2.5" fill="#6E8EAE" opacity="0.9" />
                {/* Head */}
                <circle cx="-6" cy="-1" r="3" fill="#2E4A6E" />
                {/* Beak */}
                <path d="M -9 -1 L -17 -2 L -9 0 Z" fill="#241010" />
                {/* Eye */}
                <circle cx="-6.5" cy="-1.5" r="0.6" fill="#EAE1CD" />
                <circle cx="-6.7" cy="-1.5" r="0.3" fill="#241010" />
                {/* Tail */}
                <path d="M 7 0 L 13 -1 L 12 3 Z" fill="#2E4A6E" />
              </g>

              {/* --- Complex leaded came — organic outlines around figures + border --- */}
              <g stroke="#241610" strokeWidth="1.3" fill="none" opacity="0.88" strokeLinecap="round">
                {/* Around rose 1 */}
                <circle cx="301" cy="256" r="13" />
                {/* Around rose 2 */}
                <circle cx="342" cy="301" r="14" />
                {/* Around rose 3 */}
                <circle cx="318" cy="350" r="12" />
                {/* Curving lead lines connecting the roses/figures */}
                <path d="M 289 258 Q 285 240 292 220 Q 298 208 310 210" />
                <path d="M 316 266 Q 324 275 336 291" />
                <path d="M 305 350 Q 310 340 317 338" />
                <path d="M 331 352 Q 336 340 340 318" />
                <path d="M 336 235 Q 348 220 356 220" />
              </g>
              {/* Border lead frame around glass field */}
              <rect x="272" y="172" width="94" height="212" fill="none" stroke="#241610" strokeWidth="1.6" />
              {/* Inner border to separate quarrel border from center design */}
              <rect x="281" y="181" width="76" height="194" fill="none" stroke="#241610" strokeWidth="1" opacity="0.8" />

              {/* Walnut frame outer highlight */}
              <rect x="264" y="165" width="110" height="226" fill="none" stroke={P.brass} strokeWidth="0.9" opacity="0.55" />
              {/* Corner rosettes */}
              <circle cx="268" cy="169" r="2.2" fill={P.brass} opacity="0.5" />
              <circle cx="370" cy="169" r="2.2" fill={P.brass} opacity="0.5" />
              <circle cx="268" cy="387" r="2.2" fill={P.brass} opacity="0.5" />
              <circle cx="370" cy="387" r="2.2" fill={P.brass} opacity="0.5" />

              {/* Very subtle warm reflection */}
              <rect x="262" y="163" width="114" height="230" fill="url(#lib-lamp-halo)" opacity="0.05" />
            </g>
          </g>

          {/* --- Rolling library ladder — leaning against the brass rail --- */}
          <g>
            {/* Two rails, angled from bottom to top */}
            <line x1="150" y1="695" x2="170" y2="92" stroke={P.shelfEdge} strokeWidth="5.5" strokeLinecap="round" />
            <line x1="170" y1="695" x2="190" y2="92" stroke={P.shelfEdge} strokeWidth="5.5" strokeLinecap="round" />
            {/* Rungs */}
            {[130, 200, 270, 340, 410, 480, 550, 620, 680].map((y, i) => {
              // Interpolate x based on y between the two rails
              const t = (y - 92) / (695 - 92)
              const x1 = 170 - (170 - 150) * (1 - t)
              const x2 = 190 - (190 - 170) * (1 - t)
              return <line key={i} x1={x1} y1={y} x2={x2} y2={y} stroke={P.shelfHighlight} strokeWidth="3.5" strokeLinecap="round" />
            })}
            {/* Brass hook at top */}
            <rect x="162" y="88" width="10" height="10" fill={P.brass} rx="1.5" />
            <rect x="182" y="88" width="10" height="10" fill={P.brass} rx="1.5" />
          </g>

          {/* --- Wooden floor --- */}
          <g>
            <rect x="0" y="700" width="500" height="200" fill="url(#lib-floor)" />
            <rect x="0" y="700" width="500" height="200" fill="url(#lib-floor)" filter="url(#lib-wood)" />
            {/* Plank divisions with perspective (planks converge slightly toward the back wall) */}
            {[10, 40, 80, 130, 190, 260, 340, 430].map((offset, i) => {
              const y = 705 + i * 25
              return (
                <g key={i}>
                  <line x1="0" y1={y} x2="500" y2={y} stroke={P.floorPlank} strokeWidth="1" opacity="0.6" />
                  <line x1={200 + offset} y1={y} x2={280 - offset * 0.3} y2={y} stroke={P.floorPlank} strokeWidth="1" opacity="0.7" />
                </g>
              )
            })}
          </g>

          {/* --- Rug across the floor --- larger, grounding the whole floor area */}
          <g>
            <ellipse cx="270" cy="840" rx="255" ry="48" fill="#1a0f0a" opacity="0.25" />
            <ellipse cx="270" cy="835" rx="245" ry="44" fill={P.rug} />
            <ellipse cx="270" cy="832" rx="230" ry="40" fill={P.rugRust} opacity="0.55" />
            {/* Woven pattern hints along the length */}
            {[0, 1, 2, 3, 4, 5, 6].map((i) => {
              const cx = 130 + i * 48
              return <ellipse key={i} cx={cx} cy="835" rx="10" ry="16" fill={P.rugPattern} opacity="0.4" />
            })}
            {/* Central geometric medallion */}
            <ellipse cx="270" cy="835" rx="42" ry="18" fill={P.rugPattern} opacity="0.35" />
            <ellipse cx="270" cy="835" rx="32" ry="14" fill={P.rugRust} opacity="0.5" />
            {/* Border stitching (double band) */}
            <ellipse cx="270" cy="835" rx="245" ry="44" fill="none" stroke={P.paper} strokeWidth="1.5" opacity="0.4" />
            <ellipse cx="270" cy="835" rx="235" ry="38" fill="none" stroke={P.paper} strokeWidth="0.8" opacity="0.3" />
          </g>

          {/* --- Wingback chair (leather olive) — primary focal furniture, positioned to leave room for lamp on right */}
          <g>
            {/* Contact shadow */}
            <ellipse cx="300" cy="810" rx="110" ry="16" fill="#1a0f0a" opacity="0.35" />
            {/* Chair back (tall wingback) */}
            <path
              d="M 210 600 Q 210 495 240 472 Q 275 462 310 465 Q 375 465 395 490 Q 405 515 400 615 L 395 720 L 215 720 Z"
              fill="url(#lib-chair)"
            />
            {/* Wing back highlight */}
            <path d="M 220 590 Q 220 500 250 480 Q 260 490 260 590 L 260 720 L 220 720 Z" fill={P.chairOliveLight} opacity="0.55" />
            <path d="M 380 590 Q 390 500 375 480 Q 365 490 365 590 L 365 720 L 380 720 Z" fill={P.chairShadow} opacity="0.55" />
            {/* Left arm */}
            <path d="M 210 620 Q 185 620 180 650 Q 180 720 210 725 L 235 725 Q 235 660 235 620 Z" fill={P.chairOlive} />
            {/* Right arm */}
            <path d="M 400 620 Q 425 620 430 650 Q 430 720 400 725 L 375 725 Q 375 660 375 620 Z" fill={P.chairOlive} />
            {/* Seat cushion */}
            <ellipse cx="305" cy="720" rx="105" ry="16" fill={P.chairOliveLight} opacity="0.7" />
            <rect x="195" y="720" width="220" height="42" fill="url(#lib-chair)" />
            <rect x="195" y="720" width="220" height="3" fill={P.chairOliveLight} opacity="0.7" />
            {/* Nailhead trim */}
            {[200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400].map((x) => (
              <circle key={x} cx={x} cy="759" r="1.2" fill={P.brass} opacity="0.8" />
            ))}
            {/* Chair legs */}
            <rect x="205" y="762" width="10" height="15" fill={P.shelfEdge} rx="1" />
            <rect x="395" y="762" width="10" height="15" fill={P.shelfEdge} rx="1" />
          </g>

          {/* --- Brass floor lamp beside the chair --- */}
          <g transform="translate(430 500)">
            {/* Shade */}
            <path d="M -22 0 L 22 0 L 30 60 L -30 60 Z" fill={P.lampShade} />
            <path d="M -22 0 L 22 0 L 30 60 L -30 60 Z" fill="url(#lib-lamp-halo)" opacity="0.6" />
            <ellipse cx="0" cy="0" rx="22" ry="4" fill={P.lampShadeDark} />
            <ellipse cx="0" cy="60" rx="30" ry="5" fill={P.lampShadeDark} />
            {/* Pole */}
            <rect x="-2" y="60" width="4" height="200" fill={P.brass} />
            <rect x="-1" y="60" width="1" height="200" fill={P.brassDark} />
            {/* Base */}
            <ellipse cx="0" cy="265" rx="18" ry="4" fill={P.brass} />
            <path d="M -18 260 L 18 260 L 15 268 L -15 268 Z" fill={P.brassDark} />
          </g>

          {/* --- Side table with mug and books --- */}
          <g transform="translate(462 710)">
            {/* Table top */}
            <ellipse cx="0" cy="0" rx="35" ry="8" fill={P.shelfEdge} />
            <ellipse cx="0" cy="-2" rx="35" ry="7" fill={P.shelfHighlight} />
            {/* Table stem */}
            <rect x="-3" y="0" width="6" height="55" fill={P.shelfEdge} />
            {/* Three-legged base */}
            <ellipse cx="0" cy="60" rx="18" ry="4" fill={P.shelf} />
            {/* Stacked books */}
            <rect x="-22" y="-12" width="26" height="6" fill={P.bookOxblood} />
            <rect x="-20" y="-18" width="22" height="6" fill={P.bookGreen} />
            {/* Mug */}
            <ellipse cx="15" cy="-4" rx="8" ry="3" fill={P.mug} />
            <path d="M 7 -4 Q 7 6 10 8 L 20 8 Q 23 6 23 -4 Z" fill={P.mug} />
            <path d="M 23 -1 Q 28 0 28 4 Q 28 8 23 8" fill="none" stroke={P.mugShadow} strokeWidth="1.5" />
            {/* Steam */}
            <path d="M 14 -8 Q 13 -14 15 -18 Q 17 -22 15 -26" fill="none" stroke="url(#lib-mug-steam)" strokeWidth="3" opacity="0.6" />
            <path d="M 17 -8 Q 19 -14 17 -18 Q 15 -22 17 -26" fill="none" stroke="url(#lib-mug-steam)" strokeWidth="2" opacity="0.5" />
          </g>

          {/* --- Corner shadows for atmospheric depth --- */}
          <path d="M 0 0 L 60 0 L 0 90 Z" fill={P.shelf} opacity="0.4" />
          <path d="M 500 0 L 440 0 L 500 100 Z" fill={P.shelf} opacity="0.35" />

          {/* Optional night dim */}
          {dim > 0 && <rect x="0" y="0" width="500" height="900" fill="#1a0f0a" opacity={dim} />}
        </g>
      )}

      {layer === 'foreground' && (
        <g>
          {/* --- Reading desk (left, foreground) — occludes creature at desk-seat --- */}
          <g>
            {/* Contact shadow under desk */}
            <ellipse cx="105" cy="878" rx="115" ry="10" fill="#1a0f0a" opacity="0.5" />
            {/* Desk chair (foreground so it sits IN FRONT of the desk) */}
            <g transform="translate(80 700)">
              {/* Chair back (spindles) */}
              <rect x="-2" y="-95" width="6" height="95" fill={P.deskHigh} />
              <rect x="18" y="-100" width="6" height="100" fill={P.deskHigh} />
              <rect x="38" y="-95" width="6" height="95" fill={P.deskHigh} />
              {/* Top rail */}
              <rect x="-6" y="-100" width="54" height="8" rx="2" fill={P.desk} />
              {/* Seat */}
              <ellipse cx="20" cy="6" rx="30" ry="6" fill={P.chairOliveDark} />
              <rect x="-10" y="0" width="60" height="12" fill={P.chairOlive} />
              <rect x="-10" y="0" width="60" height="2" fill={P.chairOliveLight} opacity="0.6" />
              {/* Legs */}
              <rect x="-8" y="12" width="6" height="60" fill={P.deskHigh} />
              <rect x="46" y="12" width="6" height="60" fill={P.deskHigh} />
              <rect x="10" y="12" width="4" height="55" fill={P.deskHigh} opacity="0.6" />
              <rect x="26" y="12" width="4" height="55" fill={P.deskHigh} opacity="0.6" />
            </g>
            {/* Desk main body */}
            <rect x="0" y="705" width="220" height="18" fill="url(#lib-desk-top)" />
            <rect x="0" y="705" width="220" height="3" fill={P.deskHigh} />
            <rect x="0" y="720" width="220" height="4" fill={P.deskShadow} opacity="0.6" />
            {/* Desk front panel */}
            <rect x="0" y="724" width="220" height="150" fill={P.desk} />
            <rect x="0" y="724" width="220" height="150" fill={P.desk} filter="url(#lib-wood)" />
            {/* Drawer face */}
            <rect x="14" y="740" width="90" height="60" fill={P.deskHigh} rx="2" />
            <rect x="14" y="740" width="90" height="3" fill={P.desk} opacity="0.7" />
            <circle cx="59" cy="770" r="3.5" fill={P.brass} />
            {/* Side panel */}
            <rect x="0" y="724" width="6" height="150" fill={P.deskShadow} />

            {/* Desk lamp */}
            <g transform="translate(38 705)">
              {/* Base */}
              <ellipse cx="0" cy="0" rx="16" ry="3.5" fill={P.brass} />
              <path d="M -14 -3 L 14 -3 L 12 0 L -12 0 Z" fill={P.brassDark} />
              {/* Pole */}
              <rect x="-1.5" y="-45" width="3" height="45" fill={P.brass} />
              {/* Shade */}
              <path d="M -18 -75 L 18 -75 L 24 -45 L -24 -45 Z" fill={P.lampShade} />
              <path d="M -18 -75 L 18 -75 L 24 -45 L -24 -45 Z" fill="url(#lib-lamp-halo)" opacity="0.55" />
              <ellipse cx="0" cy="-75" rx="18" ry="3" fill={P.lampShadeDark} />
              <ellipse cx="0" cy="-45" rx="24" ry="4" fill={P.lampShadeDark} />
            </g>

            {/* Open book on desk */}
            <g transform="translate(100 692)">
              <ellipse cx="0" cy="14" rx="36" ry="4" fill="#1a0f0a" opacity="0.35" />
              {/* Book pages spread */}
              <path d="M -32 12 Q 0 6 32 12 L 30 18 Q 0 14 -30 18 Z" fill={P.paper} />
              <path d="M -30 10 Q 0 4 30 10 L 30 15 Q 0 12 -30 15 Z" fill={P.paperShadow} opacity="0.6" />
              <line x1="0" y1="8" x2="0" y2="16" stroke={P.deskShadow} strokeWidth="0.6" />
              {/* Text lines */}
              {[10, 12, 14].map((y) => (
                <g key={y}>
                  <line x1="-25" y1={y - 3} x2="-6" y2={y - 3} stroke={P.deskShadow} strokeWidth="0.4" opacity="0.55" />
                  <line x1="6" y1={y - 3} x2="26" y2={y - 3} stroke={P.deskShadow} strokeWidth="0.4" opacity="0.55" />
                </g>
              ))}
            </g>

            {/* Quill/pen in cup */}
            <g transform="translate(180 685)">
              <rect x="-8" y="0" width="16" height="20" rx="2" fill={P.brass} />
              <rect x="-8" y="0" width="16" height="2" fill={P.brassDark} />
              {/* Quills poking out */}
              <line x1="-3" y1="0" x2="-6" y2="-24" stroke={P.paper} strokeWidth="2" />
              <line x1="0" y1="0" x2="1" y2="-28" stroke={P.paper} strokeWidth="2" />
              <line x1="3" y1="0" x2="7" y2="-22" stroke={P.paper} strokeWidth="2" />
              {/* Feather barbs on the longest */}
              <path d="M 1 -28 Q 3 -25 1 -22 Q -1 -19 1 -16" fill="none" stroke={P.paper} strokeWidth="0.8" opacity="0.7" />
            </g>

            {/* Loose paper on desk */}
            <g transform="translate(155 702)">
              <rect x="-15" y="0" width="26" height="16" rx="1" fill={P.paper} transform="rotate(-6 -2 8)" />
              <rect x="-15" y="0" width="26" height="16" rx="1" fill={P.paper} transform="rotate(4 -2 8)" opacity="0.9" />
            </g>
          </g>
          {/* Night dim on the foreground too so it matches */}
          {dim > 0 && <rect x="0" y="700" width="220" height="200" fill="#1a0f0a" opacity={dim} />}
        </g>
      )}
    </svg>
  )
}
