import { BrowserWindow } from 'electron'
import * as repo from './repo'
import { log } from './log'
import { IPC, type ChatMessage } from '../shared/types'
import type { CompanionContext } from './companionContext'

/**
 * Creature voice arbitration (the reshape: "the creature is the Secretary's voice").
 *
 * Every proactive line the Secretary already knows how to compute — the morning briefing (8a), the daily
 * missed-task/waiting follow-up (8c), the approaching-deadline alert (8b), the rare initiation (9e), the naming
 * moment (9g) — now flows through this one module. That gives us three things the earlier per-channel wiring
 * couldn't easily give us: (1) a stable, single voice character across every proactive interruption; (2) a
 * live-in-the-app-vs-toast-when-closed decision, made once, so a deadline alert becomes a chat message when the
 * user is looking, and stays a toast when they aren't — never both about the same event; (3) an honest answer to
 * "why did you tell me this?" — every proactive line records the CompanionContext that drove it, plus the source
 * rule and the item ids referenced, and a small tier-0 route can quote that back verbatim, from real state.
 *
 * The per-channel logic (feasibility for 8b, the "surface once, cap out, never nag" rules for 8c, the long-focus /
 * late-night / deadline-soon triggers for 9e) is untouched — this module only unifies delivery and record-keeping.
 * The intelligence stays where it was; the voice is what got consolidated.
 */

const SOURCE_HISTORY_KEY = 'creature_voice.recent'
const MAX_HISTORY = 20
const RECENT_WINDOW_MS = 60 * 60 * 1000 // an hour — long enough that "why did you tell me that?" still works if the user asks after doing something else first

export type ProactiveSource = 'briefing' | 'follow_up' | 'deadline_alert' | 'initiate_focus' | 'initiate_late' | 'initiate_deadline_soon' | 'naming' | 'deadline_soon' | 'other'

export interface ProactiveRecord {
  /** ISO instant the line was delivered. */
  at: string
  /** Which rule fired. */
  source: ProactiveSource
  /** The exact user-visible line. */
  content: string
  /** Real items/deadlines/events this line referenced, if any — for "why did you tell me this?" */
  refs: { itemId?: string; eventId?: string; planId?: string }[]
  /** Very compact snapshot of the CompanionContext at that moment (only the fields we need to explain). */
  ctx: {
    timeOfDay: string
    hour: number
    dayLoad: string | null
    overdueCount: number
    waitingCount: number
    upcomingDeadlineTitle: string | null
    upcomingDeadlineHoursUntil: number | null
    upcomingDeadlineFeasibility: string | null
    topPriorityTitle: string | null
  }
}

