import type { SceneDefinition } from './SceneDefinition'

/**
 * Library scene definition. Mirrors the persisted `resources/scenes/library/library.scene.json` for the record.
 * The TS version is what the renderer actually consumes; the JSON is authoritative for asset filenames /
 * dimensions / palette values but is duplicated here in typed form so the renderer never depends on file I/O
 * during React render.
 *
 * Spots are drawn from the coordinates in `library.scene.json` (design intent). They have been reviewed against
 * the reference master; `desk-seat` occlusion is explicitly marked incomplete until the properly segmented
 * foreground layer arrives (see the pass on 2026-09-19; the first-pass foreground was a color-masked
 * approximation that did not include the desk chair or the full desk lamp).
 */

export const LIBRARY_SCENE: SceneDefinition = {
  id: 'library',
  displayName: 'Library',
  emoji: '📚',
  master: { width: 1200, height: 2000 },
  assets: {
    background: 'scene://library/library.background.png',
    foreground: 'scene://library/library.foreground.png',
    reference: 'scene://library/library.reference.png'
  },
  palette: {
    world: '#E9DBC1',
    wall: '#4A3226',
    floor: '#4A3226',
    accent: '#B08B4C',
    warmLamp: '#D6A768',
    shadow: '#2D1F1A',
    surface: '#6B7053'
  },
  lighting: {
    lamps: [
      { id: 'chair-lamp', x: 0.78, y: 0.60, radius: 0.28, color: '#D6A768', intensity: 0.55 },
      { id: 'desk-lamp', x: 0.20, y: 0.66, radius: 0.22, color: '#D6A768', intensity: 0.5 }
    ],
    lightBands: {
      morning: { ambientTint: 'rgba(215,207,180,0.10)', lampIntensity: 0.35 },
      day: { ambientTint: 'rgba(233,219,193,0.00)', lampIntensity: 0.45 },
      evening: { ambientTint: 'rgba(214,167,104,0.14)', lampIntensity: 0.75 },
      night: { ambientTint: 'rgba(45,31,26,0.22)', lampIntensity: 0.9 }
    }
  },
  ambient: [
    {
      id: 'lamp-flicker',
      layer: 'in-front-of-creature',
      kind: 'css-flicker',
      target: 'lamp-halos',
      showInBands: ['evening', 'night'],
      alwaysOn: true,
      amplitude: 0.03,
      periodMs: 2000
    }
    // Dust motes + page-turn ambient effects deferred until dust.svg/page-turn.svg are produced.
  ],
  spots: [
    { id: 'chair-seat', x: 0.68, y: 0.58, scale: 0.55, activity: 'reading', furniture: 'wingback-chair', gaze: 'book', occlusionState: 'verified' },
    { id: 'chair-seat-sleep', x: 0.68, y: 0.60, scale: 0.52, activity: 'sleepy', furniture: 'wingback-chair', gaze: 'closed', occlusionState: 'verified' },
    { id: 'desk-seat', x: 0.30, y: 0.60, scale: 0.55, activity: 'writing', furniture: 'reading-desk', gaze: 'desk', occlusionState: 'incomplete-until-foreground-final' },
    { id: 'ladder-base', x: 0.37, y: 0.72, scale: 0.65, activity: 'browsing', furniture: 'library-ladder', gaze: 'away-up', occlusionState: 'pending' },
    { id: 'window-perch', x: 0.09, y: 0.55, scale: 0.5, activity: 'looking', furniture: 'window', gaze: 'window', occlusionState: 'pending' },
    { id: 'side-table', x: 0.85, y: 0.74, scale: 0.65, activity: 'idle', furniture: 'side-table', gaze: 'desk', occlusionState: 'verified' },
    { id: 'rug-center', x: 0.52, y: 0.82, scale: 0.75, activity: 'idle', furniture: null, gaze: 'away', occlusionState: 'verified' },
    { id: 'shelf-mid', x: 0.55, y: 0.72, scale: 0.75, activity: 'browsing', furniture: 'bookshelves', gaze: 'away', occlusionState: 'pending' }
  ],
  behavior: {
    // Scene-scoped ambient rotation weights. In a library the creature reads a lot, occasionally browses,
    // occasionally writes at the desk, sometimes just sits. Sleepy is rare and only really happens in the chair.
    weights: {
      reading: 0.55,
      writing: 0.1,
      browsing: 0.1,
      looking: 0.05,
      sleepy: 0.05,
      idle: 0.1,
      attentive: 0.05
    },
    dwellMultiplier: 1.35,
    speechToneHints: 'quiet, considered, slightly muttered, unhurried'
  },
  restingSpotMap: {
    rug: 'rug-center',
    armchair: 'chair-seat',
    bench: 'window-perch',
    nest: 'chair-seat-sleep'
  }
}
