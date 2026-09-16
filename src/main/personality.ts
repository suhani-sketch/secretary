import { DateTime } from 'luxon'
import * as repo from './repo'
import { isOverdue } from '../shared/format'
import type { AppliedChange } from '../shared/types'

/**
 * Personality, tightly rationed (spec §8 Phase 5). Small observations after something real happened, under three rules:
 *   1. never the same line twice — every line used is remembered for good; an exhausted pool means silence;
 *   2. never more than occasionally — at most one line per 90 minutes and three per day;
 *   3. never on anything the user is struggling with — nothing when recent messages carry strain, when several things are
 *      overdue, or when the thing just finished was itself overdue.
 * The register is quietly observant. Nothing here congratulates, scores, or performs. Silence is always acceptable.
 */

const MIN_GAP_MS = 90 * 60 * 1000
const MAX_PER_DAY = 3

type EventKey = 'start:egg' | 'start:tea' | 'start:laundry' | 'start:focus' | 'start:cooking' | 'start:charging' | 'start:process' | 'start:break' | 'happening_done' | 'item_done' | 'step_done' | 'project_done'

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
  project_done: ['A whole Thing, folded away.', 'That took a while, and now it is over.']
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
    case 'complete_item':
      return a.tag === 'project' ? 'project_done' : 'item_done'
    case 'complete_checklist_item':
      return /last step/i.test(a.phrase) ? 'project_done' : 'step_done'
    case 'archive_project':
      return 'project_done'
    default:
      return null
  }
}

/** Rule 3: is the user struggling right now, or with this particular thing? */
function struggling(a: AppliedChange, userText: string): boolean {
  if (STRAIN.test(userText)) return true
  const recent = repo.recentUserTexts(4)
  if (recent.some((t) => STRAIN.test(t))) return true
  const overdue = repo.openItemsOverdue(new Date().toISOString(), 10)
  if (overdue.length >= 3) return true
  if (a.itemId) {
    const it = repo.getItem(a.itemId)
    if (it && it.due_at_utc && isOverdue(it.due_at_utc, it.due_precision)) return true
  }
  return false
}

/**
 * The one line to append to a reply, or null (usually). Only ever after real changes; never after undo, cancel, or an error.
 * Marks the line as used and the moment as spoken before returning, so a crash cannot repeat it.
 */
export function personalityLine(applied: AppliedChange[], userText: string): string | null {
  if (!applied.length) return null
  if (applied.some((a) => /^(undo_last|cancel_|delete_|remove_|snooze_|pause_)/.test(a.tool))) return null
  const now = Date.now()
  const lastAt = Number(repo.getSettingValue('personality.last_at') ?? 0)
  if (now - lastAt < MIN_GAP_MS) return null
  const today = DateTime.local().toISODate()!
  const dayKey = `personality.count.${today}`
  const todayCount = Number(repo.getSettingValue(dayKey) ?? 0)
  if (todayCount >= MAX_PER_DAY) return null

  // The most meaningful change in the round gets the line; finishing beats starting.
  const order: EventKey[] = ['project_done', 'item_done', 'step_done', 'happening_done', 'start:egg', 'start:tea', 'start:laundry', 'start:focus', 'start:cooking', 'start:charging', 'start:process', 'start:break']
  const candidates = applied.map((a) => ({ a, k: key(a) })).filter((x): x is { a: AppliedChange; k: EventKey } => !!x.k)
  if (!candidates.length) return null
  candidates.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k))
  const pick = candidates[0]
  if (struggling(pick.a, userText)) return null

  const used = new Set<string>(JSON.parse(repo.getSettingValue('personality.used') ?? '[]') as string[])
  const fresh = LINES[pick.k].filter((l) => !used.has(l))
  if (!fresh.length) return null
  // Deterministic pick from what is left, keyed on the moment so re-renders never differ.
  const line = fresh[Math.floor(now / 1000) % fresh.length]
  used.add(line)
  repo.setSettingValue('personality.used', JSON.stringify([...used]))
  repo.setSettingValue('personality.last_at', String(now))
  repo.setSettingValue(dayKey, String(todayCount + 1))
  return line
}
