/**
 * Entity resolution (spec §8 Phase 3: "the thing most likely to break this phase").
 * "TISS mailing", "the TISS thing", "tiss mailng" must all land on one project. Pure functions, unit-tested with Node.
 */

const STOP = new Set([
  'the', 'a', 'an', 'my', 'our', 'this', 'that', 'thing', 'things', 'stuff', 'project', 'for', 'of', 'to', 'and', 'with', 'on', 'in', 'about', 'some', 'work', 'deal'
])

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Light stemming so "sent the first email" meets "Send first email" and "drafting" meets "draft". */
const IRREGULAR: Record<string, string> = {
  sent: 'send', wrote: 'write', written: 'write', made: 'make', did: 'do', done: 'do', went: 'go', gone: 'go', paid: 'pay',
  bought: 'buy', got: 'get', took: 'take', taken: 'take', spoke: 'speak', spoken: 'speak', met: 'meet', read: 'read', ran: 'run',
  said: 'say', told: 'tell', found: 'find', built: 'build', left: 'leave', kept: 'keep', began: 'begin', begun: 'begin', emails: 'email'
}
export function stem(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w]
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ied')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

export function tokens(s: string): string[] {
  return normalizeName(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map(stem)
}

function trigrams(s: string): Set<string> {
  const t = ` ${normalizeName(s).replace(/ /g, '')} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return (2 * inter) / (a.size + b.size)
}

/**
 * 0..1 similarity between two names. Combines word overlap (handles reordering and extra words) with
 * character trigrams (handles typos and inflection). Containment of all of the shorter name's words scores high.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  const wordScore = dice(ta, tb)
  const shorter = ta.size <= tb.size ? ta : tb
  const longer = shorter === ta ? tb : ta
  let contained = 0
  for (const w of shorter) if (longer.has(w) || [...longer].some((l) => l.startsWith(w) || w.startsWith(l))) contained++
  const containment = shorter.size ? contained / shorter.size : 0
  const charScore = dice(trigrams(a), trigrams(b))
  return Math.max(wordScore, charScore, containment * 0.9)
}

export interface Candidate<T> {
  entity: T
  score: number
}

/** Rank candidates by similarity to `name`; `recent` ids get a small boost (the focus stack). */
export function rankByName<T extends { id: string; title: string }>(name: string, pool: T[], recent: string[] = []): Candidate<T>[] {
  return pool
    .map((entity) => {
      let score = nameSimilarity(name, entity.title)
      if (recent.includes(entity.id)) score = Math.min(1, score + 0.1)
      return { entity, score }
    })
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score)
}

/** Decision thresholds shared by tools and router. */
export const MATCH_SURE = 0.75
export const MATCH_MAYBE = 0.45

export type Resolution<T> = { kind: 'match'; entity: T; score: number } | { kind: 'maybe'; entity: T; score: number } | { kind: 'none' }

export function resolveEntity<T extends { id: string; title: string }>(name: string, pool: T[], recent: string[] = []): Resolution<T> {
  const [best] = rankByName(name, pool, recent)
  if (!best) return { kind: 'none' }
  if (best.score >= MATCH_SURE) return { kind: 'match', entity: best.entity, score: best.score }
  if (best.score >= MATCH_MAYBE) return { kind: 'maybe', entity: best.entity, score: best.score }
  return { kind: 'none' }
}
