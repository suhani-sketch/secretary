/**
 * Creature memory (Phase 5, 2026-09-19).
 *
 * The companion notices patterns in the user's life over time. This module tracks a compact rolling record
 * of the user's habits and moods, all stored as JSON in the `settings` table under `creature.memory.state`.
 * The generative voice module summarizes this into a short paragraph and feeds it into the Gemini prompt,
 * so Chiku can genuinely reference "you have finished 23 things this fortnight" or "Wednesdays do seem
 * heavy for you lately".
 *
 * Nothing here observes real conversation content. Only structural events: completions, overdue additions,
 * utterances shown, utterances dismissed quickly, activity by weekday. Everything is aggregate; nothing is
 * personally identifying beyond what the Secretary already stores.
 */

import * as repo from './repo'
import { log } from './log'

const MEMORY_KEY = 'creature.memory.state'
const MAX_POSTPONED_TITLES = 10

export type WeekdayName = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'

export interface CreatureMemory {
  /** Total tasks the user has ever completed since memory began. */
  totalCompleted: number
  /** Total utterances she has spoken. */
  totalUtterances: number
  /** How many she has been asked to dismiss quickly (within 5s). A soft signal of "she's saying too much". */
  dismissedQuickly: number
  /** Completions per weekday (accumulated). Reveals the user's productive rhythm. */
  completionsByWeekday: Record<WeekdayName, number>
  /** The 10 most-postponed titles the user keeps rescheduling. Compact rolling list. */
  mostPostponed: Array<{ title: string; count: number }>
  /** ISO timestamp of the most recent activity Chiku has witnessed. */
  lastActivityAt: string | null
  /** ISO timestamp when this memory record was born. */
  memoryStartedAt: string
  /** ISO timestamp of the most recent update to this record. */
  updatedAt: string
}

const WEEKDAY_NAMES: WeekdayName[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function emptyMemory(): CreatureMemory {
  const now = new Date().toISOString()
  return {
    totalCompleted: 0,
    totalUtterances: 0,
    dismissedQuickly: 0,
    completionsByWeekday: WEEKDAY_NAMES.reduce((acc, d) => ({ ...acc, [d]: 0 }), {} as Record<WeekdayName, number>),
    mostPostponed: [],
    lastActivityAt: null,
    memoryStartedAt: now,
    updatedAt: now
  }
}

export function readMemory(): CreatureMemory {
  const raw = repo.getSettingValue(MEMORY_KEY)
  if (!raw) return emptyMemory()
  try {
    const parsed = JSON.parse(raw) as Partial<CreatureMemory>
    return { ...emptyMemory(), ...parsed }
  } catch {
    return emptyMemory()
  }
}

function writeMemory(m: CreatureMemory): void {
  m.updatedAt = new Date().toISOString()
  try {
    repo.setSettingValue(MEMORY_KEY, JSON.stringify(m))
  } catch (e) {
    log('warn', 'creature_memory.write_failed', (e as Error).message)
  }
}

export function recordCompletion(title: string, at: Date = new Date()): void {
  const m = readMemory()
  m.totalCompleted += 1
  const weekday = WEEKDAY_NAMES[at.getDay()]
  m.completionsByWeekday[weekday] = (m.completionsByWeekday[weekday] ?? 0) + 1
  m.lastActivityAt = at.toISOString()
  // If this title was in the postponed list, drop it — she remembered you finally finished it.
  m.mostPostponed = m.mostPostponed.filter((p) => p.title !== title)
  writeMemory(m)
}

export function recordPostponement(title: string): void {
  const m = readMemory()
  const existing = m.mostPostponed.find((p) => p.title === title)
  if (existing) {
    existing.count += 1
  } else {
    m.mostPostponed.push({ title, count: 1 })
  }
  m.mostPostponed.sort((a, b) => b.count - a.count)
  m.mostPostponed = m.mostPostponed.slice(0, MAX_POSTPONED_TITLES)
  m.lastActivityAt = new Date().toISOString()
  writeMemory(m)
}

export function recordUtterance(): void {
  const m = readMemory()
  m.totalUtterances += 1
  writeMemory(m)
}

export function recordQuickDismiss(): void {
  const m = readMemory()
  m.dismissedQuickly += 1
  writeMemory(m)
}

/** Short paragraph fit for the generative-voice system prompt. Empty if nothing meaningful is known yet. */
export function summarizeMemory(): string {
  const m = readMemory()
  const parts: string[] = []
  if (m.totalCompleted > 3) {
    parts.push(`In your time together she has watched you finish ${m.totalCompleted} tasks.`)
  }
  // Which weekdays are heaviest with completion?
  const dayEntries = Object.entries(m.completionsByWeekday) as [WeekdayName, number][]
  const busiestDay = dayEntries.sort((a, b) => b[1] - a[1])[0]
  if (busiestDay && busiestDay[1] >= 3) {
    parts.push(`${busiestDay[0]}s seem to be her most industrious day.`)
  }
  // Chronic postponers
  if (m.mostPostponed.length > 0 && m.mostPostponed[0].count >= 2) {
    const top = m.mostPostponed[0]
    parts.push(`She has rescheduled "${top.title}" ${top.count} times; it lingers.`)
  }
  return parts.join(' ')
}
