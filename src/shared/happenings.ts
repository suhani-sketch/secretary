/**
 * Metaphors for living activities (spec §8 Phase 5). A happening with a natural physical metaphor shows its progress as
 * the thing itself — an egg going from raw to hard, tea steeping — never as a bar or a score. The exact timer always sits
 * underneath. This is a general stage system; nothing here is a hard-coded egg. Where no natural metaphor exists the
 * metaphor is null and the UI shows a plain timer, which is the correct thing to show.
 *
 * Shared by main (phrasing) and the renderer (display). No app imports.
 */

export type Metaphor = 'egg' | 'tea' | 'laundry' | 'plant' | 'download' | 'focus'

export interface MetaphorDef {
  /** Stages in order; the last one is "finished". */
  stages: string[]
  /** How the finished state is announced, in the app's quiet register. */
  doneLine: string
  /** Emoji used where a picture is not drawn (toast, rail fallback). */
  glyph: string
  /** Stage index shown while open-ended: a wash is "washing", tea is "steeping", a session is "focused". */
  openEnded: number
}

export const METAPHORS: Record<Metaphor, MetaphorDef> = {
  egg: { stages: ['raw', 'warming', 'soft', 'medium', 'hard'], doneLine: "Egg's ready.", glyph: '🥚', openEnded: 1 },
  tea: { stages: ['dry', 'steeping', 'ready'], doneLine: "Tea's ready.", glyph: '🍵', openEnded: 1 },
  laundry: { stages: ['washing', 'rinsing', 'spinning', 'done'], doneLine: "Laundry's done.", glyph: '🧺', openEnded: 0 },
  plant: { stages: ['seed', 'sprout', 'growing', 'ready'], doneLine: 'That should be ready now.', glyph: '🌱', openEnded: 1 },
  download: { stages: ['starting', 'in progress', 'almost there', 'done'], doneLine: 'That should have finished.', glyph: '⏳', openEnded: 1 },
  focus: { stages: ['starting', 'focused', 'complete'], doneLine: 'Focus session complete.', glyph: '🎯', openEnded: 1 }
}

/**
 * Which stage a timed happening is in. Stages before the last split the duration evenly; the last stage begins when the
 * time is up. Open-ended happenings (no end) sit in the second stage — "steeping", "washing", "focused" — for as long as
 * they run, because we genuinely do not know more than that.
 */
export function stageFor(metaphor: Metaphor, startedAtMs: number, endsAtMs: number | null, nowMs: number): string {
  const def = METAPHORS[metaphor]
  if (endsAtMs === null) return def.stages[Math.min(def.openEnded, def.stages.length - 1)]
  if (nowMs >= endsAtMs) return def.stages[def.stages.length - 1]
  const total = Math.max(1, endsAtMs - startedAtMs)
  const frac = Math.max(0, Math.min(0.999, (nowMs - startedAtMs) / total))
  // The first stage ("raw", "dry", "starting") is only the opening moments; once under way, the thing is under way.
  if (frac < 0.08 || def.stages.length <= 2) return def.stages[0]
  const middle = def.stages.slice(1, -1)
  const idx = Math.min(middle.length - 1, Math.floor(((frac - 0.08) / 0.92) * middle.length))
  return middle[idx]
}

/** "8 min" / "1 h 20 min" / "45 s" — for the exact timer under the metaphor. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'time'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}:${String(rs).padStart(2, '0')}` : `${m} min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} h ${rm} min` : `${h} h`
}
