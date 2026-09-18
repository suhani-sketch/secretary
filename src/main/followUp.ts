/**
 * Missed-task and waiting-item follow-up glue (Phase 8c): once per local calendar day, the first time the window
 * is shown, a calm message names whatever has GENUINELY gone stale since it was last mentioned — never a repeat.
 *
 * "Surfaces once": every item that gets named is recorded in a permanent `followup.surfaced_ids` set and never
 * named again, regardless of how long it stays overdue/unresolved — unlike 8b's deadline risk (which clears and
 * can re-arm as feasibility genuinely changes), a missed task does not become "un-missed" on its own, so there is
 * nothing to re-arm here. "Caps out": at most FOLLOWUP_CAP NEW items are named in any one day's message; a backlog
 * beyond that waits quietly for tomorrow rather than flooding one message or firing again sooner. "Never nags": at
 * most one message per day (gated the same way as 8a's briefing), phrased in `core/followup.ts` per the app's own
 * Emotional UX rule — "this didn't get done, we still have time", never "you should have".
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { describeFollowUp, type FollowUpEntry } from '../core/followup'
import type { ChatMessage, Item } from '../shared/types'

const SETTING_SURFACED = 'followup.surfaced_ids'
const SETTING_LAST_DATE = 'followup.lastDate'
const CAP = 3

function loadSurfaced(): Set<string> {
  const raw = repo.getSettingValue(SETTING_SURFACED)
  if (!raw) return new Set()
  try {
    const ids = JSON.parse(raw) as unknown
    return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveSurfaced(ids: Set<string>): void {
  repo.setSettingValue(SETTING_SURFACED, JSON.stringify([...ids]))
}

/** A wait the user already asked to be told about explicitly ("remind me if they haven't replied by Friday") gets
 *  its own targeted reminder from Phase 3c — naming it again here too would be the exact nagging this slice exists
 *  to avoid. */
const hasActiveConditionalReminder = (itemId: string): boolean => repo.pendingRemindersForItems([itemId]).some((r) => !!r.condition_json)

const whenLabel = (item: Item, zone: string, verb: 'was due' | 'expected'): string => {
  const d = DateTime.fromISO(item.due_at_utc!, { zone: 'utc' }).setZone(zone)
  return `${verb} ${d.toFormat(item.due_precision === 'exact' ? 'ccc d LLL, HH:mm' : 'ccc d LLL')}`
}

/** Idempotent: safe to call on every window show. Returns the inserted message only when there is something
 *  genuinely new to say AND today's message has not already gone out. The "already checked today" flag is written
 *  only at the very end of whichever path actually completes (same resilience pattern as 8a's briefing) — a
 *  transient failure leaves it unset, so the next window-show tries again instead of silently skipping the day. */
export function maybeSendFollowUp(nowLocal = DateTime.local()): ChatMessage | null {
  const today = nowLocal.toISODate()!
  if (repo.getSettingValue(SETTING_LAST_DATE) === today) return null

  const nowUtc = nowLocal.toUTC().toISO()!
  const zone = nowLocal.zoneName
  const surfaced = loadSurfaced()

  const missedTasks = repo.openItemsOverdue(nowUtc, 200).filter((i) => (i.kind === 'task' || i.kind === 'deadline' || i.kind === 'commitment') && !surfaced.has(i.id))
  const staleWaits = repo
    .openWaitingItems()
    .filter((w) => w.due_at_utc && w.due_at_utc < nowUtc && !surfaced.has(w.id) && !hasActiveConditionalReminder(w.id))

  const allNew = [...missedTasks, ...staleWaits].sort((a, b) => (a.due_at_utc ?? '').localeCompare(b.due_at_utc ?? ''))
  if (!allNew.length) {
    repo.setSettingValue(SETTING_LAST_DATE, today) // nothing new today — still counts as having checked
    return null
  }

  const named = allNew.slice(0, CAP)
  const overflow = allNew.length - named.length
  // A wait's own title is already "Waiting on Priya — the transcript" (createWaiting's auto-generated display
  // title); phrasing that AGAIN as "Still no word from Priya on ..." would repeat "Priya" and "Waiting on"
  // awkwardly. `details` holds just the "about" part ("the transcript") — fall back to the full title only if it's
  // somehow empty.
  const entries: FollowUpEntry[] = named.map((i) => ({
    title: i.kind === 'waiting' ? (i.details ?? i.title) : i.title,
    kind: i.kind === 'waiting' ? 'waiting' : (i.kind as FollowUpEntry['kind']),
    whenLabel: whenLabel(i, zone, i.kind === 'waiting' ? 'expected' : 'was due'),
    who: i.kind === 'waiting' ? i.waiting_on : (i.committed_to ?? null)
  }))
  const text = describeFollowUp(entries, overflow)!

  for (const item of named) {
    repo.insertActivity({
      targetType: 'item',
      targetId: item.id,
      projectId: repo.parentProjectOf(item.id)?.id ?? null,
      verb: 'followup_surfaced',
      actor: 'system',
      summary: `Follow-up: "${item.title}" ${item.kind === 'waiting' ? 'still unresolved' : 'missed'}`,
      reversible: false
    })
  }
  const message = repo.insertMessage('assistant', text, 0)

  for (const item of named) surfaced.add(item.id)
  saveSurfaced(surfaced)
  repo.setSettingValue(SETTING_LAST_DATE, today)
  return message
}
