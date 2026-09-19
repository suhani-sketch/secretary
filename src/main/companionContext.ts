import { DateTime } from 'luxon'
import * as repo from './repo'
import { recommendNowAt } from './now'
import { upcomingDeadlineTargets, assessTarget } from './deadlines'
import { buildDay } from './calendar'
import type { Activity, DayStatus, Item } from '../shared/types'
import { planProgress } from '../core/plans'

/**
 * Companion context (the "creature is the Secretary's voice" reshape): a single compact semantic summary of the
 * user's real state that the creature reads from — never the whole database. Everything here is derived from
 * existing Secretary intelligence: recommendNowAt (7c), upcomingDeadlineTargets/assessTarget (7b), buildDay's day
 * summary (6a), openItemsOverdue/openWaitingItems (repo), todayContext (5d), listPlans + planProgress (6f). No new
 * table, no new query, no independent scoring — just a small honest bundle the voice arbitrator can quote from.
 *
 * The Secretary computes the facts. The creature chooses whether to speak, and how. When the user asks "why are
 * you telling me this?", the answer comes from THIS object — recorded at the moment a proactive line fires.
 */

export type TimeOfDay = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'late'

export interface CompanionContext {
  /** ISO instant this snapshot was taken. */
  takenAt: string
  /** Local time-of-day band (finer than the 4-band room light for messaging tone). */
  timeOfDay: TimeOfDay
  /** Local hour, 0-23. */
  hour: number
  /** Today's date, ISO. */
  today: string
  /** The single top priority right now (from 7c), or null if nothing can start. */
  topPriority: { itemId: string; title: string; reasons: string[] } | null
  /** The next timed event/reminder on the calendar today, if any. Includes minutes-until. */
  nextTimedToday: { title: string; startsAtUtc: string; minutesUntil: number } | null
  /** The soonest important deadline (hard/deadline kind) coming up, with feasibility. */
  upcomingDeadline: {
    itemId: string
    title: string
    dueAtUtc: string
    hoursUntil: number
    feasibility: 'no_deadline' | 'complete' | 'passed' | 'unknown' | 'comfortable' | 'tight' | 'infeasible'
    bottleneck: string | null
  } | null
  /** Everything counted, never listed — the creature can quote a count without dumping items. */
  overdueCount: number
  waitingCount: number
  /** An active plan the user is currently behind on, if any. */
  planBehind: { planId: string; title: string; hoursDone: number; hoursTarget: number; missedSessions: number } | null
  /** Real user-stated context today (energy: exhausted, mood: stressed, ...). Never invented. */
  userContext: { kind: string; text: string }[]
  /** A meaningful completion in the last 24h — critical/high importance, hard, or a long-running item. */
  meaningfulRecentCompletion: { title: string; completedAt: string; importance: number } | null
  /** Day load as computed by 6a's dayStatus — the same word every calendar surface already shows. */
  dayLoad: DayStatus | null
  /** True if the user has been active in the app in the last 10 minutes (typed something, sent a message). */
  userActive: boolean
  /** Hours since the last user message (any turn) — proxy for "user is back". */
  hoursSinceLastMessage: number
}

function timeOfDayFor(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'midday'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 22) return 'evening'
  if (hour >= 22 || hour < 2) return 'night'
  return 'late'
}