function loadHistory(): ProactiveRecord[] {
  try {
    const raw = repo.getSettingValue(SOURCE_HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? (arr as ProactiveRecord[]) : []
  } catch {
    return []
  }
}

function saveHistory(list: ProactiveRecord[]): void {
  repo.setSettingValue(SOURCE_HISTORY_KEY, JSON.stringify(list.slice(-MAX_HISTORY)))
}

/**
 * Record a proactive delivery so "why are you telling me this?" can answer honestly. Called every time a proactive
 * line goes out — chat OR toast, doesn't matter — so the record is a real audit trail of what the Secretary said
 * and why it thought it should. The full CompanionContext isn't stored (it's big and refers to db rows that will
 * change) — a small honest snapshot is enough for the explain path.
 */
export function recordProactive(source: ProactiveSource, content: string, refs: ProactiveRecord['refs'], ctx: CompanionContext): void {
  const history = loadHistory()
  history.push({
    at: new Date().toISOString(),
    source,
    content,
    refs,
    ctx: {
      timeOfDay: ctx.timeOfDay,
      hour: ctx.hour,
      dayLoad: ctx.dayLoad,
      overdueCount: ctx.overdueCount,
      waitingCount: ctx.waitingCount,
      upcomingDeadlineTitle: ctx.upcomingDeadline?.title ?? null,
      upcomingDeadlineHoursUntil: ctx.upcomingDeadline?.hoursUntil ?? null,
      upcomingDeadlineFeasibility: ctx.upcomingDeadline?.feasibility ?? null,
      topPriorityTitle: ctx.topPriority?.title ?? null
    }
  })
  saveHistory(history)
}

/** The most recent proactive record, if any, within the last hour — the thing "why did you tell me that?" answers about. */
export function lastRecentProactive(nowIso = new Date().toISOString()): ProactiveRecord | null {
  const history = loadHistory()
  if (!history.length) return null
  const last = history[history.length - 1]
  if (new Date(nowIso).getTime() - new Date(last.at).getTime() > RECENT_WINDOW_MS) return null
  return last
}

/**
 * "Why are you telling me this?" — an honest explanation from the recorded source context, not a fresh model call.
 * Reads the last recent proactive line and quotes back the specific reasoning behind it. Never fabricates: if
 * there's no recent proactive line, we say so plainly.
 */
export function explainLastProactive(nowIso = new Date().toISOString()): string {
  const rec = lastRecentProactive(nowIso)
  if (!rec) return "I haven't said anything unprompted recently — nothing to explain."
  const bits: string[] = []
  switch (rec.source) {
    case 'briefing':
      bits.push(`Morning check-in, once a day. Today looks ${rec.ctx.dayLoad ?? 'unknown'}.`)
      if (rec.ctx.topPriorityTitle) bits.push(`Top of mind: "${rec.ctx.topPriorityTitle}".`)
      break
    case 'follow_up':
      bits.push(`A small follow-up — ${rec.ctx.overdueCount} overdue and ${rec.ctx.waitingCount} waiting.`)
      break
    case 'deadline_alert':
    case 'deadline_soon':
    case 'initiate_deadline_soon':
      if (rec.ctx.upcomingDeadlineTitle) {
        bits.push(
          `"${rec.ctx.upcomingDeadlineTitle}" is due in ${rec.ctx.upcomingDeadlineHoursUntil ?? '?'} h` +
            (rec.ctx.upcomingDeadlineFeasibility && rec.ctx.upcomingDeadlineFeasibility !== 'comfortable'
              ? ` and the arithmetic reads as ${rec.ctx.upcomingDeadlineFeasibility}.`
              : '.')
        )
      }
      break
    case 'initiate_focus':
      bits.push(`You'd been focused for two hours — I noticed and said something.`)
      break
    case 'initiate_late':
      bits.push(`It was late (${rec.ctx.hour}:00) and you were still going.`)
      break
    case 'naming':
      bits.push(`You'd used the app a few different days — felt like the right moment to ask.`)
      break
    default:
      bits.push(`Because of something I saw in your calendar or your open items.`)
  }
  return bits.join(' ')
}

/** Push a proactive assistant message to the currently focused/visible window, if there is one. */
export function pushToRenderer(msg: ChatMessage): boolean {
  const wins = BrowserWindow.getAllWindows()
  const target = wins.find((w) => w.isVisible() && !w.isDestroyed()) ?? wins[0]
  if (!target || target.isDestroyed()) return false
  try {
    target.webContents.send(IPC.messageAdded, msg)
    return true
  } catch (e) {
    log('warn', 'creatureVoice.push_failed', (e as Error).message)
    return false
  }
}

/**
 * Creature-presence pulse (creature-presence pass, 2026-09-19): fired ~600ms before a proactive message push,
 * so the renderer puts the creature into an attentive state BEFORE the message renders. This makes the sequence
 * "creature notices → creature speaks" visible, rather than "message spawns simultaneously with a state change."
 * The pulse is best-effort — if the send fails, the message still lands and the state machine handles it
 * gracefully; nothing about the message's arrival depends on this pulse.
 */
export function sendNoticingPulse(): void {
  const wins = BrowserWindow.getAllWindows()
  const target = wins.find((w) => w.isVisible() && !w.isDestroyed()) ?? wins[0]
  if (!target || target.isDestroyed()) return
  try {
    target.webContents.send(IPC.creatureNoticing)
  } catch (e) {
    log('warn', 'creatureVoice.notice_failed', (e as Error).message)
  }
}

/**
 * Is the app currently in a state where a chat message is a better delivery than a Windows toast? True when the
 * user's main window is visible AND focused — the two conditions together mean the user is actually looking at
 * the app right now, not just holding it in the background. Anything else falls back to the toast path, so a
 * deadline alert at 3am to a minimized app still shows up as a system notification, not a silent chat message the
 * user won't see for hours.
 */
export function appIsForeground(): boolean {
  const wins = BrowserWindow.getAllWindows()
  return wins.some((w) => w.isVisible() && w.isFocused() && !w.isDestroyed())
}
