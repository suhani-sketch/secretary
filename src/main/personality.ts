import { DateTime } from 'luxon'
import * as repo from './repo'
import { isOverdue } from '../shared/format'
import type { AppliedChange } from '../shared/types'

/**
 * Personality, tightly rationed (spec §8 Phase 5; the "important/postponed/wait" triggers below are 9e's reactive
 * half — the creature "initiating" right when something genuinely notable, not merely routine, just happened).
 * Small observations after something real happened, under three rules:
 *   1. never the same line twice — every line used is remembered for good; an exhausted pool means silence;
 *   2. never more than occasionally — at most one line per 90 minutes and three per day, SHARED across every
 *      trigger including 9e's proactive ones in `main/initiate.ts` — one single "how much does it say today"
 *      budget, not a separate allowance per feature;
 *   3. never on anything the user is struggling with — nothing when recent messages carry strain, when several things are
 *      overdue, or when the thing just finished was itself overdue.
 * The register is quietly observant. Nothing here congratulates, scores, or performs. Silence is always acceptable.
 */

const MIN_GAP_MS = 90 * 60 * 1000
const MAX_PER_DAY = 3

type EventKey =
  | 'start:egg'
  | 'start:tea'
  | 'start:laundry'
  | 'start:focus'
  | 'start:cooking'
  | 'start:charging'
  | 'start:process'
  | 'start:break'
  | 'happening_done'
  | 'item_done'
  | 'step_done'
  | 'project_done'
  | 'important_done'
  | 'postponed_done'
  | 'wait_resolved_important'

const LINES: Record<EventKey, string[]> = {
  'start:egg': ['Egg watch has begun.', 'The egg knows nothing of deadlines.', 'A few minutes of something simple.'],
  'start:tea': ['Tea on. The good part of the hour.', 'Steeping. Nothing to do but wait, which is allowed.', 'The kettle has the floor.'],
  'start:laundry': ['The machine will take it from here.', 'One chore quietly running itself.', 'Somewhere, socks are being dealt with.'],
  'start:focus': ['Door shut, metaphorically.', 'The room will keep quiet.', 'Nothing else needs you for a while.'],
  'start:cooking': ['The kitchen is ticking along.', 'Something is becoming dinner.'],
  'start:charging': ['Plugged in and left alone. A good state for most things.', 'It will be full before you notice.'],
  'start:process': ['The computer is earning its keep.', 'A progress bar somewhere is doing its slow work.'],
  'start:break': ['The list can hold itself up for a bit.', 'Nothing here is going anywhere.'],
  happening_done: ['Done, and no list got longer.', 'That took care of itself.', 'Small thing, finished.'],
  item_done: ["That's one thing out of your head.", 'One fewer.', 'Off the list, into the past.', 'Quietly done.', 'That one is behind you now.'],
  step_done: ['A step further along.', 'The Thing is a little smaller.'],
  project_done: ['A whole Thing, folded away.', 'That took a while, and now it is over.'],
  important_done: ["That was the big one. Done.", 'That one mattered — good to have it off your plate.', "That's the one that counted."],
  postponed_done: ["You finally got that one out of the way.", "That one took a few tries, but it's done now.", "Moved a fair few times — and now it just isn't, any more."],
  wait_resolved_important: ["Good — that one had been hanging over things.", "That reply mattered. Glad it came through.", 'That had been sitting a while. Good to hear.']
}

