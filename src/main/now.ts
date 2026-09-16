/**
 * Glue for "what should I do right now?" (Phase 7c): collects the open candidates, their blockers and what they unblock,
 * the free window before the next fixed thing, whether the user is inside an event, and today's context — then hands it to
 * `core/now.ts`. Collecting only; the ranking lives in core.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'
import { occurrencesBetween } from './calendar'
import { constraintWindows } from './planning'
import { describeRecommendation, recommendNow, type NowCandidate, type Recommendation } from '../core/now'
import type { Item } from '../shared/types'

const LOW_ENERGY = /\b(tired|exhausted|wiped|drained|knackered|shattered|burnt out|burned out|worn out|low|down|flat|anxious|stressed|overwhelmed|unwell|sick|ill|foggy|no energy)\b/i

const blockerLabel = (b: Item): string => (b.kind === 'waiting' ? `the reply from ${b.waiting_on ?? 'someone'}` : `"${b.title}"`)

export function recommendNowAt(nowUtc = new Date().toISOString()): Recommendation {
  const zone = DateTime.local().zoneName
  const now = DateTime.fromISO(nowUtc, { zone: 'utc' })
  const horizon = now.plus({ hours: 12 }).toISO()!

  // What is on the calendar around now: a running work block names its item; a running meeting stops almost everything.
  const occs = occurrencesBetween(now.minus({ hours: 12 }).toISO()!, horizon).filter((o) => !o.all_day && !(o.kind === 'session' && o.session_state === 'missed'))
  const runningNow = occs.filter((o) => o.occurrence_start_utc <= nowUtc && (o.occurrence_end_utc ?? o.occurrence_start_utc) > nowUtc)
  const runningItemIds = new Set(runningNow.filter((o) => o.item_id).map((o) => o.item_id!))
  const inEventOcc = runningNow.find((o) => !o.item_id) ?? null

  // Free window: minutes until the next timed event or unavailable window starts.
  let nextStart: { title: string; startsUtc: string } | null = null
  for (const o of occs) if (o.occurrence_start_utc > nowUtc && (!nextStart || o.occurrence_start_utc < nextStart.startsUtc)) nextStart = { title: o.title, startsUtc: o.occurrence_start_utc }
  let inUnavailable: string | null = null
  for (const c of repo.activeConstraints().filter((c) => c.kind === 'unavailable')) {
    for (const w of constraintWindows(c, now.minus({ hours: 12 }).toISO()!, horizon)) {
      if (w.startUtc <= nowUtc && w.endUtc > nowUtc) inUnavailable = c.label
      else if (w.startUtc > nowUtc && (!nextStart || w.startUtc < nextStart.startsUtc)) nextStart = { title: c.label, startsUtc: w.startUtc }
    }
  }
  const freeMinutes = nextStart ? Math.max(0, Math.round((new Date(nextStart.startsUtc).getTime() - now.toMillis()) / 60_000)) : null
  const inEvent = inEventOcc ? { title: inEventOcc.title, endsUtc: inEventOcc.occurrence_end_utc } : inUnavailable ? { title: inUnavailable, endsUtc: null } : null

  const pool = [...repo.openItems(500), ...repo.openChecklistItems()].filter((i) => !i.is_suggestion && ['task', 'deadline', 'commitment', 'checklist_item', 'idea'].includes(i.kind))
  const seen = new Set<string>()
  const candidates: NowCandidate[] = []
  for (const i of pool) {
    if (seen.has(i.id)) continue
    seen.add(i.id)
    const parent = repo.parentProjectOf(i.id)
    candidates.push({
      id: i.id,
      title: i.title,
      kind: i.kind,
      importance: i.importance,
      hardness: i.hardness,
      due_at_utc: i.due_at_utc,
      due_precision: i.due_precision,
      effort_minutes: i.effort_minutes ?? null,
      blocked_by: repo.blockersOf(i.id).map(blockerLabel),
      committed_to: i.committed_to ?? null,
      unblocks: repo.blockedByThis(i.id).length,
      scheduled_now: runningItemIds.has(i.id),
      project: parent?.title ?? null,
      created_at: i.created_at
    })
  }

  const ctx = repo.todayContext()
  const energyLow = ctx.some((c) => (c.kind === 'energy' || c.kind === 'mood' || c.kind === 'other') && LOW_ENERGY.test(c.text))
  return recommendNow({ nowUtc, zone, candidates, freeMinutes, nextBusy: nextStart, inEvent, context: { energyLow, texts: ctx.map((c) => c.text) } })
}

export function recommendationText(r: Recommendation): string {
  return describeRecommendation(r)
}