/** Grab the last user message's timestamp from `messages` — proxy for "when did they last look at us". */
function lastUserMessageIso(): string | null {
  try {
    const row = (repo as unknown as { getDb: () => { prepare: (s: string) => { get: () => { created_at?: string } | undefined } } })
      .getDb()
      .prepare("SELECT created_at FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at?: string } | undefined
    return row?.created_at ?? null
  } catch {
    return null
  }
}

/** A "meaningful" completion isn't every ticked task — critical/high importance, a hard deadline, or long-running. */
function findMeaningfulRecentCompletion(activities: Activity[], items: Map<string, Item>, nowMs: number): CompanionContext['meaningfulRecentCompletion'] {
  const cutoff = nowMs - 24 * 3600 * 1000
  for (const a of activities) {
    if (a.verb !== 'completed') continue
    if (new Date(a.created_at).getTime() < cutoff) break // activities come newest-first; older ones don't matter here
    if (a.target_type !== 'item') continue
    const it = items.get(a.target_id)
    if (!it) continue
    const isCritical = (it.importance ?? 2) <= 1
    const isHard = it.hardness === 'hard' || it.kind === 'deadline' || it.kind === 'project'
    const isLongRunning = (nowMs - new Date(it.created_at).getTime()) / 86_400_000 >= 7
    if (isCritical || isHard || isLongRunning) {
      return { title: it.title, completedAt: a.created_at, importance: it.importance ?? 2 }
    }
  }
  return null
}

/** The next timed thing today (event or timed reminder). */
function findNextTimedToday(nowMs: number, endOfDayMs: number): CompanionContext['nextTimedToday'] {
  const eventList = repo.eventsBetween(new Date(nowMs).toISOString(), new Date(endOfDayMs).toISOString())
  const nextEvent = eventList
    .filter((e) => e.starts_at_utc && new Date(e.starts_at_utc).getTime() > nowMs)
    .sort((a, b) => a.starts_at_utc!.localeCompare(b.starts_at_utc!))[0]
  const pendingList = repo.listReminders().filter((r) => r.state === 'pending')
  const nextReminder = pendingList
    .filter((r) => new Date(r.fire_at_utc).getTime() > nowMs && new Date(r.fire_at_utc).getTime() <= endOfDayMs)
    .sort((a, b) => a.fire_at_utc.localeCompare(b.fire_at_utc))[0]
  const cands: { title: string; startsAtUtc: string }[] = []
  if (nextEvent && nextEvent.starts_at_utc) cands.push({ title: nextEvent.title, startsAtUtc: nextEvent.starts_at_utc })
  if (nextReminder) {
    const item = nextReminder.target_type === 'item' ? repo.getItem(nextReminder.target_id) : null
    cands.push({ title: item?.title ?? 'Reminder', startsAtUtc: nextReminder.fire_at_utc })
  }
  if (cands.length === 0) return null
  cands.sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
  const pick = cands[0]
  return {
    title: pick.title,
    startsAtUtc: pick.startsAtUtc,
    minutesUntil: Math.round((new Date(pick.startsAtUtc).getTime() - nowMs) / 60000)
  }
}

/** Are we behind on any active plan? (7d's 'plans_behind' definition, made explicit here.) */
function findPlanBehind(nowUtc: string): CompanionContext['planBehind'] {
  const plans = repo.listPlans().filter((p) => p.status === 'active')
  for (const p of plans) {
    const sessions = repo.sessionsForPlan(p.id)
    const progress = planProgress(p, sessions, nowUtc)
    if (progress.sessions.missed > 0 && (progress.shortfall_minutes ?? 0) > 0) {
      return {
        planId: p.id,
        title: p.title,
        hoursDone: Math.round(progress.done_minutes / 6) / 10,
        hoursTarget: Math.round((progress.target_minutes ?? 0) / 6) / 10,
        missedSessions: progress.sessions.missed
      }
    }
  }
  return null
}

export function computeCompanionContext(nowIso = new Date().toISOString()): CompanionContext {
  const nowMs = new Date(nowIso).getTime()
  const local = DateTime.fromISO(nowIso).toLocal()
  const hour = local.hour
  const today = local.toISODate()!
  const endOfDayMs = local.endOf('day').toMillis()

  // Overdue / waiting — the counts, not the lists.
  const overdue = repo.openItemsOverdue(nowIso, 50)
  const waiting = repo.openWaitingItems()
  // Recommend-now for the top priority. It already excludes blockers/waits/attendance-fixed things.
  const rec = recommendNowAt(nowIso)
  const topPriority: CompanionContext['topPriority'] = rec.pick
    ? { itemId: rec.pick.candidate.id, title: rec.pick.candidate.title, reasons: rec.pick.reasons }
    : null

  // The soonest important deadline, with 7b's own feasibility verdict.
  const targets = upcomingDeadlineTargets(14, nowIso)
  let upcomingDeadline: CompanionContext['upcomingDeadline'] = null
  if (targets.length > 0) {
    const t = targets[0]
    const assessment = assessTarget(t.id, nowIso)
    if (t.due_at_utc && assessment) {
      upcomingDeadline = {
        itemId: t.id,
        title: t.title,
        dueAtUtc: t.due_at_utc,
        hoursUntil: Math.max(0, Math.round((new Date(t.due_at_utc).getTime() - nowMs) / 3600000)),
        feasibility: assessment.feasibility,
        bottleneck: assessment.bottleneck?.why ?? null
      }
    }
  }

  // Day load — the same word every other calendar surface already shows.
  let dayLoad: DayStatus | null = null
  try {
    dayLoad = buildDay(today).summary.status
  } catch {
    dayLoad = null
  }

  // Meaningful recent completion — read the last handful of activities and pick the first that clears the bar.
  const activities = repo.listActivities(50)
  const allItems = new Map<string, Item>()
  for (const it of repo.listItems()) allItems.set(it.id, it)
  const meaningfulRecentCompletion = findMeaningfulRecentCompletion(activities, allItems, nowMs)

  const lastUser = lastUserMessageIso()
  const hoursSinceLastMessage = lastUser ? (nowMs - new Date(lastUser).getTime()) / 3600000 : Infinity
  const userActive = hoursSinceLastMessage < 10 / 60

  const context = repo.todayContext().map((c) => ({ kind: c.kind, text: c.text }))

  return {
    takenAt: nowIso,
    timeOfDay: timeOfDayFor(hour),
    hour,
    today,
    topPriority,
    nextTimedToday: findNextTimedToday(nowMs, endOfDayMs),
    upcomingDeadline,
    overdueCount: overdue.length,
    waitingCount: waiting.length,
    planBehind: findPlanBehind(nowIso),
    userContext: context,
    meaningfulRecentCompletion,
    dayLoad,
    userActive,
    hoursSinceLastMessage
  }
}
