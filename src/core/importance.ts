/**
 * Importance is inferred, never asked (spec §4). Deterministic, from the user's own words and the shape of the item:
 * 0 critical · 1 high · 2 normal · 3 low. Platform-independent, no I/O. Used when an item is created without an
 * explicit importance, and once to backfill items created before this existed.
 */

export interface ImportanceInputs {
  title: string
  details?: string | null
  kind?: string | null
  hardness?: string | null
  /** Days from creation to due date, if any. */
  daysToDue?: number | null
  /** Who a commitment was made to, if any. */
  committedTo?: string | null
}

const CRITICAL = /\b(urgent(?:ly)?|asap|critical|emergency|immediately|right away|top priority|must not miss|can'?t miss|cannot miss|final (?:deadline|notice)|last chance|court|visa|passport|tax(?:es)? due|rent due|medication|prescription)\b/i
const HIGH = /\b(important|priority|deadline|due date|submit|submission|application|apply|exam|test|interview|viva|presentation|payment|pay(?: the)? (?:bill|fee|fees|rent)|invoice|bill|contract|sign(?:ing)?|renew(?:al)?|expir(?:es|y|ing)|book(?: the)? (?:flight|train|tickets?)|flight|doctor|dentist|hospital|appointment|call back|reply to|respond to|follow up)\b/i
const LOW = /\b(someday|some day|maybe|might|if (?:i|there'?s|there is) (?:have |get )?time|when i (?:get|have) (?:a )?(?:chance|moment|time)|eventually|at some point|low priority|nice to have|optional|no rush|whenever|one day|idea:?)\b/i

export function inferImportance(i: ImportanceInputs): 0 | 1 | 2 | 3 {
  const text = `${i.title} ${i.details ?? ''}`
  if (i.kind === 'idea' || i.kind === 'note') return 3
  if (CRITICAL.test(text)) return 0
  let score = 2
  if (i.kind === 'commitment' || i.committedTo) score = 1
  if (i.kind === 'deadline' || i.hardness === 'hard') score = Math.min(score, 1)
  if (HIGH.test(text)) score = Math.min(score, 1)
  if (LOW.test(text) && score === 2) return 3
  // Something due within a day of being mentioned is pressing even when the words are calm.
  if (i.daysToDue !== null && i.daysToDue !== undefined && i.daysToDue <= 1 && score === 2 && i.kind !== 'note') score = 1
  return score as 0 | 1 | 2 | 3
}

/** "someday", "maybe", "no rush": the user has told us it is low, whatever else is said about it. */
export function hasLowSignal(text: string): boolean {
  return LOW.test(text) && !CRITICAL.test(text) && !HIGH.test(text)
}
