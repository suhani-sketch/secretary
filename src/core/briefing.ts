/**
 * Morning briefing (spec §8 Phase 8a) — platform-independent, no Electron, no SQLite, no model.
 *
 * The Phase 7 rule carries forward: compute, then phrase. This module invents no second ranking system — it reuses
 * the SAME ranked `priorities` and `summary` that `core/calendar/aggregate.ts#assembleDay` already computes for
 * today's Day View Model (the one function every calendar surface already consumes). All this does is decide how
 * much of that ranked list is worth saying in ONE concise message, and write the sentence.
 */
import type { DayBundle } from '../shared/types'

export interface ComingUpEntry {
  title: string
  /** Already formatted by the caller, e.g. "Mon 21 Sep" — a heads-up label, not honest-precision due text. */
  dueLabel: string
}

export interface BriefingOptions {
  /** e.g. "Friday, 18 September" — computed by the caller, which knows the real zone. */
  dateLabel: string
  /** Local hour (0–23) at the moment of greeting, for "good morning/afternoon/evening". */
  hourLocal: number
  /** Formats an occurrence's start time, e.g. "09:00" — supplied by the caller (explicit zone, not system-implicit). */
  when: (occurrenceStartUtc: string) => string
  /** How many priorities to name before falling back to "+N more". */
  maxNamed?: number
  /** Hard deadlines / dated Things due AFTER today but soon (spec 7b "surface it before it is urgent") — a plain
   *  heads-up, never urgent enough to be "top of mind" for today. Already sorted soonest first by the caller. */
  comingUp?: ComingUpEntry[]
}

const greetingWord = (hour: number): string => (hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening')

/** One concise message. Never invents anything: an empty day says so plainly, never a manufactured "all clear!". */
export function describeBriefing(bundle: DayBundle, opts: BriefingOptions): string {
  const max = opts.maxNamed ?? 3
  const bits: string[] = [`Good ${greetingWord(opts.hourLocal)} — ${opts.dateLabel}.`]

  const timed = bundle.scheduled.filter((o) => !o.all_day).sort((a, b) => a.occurrence_start_utc.localeCompare(b.occurrence_start_utc))
  const comingUp = opts.comingUp ?? []

  if (!bundle.priorities.length && !timed.length && !comingUp.length) {
    bits.push('Nothing pressing today.')
    return bits.join(' ')
  }

  if (bundle.summary.status) {
    const loadWord: Record<string, string> = { light: 'looks light', normal: 'looks normal', busy: 'looks busy', overloaded: 'looks overloaded' }
    bits.push(`Today ${loadWord[bundle.summary.status]}.`)
  }

  if (bundle.priorities.length) {
    const top = bundle.priorities.slice(0, max)
    const rest = bundle.priorities.length - top.length
    const named = top.map((p) => `"${p.item.title}"${p.reasons.length ? ` (${p.reasons[0]})` : ''}`).join('; ')
    bits.push(`Top of mind: ${named}${rest > 0 ? `, +${rest} more` : ''}.`)
  }

  if (timed.length) bits.push(`First up: "${timed[0].title}" at ${opts.when(timed[0].occurrence_start_utc)}${timed.length > 1 ? ` (${timed.length} on the calendar today)` : ''}.`)

  if (comingUp.length) {
    const top = comingUp.slice(0, 2)
    const rest = comingUp.length - top.length
    const named = top.map((c) => `"${c.title}" (${c.dueLabel})`).join('; ')
    bits.push(`Coming up: ${named}${rest > 0 ? `, +${rest} more` : ''}.`)
  }

  return bits.join(' ')
}