const STRAIN = /\b(tired|exhausted|stressed|stressful|overwhelmed|overwhelming|anxious|anxiety|behind|can't cope|cannot cope|struggling|struggle|hate this|hate it|awful|terrible|ugh|panic|panicking|late again|so late|forgot again|keep forgetting|drowning|too much|burnt out|burned out|no energy|bad day|rough day|crying|sorry i)\b/i

function key(a: AppliedChange): EventKey | null {
  switch (a.tool) {
    case 'start_happening': {
      const k = a.tag ?? ''
      if (k === 'egg' || k === 'tea' || k === 'laundry' || k === 'focus' || k === 'cooking' || k === 'charging' || k === 'process' || k === 'break') return `start:${k}` as EventKey
      return null
    }
    case 'finish_happening':
      return a.tag === 'done' ? 'happening_done' : null
    case 'complete_item': {
      if (a.tag === 'project') return 'project_done'
      // 9e "the creature initiates, rarely": a plain completion gets the ordinary item_done line, but one that was
      // genuinely notable — moved more than once before finally landing, or carrying real weight — gets a line that
      // actually says so, rather than the same generic "one fewer" every time. Postponement checked first: "you
      // finally got that one out of the way" is the more specific, truer thing to say when both are true.
      if (a.itemId && wasPostponedRepeatedly(a.itemId)) return 'postponed_done'
      if (a.itemId) {
        const it = repo.getItem(a.itemId)
        if (it && (it.importance <= 1 || it.hardness === 'hard')) return 'important_done'
      }
      return 'item_done'
    }
    case 'complete_checklist_item':
      return /last step/i.test(a.phrase) ? 'project_done' : 'step_done'
    case 'archive_project':
      return 'project_done'
    case 'resolve_waiting': {
      // Only a wait that genuinely mattered — important, or had gone stale — is worth a line; an ordinary reply
      // arriving on schedule is not "the creature initiating", it is just bookkeeping.
      if (!a.itemId) return null
      const it = repo.getItem(a.itemId)
      if (!it) return null
      const wasStale = !!it.due_at_utc && isOverdue(it.due_at_utc, it.due_precision)
      if (it.importance <= 1 || wasStale) return 'wait_resolved_important'
      return null
    }
    default:
      return null
  }
}

/** More than one reschedule before finally finishing — "repeatedly postponed" (9e), not just moved once. */
function wasPostponedRepeatedly(itemId: string): boolean {
  return repo.activitiesFor('item', itemId, 50).filter((a) => a.verb === 'rescheduled').length >= 2
}

/** Rule 3: is the user struggling right now, or with this particular thing? */
function struggling(a: AppliedChange, userText: string, k: EventKey | null): boolean {
  if (STRAIN.test(userText)) return true
  const recent = repo.recentUserTexts(4)
  if (recent.some((t) => STRAIN.test(t))) return true
  // Today's stated context (Phase 5d): a low-energy or low-mood day means no observations at all.
  if (repo.todayContext().some((c) => c.kind === 'energy' || c.kind === 'mood')) return true
  const overdue = repo.openItemsOverdue(new Date().toISOString(), 10)
  if (overdue.length >= 3) return true
  // A stale wait finally resolving is exactly what `wait_resolved_important` exists to acknowledge — its own
  // overdue-ness is the REASON it was picked, not a reason to go quiet about it.
  if (k !== 'wait_resolved_important' && a.itemId) {
    const it = repo.getItem(a.itemId)
    if (it && it.due_at_utc && isOverdue(it.due_at_utc, it.due_precision)) return true
  }
  return false
}

/**
 * Rules 1 and 2 (never twice, never more than occasionally), factored out so 9e's proactive triggers
 * (`main/initiate.ts`) spend from the exact same budget as the reactive lines below rather than a separate one.
 * Marks the line as used and the moment as spoken before returning, so a crash cannot repeat it.
 */
function spendBudget(candidateLines: string[]): string | null {
  const now = Date.now()
  const lastAt = Number(repo.getSettingValue('personality.last_at') ?? 0)
  if (now - lastAt < MIN_GAP_MS) return null
  const today = DateTime.local().toISODate()!
  const dayKey = `personality.count.${today}`
  const todayCount = Number(repo.getSettingValue(dayKey) ?? 0)
  if (todayCount >= MAX_PER_DAY) return null
  const used = new Set<string>(JSON.parse(repo.getSettingValue('personality.used') ?? '[]') as string[])
  const fresh = candidateLines.filter((l) => !used.has(l))
  if (!fresh.length) return null
  // Deterministic pick from what is left, keyed on the moment so re-renders never differ.
  const line = fresh[Math.floor(now / 1000) % fresh.length]
  used.add(line)
  repo.setSettingValue('personality.used', JSON.stringify([...used]))
  repo.setSettingValue('personality.last_at', String(now))
  repo.setSettingValue(dayKey, String(todayCount + 1))
  return line
}

/** Rule 3 alone, for a proactive trigger with no single just-finished item to check. */
function generallyQuiet(userText: string): boolean {
  if (STRAIN.test(userText)) return true
  if (repo.recentUserTexts(4).some((t) => STRAIN.test(t))) return true
  if (repo.todayContext().some((c) => c.kind === 'energy' || c.kind === 'mood')) return true
  if (repo.openItemsOverdue(new Date().toISOString(), 10).length >= 3) return true
  return false
}

/**
 * The one line to append to a reply, or null (usually). Only ever after real changes; never after undo, cancel, or an error.
 */
export function personalityLine(applied: AppliedChange[], userText: string): string | null {
  if (!applied.length) return null
  if (applied.some((a) => /^(undo_last|cancel_|delete_|remove_|snooze_|pause_)/.test(a.tool))) return null

  // The most meaningful change in the round gets the line; finishing beats starting, and a specific, notable
  // observation (9e) beats the same generic line every time.
  const order: EventKey[] = [
    'project_done',
    'postponed_done',
    'important_done',
    'wait_resolved_important',
    'item_done',
    'step_done',
    'happening_done',
    'start:egg',
    'start:tea',
    'start:laundry',
    'start:focus',
    'start:cooking',
    'start:charging',
    'start:process',
    'start:break'
  ]
  const candidates = applied.map((a) => ({ a, k: key(a) })).filter((x): x is { a: AppliedChange; k: EventKey } => !!x.k)
  if (!candidates.length) return null
  candidates.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k))
  const pick = candidates[0]
  if (struggling(pick.a, userText, pick.k)) return null
  return spendBudget(LINES[pick.k])
}

/**
 * 9e's proactive half (`main/initiate.ts`): a scheduler-driven trigger with no `AppliedChange` and no single item
 * to check for its own overdue-ness, spending from the SAME budget as every reactive line above.
 */
export function tryProactiveLine(candidateLines: string[], userText = ''): string | null {
  if (generallyQuiet(userText)) return null
  return spendBudget(candidateLines)
}
