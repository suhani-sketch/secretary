/**
 * Missed-task and waiting-item follow-up (spec §8 8c) — platform-independent, no Electron, no SQLite, no model.
 *
 * Phrasing follows the app's own Emotional UX rule (spec §8 Phase 4): never "you failed", never a guilt line —
 * "this didn't get done, we still have time" is as far as it goes. Compute-then-phrase carries forward from Phase 7:
 * the caller decides WHICH items qualify and caps how many are named (never speculating, never judging why
 * something slipped); this module only writes the one calm sentence.
 */

export interface FollowUpEntry {
  title: string
  /** 'waiting' is phrased as "still no word from X"; everything else as "didn't get done". */
  kind: 'task' | 'deadline' | 'commitment' | 'waiting'
  /** Already formatted by the caller, e.g. "was due Thu 17 Sep" or "expected Wed 16 Sep". */
  whenLabel: string
  /** Who is owed the reply (waits) or who the commitment was made to — omitted for plain tasks. */
  who?: string | null
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** One calm message, or null when there is nothing to say (the caller should not insert anything in that case). */
export function describeFollowUp(entries: FollowUpEntry[], overflowCount: number): string | null {
  if (!entries.length) return null
  const missed = entries.filter((e) => e.kind !== 'waiting')
  const waits = entries.filter((e) => e.kind === 'waiting')
  const bits: string[] = []

  if (missed.length === 1) {
    bits.push(`"${missed[0].title}" didn't get done (${missed[0].whenLabel}).`)
  } else if (missed.length > 1) {
    bits.push(`A few things didn't get done: ${missed.map((e) => `"${e.title}" (${e.whenLabel})`).join('; ')}.`)
  }

  if (waits.length === 1) {
    const w = waits[0]
    bits.push(`Still no word from ${w.who ?? 'them'} on "${w.title}" (${w.whenLabel}).`)
  } else if (waits.length > 1) {
    const who = list([...new Set(waits.map((w) => w.who ?? 'them'))])
    bits.push(`Still waiting to hear from ${who}: ${waits.map((e) => `"${e.title}" (${e.whenLabel})`).join('; ')}.`)
  }

  bits.push(`We still have time — say what to do with ${entries.length === 1 ? 'it' : 'these'}.`)
  if (overflowCount > 0) bits.push(`${overflowCount} more ${overflowCount === 1 ? 'is' : 'are'} sitting quietly for another day, not forgotten.`)

  return bits.join(' ')
}
