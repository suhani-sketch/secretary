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

// Palette — scoped to the illustration
const P = {
  wall: '#3E2A20',
  wallLight: '#5C3E2E',
  wallHighlight: '#7A5642',
  shelf: '#2E1E17',
  shelfEdge: '#4A3226',
  shelfHighlight: '#6B4A38',
  bookGreen: '#5C6B47',
  bookOxblood: '#7D3A34',
  bookCream: '#D8C8A5',
  bookNavy: '#3A4256',
  bookBrass: '#B08B4C',
  bookMuted: '#4A3F32',
  floor: '#4E3524',
  floorHigh: '#6B4832',
  floorPlank: '#3B2519',
  rug: '#7A4C36',
  rugPattern: '#5C6B47',
  rugRust: '#A66E55',
  chairOlive: '#4E5741',
  chairOliveDark: '#38402F',
  chairOliveLight: '#666F55',
  chairHighlight: '#7A8467',
  chairShadow: '#28301D',
  brass: '#B08B4C',
  brassDark: '#8B6B2E',
  lampShade: '#E9DBB4',
  lampShadeDark: '#C6B889',
  lampWarm: '#D6A768',
  sky: '#B8C4CE',
  skyLower: '#E4D9C3',
  cloud: '#DDD5CA',
  tree: '#4E6247',
  treeDark: '#37472F',
  windowFrame: '#4A3226',
  desk: '#3B2519',
  deskHigh: '#5C3E2A',
  deskShadow: '#1F130D',
  paper: '#E9DBC1',
  paperShadow: '#C6B889',
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

          {/* --- Left window --- soft daylight, cloudy sky, gently indicated tree canopy at the base */}
          <g>
            {/* Frame — slightly softer than pitch-dark */}
            <rect x="18" y="60" width="102" height="500" fill={P.wall} opacity="0.5" />
            <rect x="24" y="66" width="90" height="488" fill={P.shelfEdge} />
            {/* Glass */}
            <rect x="30" y="72" width="78" height="470" fill="url(#lib-sky)" />
            {/* Mullion cross — thinner */}
            <rect x="66" y="72" width="3" height="470" fill={P.shelfEdge} opacity="0.85" />
            <rect x="30" y="305" width="78" height="3" fill={P.shelfEdge} opacity="0.85" />
            {/* Painterly clouds */}
            <ellipse cx="60" cy="140" rx="26" ry="9" fill={P.cloud} opacity="0.7" />
            <ellipse cx="90" cy="180" rx="18" ry="7" fill={P.cloud} opacity="0.55" />
            <ellipse cx="45" cy="225" rx="22" ry="7" fill={P.cloud} opacity="0.5" />
            <ellipse cx="80" cy="270" rx="14" ry="5" fill={P.cloud} opacity="0.4" />
            {/* Distant tree canopy at the base of the window (not floating orbs — a band of foliage) */}
            <path d="M 30 460 Q 40 445 55 452 Q 68 438 82 448 Q 96 442 108 458 L 108 542 L 30 542 Z" fill={P.tree} opacity="0.85" />
            <path d="M 30 470 Q 45 458 60 465 Q 78 452 95 462 Q 105 460 108 468 L 108 542 L 30 542 Z" fill={P.treeDark} opacity="0.7" />
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
              const spineColors = [P.bookGreen, P.bookOxblood, P.bookCream, P.bookNavy, P.bookMuted, P.bookGreen, P.bookOxblood, P.bookNavy, P.bookMuted, P.bookBrass, P.bookCream, P.bookGreen]
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
