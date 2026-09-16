/**
 * "What should I do right now?" (spec §8 Phase 7c) — platform-independent, no Electron, no SQLite, no model.
 *
 * One concrete next action (or a very small number), ranked in CODE from urgency, importance, hardness, overdue state,
 * blockers, the free time available right now, effort, today's context, commitments and whether the thing can actually be
 * started at this moment. Never an unranked list. When nothing can be started, it says so and why, instead of inventing
 * something. `describeRecommendation` writes the sentence, so answering costs no model call.
 */
import { DateTime } from 'luxon'

export interface NowCandidate {
  id: string
  title: string
  kind: string
  importance: number | null
  hardness: string | null
  due_at_utc: string | null
  due_precision: string | null
  /** The user's own figure; null → assumed. */
  effort_minutes: number | null
  /** Plain descriptions of OPEN blockers ("the reply from Priya", "Send first email"). Non-empty = cannot start. */
  blocked_by: string[]
  committed_to: string | null
  /** How many open things this one gates. */
  unblocks: number
  /** A work block for it is running at this very moment. */
  scheduled_now: boolean
  project: string | null
  created_at: string
}

export interface NowInput {
  nowUtc: string
  zone: string
  candidates: NowCandidate[]
  /** Minutes until the next timed event or unavailable window starts; null = nothing ahead for the rest of the day. */
  freeMinutes: number | null
  nextBusy: { title: string; startsUtc: string } | null
  /** Currently inside an event that is not a work block (a meeting, a class): nothing else can really start. */
  inEvent: { title: string; endsUtc: string | null } | null
  context: { energyLow: boolean; texts: string[] }
  assumedEffortMinutes?: { step: number; other: number }
}

export type Band = 'morning' | 'day' | 'evening' | 'night'

export interface RankedAction {
  candidate: NowCandidate
  score: number
  reasons: string[]
  effort_minutes: number
  effort_assumed: boolean
}

export interface Recommendation {
  band: Band
  pick: RankedAction | null
  /** Close runners-up, at most two, only when the pick is not clearly ahead. */
  alternatives: RankedAction[]
  /** Why each open thing was set aside — used when nothing can start, and to explain the ranking. */
  excluded: { candidate: NowCandidate; why: string }[]
  none_reason: string | null
  energy_low: boolean
}

const MIN_START_MINUTES = 15

/** Something the user attends at a fixed time (a screening, a meeting, a class) is not work that can be started. */
export const ATTENDANCE = /\b(screening|meeting|class|lecture|tutorial|seminar|workshop|appointment|dentist|doctor|interview|viva|exam|flight|train|party|wedding|dinner|lunch|brunch|concert|show|gig|match|game|ceremony|premiere|conference|webinar|talk|standup|stand-up|call with)\b/i

export const bandFor = (nowUtc: string, zone: string): Band => {
  const h = DateTime.fromISO(nowUtc, { zone: 'utc' }).setZone(zone).hour
  if (h < 7 || h >= 21) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

const isOverdue = (c: NowCandidate, nowUtc: string, zone: string): boolean => {
  if (!c.due_at_utc) return false
  const now = DateTime.fromISO(nowUtc, { zone: 'utc' }).setZone(zone)
  const due = DateTime.fromISO(c.due_at_utc, { zone: 'utc' }).setZone(zone)
  if (c.due_precision === 'exact') return due < now
  if (c.due_precision === 'day') return due.startOf('day') < now.startOf('day')
  return due.plus({ days: 7 }) < now
}

const daysToDue = (c: NowCandidate, nowUtc: string, zone: string): number | null => {
  if (!c.due_at_utc) return null
  const now = DateTime.fromISO(nowUtc, { zone: 'utc' }).setZone(zone).startOf('day')
  const due = DateTime.fromISO(c.due_at_utc, { zone: 'utc' }).setZone(zone).startOf('day')
  return Math.round(due.diff(now, 'days').days)
}

const minutesText = (m: number): string => (m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 2) / 2} h`)
const dueWord = (c: NowCandidate, zone: string): string => {
  const d = DateTime.fromISO(c.due_at_utc!, { zone: 'utc' }).setZone(zone)
  return c.due_precision === 'exact' ? d.toFormat('ccc HH:mm') : d.toFormat('ccc d LLL')
}

export function recommendNow(inp: NowInput): Recommendation {
  const band = bandFor(inp.nowUtc, inp.zone)
  const assumed = inp.assumedEffortMinutes ?? { step: 30, other: 60 }
  const ranked: RankedAction[] = []
  const excluded: { candidate: NowCandidate; why: string }[] = []

  for (const c of inp.candidates) {
    if (c.kind === 'project' || c.kind === 'waiting' || c.kind === 'note') continue
    const effortAssumed = !c.effort_minutes
    const effort = c.effort_minutes ?? (c.kind === 'checklist_item' ? assumed.step : assumed.other)
    const reasons: string[] = []
    let windowReason: string | null = null
    let score = 0

    if (c.scheduled_now) {
      score += 100
      reasons.push('you set this time aside for it')
    }
    if (c.blocked_by.length) {
      excluded.push({ candidate: c, why: `waits on ${c.blocked_by.join(' and ')}` })
      continue
    }
    // Fixed-time things are attended, not started: an exact clock more than two hours away, or an attendance-like title.
    if (!c.scheduled_now && c.due_at_utc) {
      const minutesAway = (new Date(c.due_at_utc).getTime() - new Date(inp.nowUtc).getTime()) / 60_000
      if (ATTENDANCE.test(c.title)) {
        excluded.push({ candidate: c, why: `is something you attend (${dueWord(c, inp.zone)}), not work to start` })
        continue
      }
      if (c.due_precision === 'exact' && minutesAway > 120) {
        excluded.push({ candidate: c, why: `is fixed for ${dueWord(c, inp.zone)}` })
        continue
      }
    }
    // Inside a meeting/class: only a genuinely tiny thing can start; everything else waits for it to end.
    if (inp.inEvent && !c.scheduled_now && effort > 10) {
      excluded.push({ candidate: c, why: `you're in "${inp.inEvent.title}" right now` })
      continue
    }
    // Free time before the next fixed thing: something that cannot even be started in it is set aside, with the reason kept.
    if (inp.freeMinutes !== null && !c.scheduled_now) {
      if (inp.freeMinutes < MIN_START_MINUTES && effort > inp.freeMinutes) {
        excluded.push({ candidate: c, why: `needs about ${minutesText(effort)} and "${inp.nextBusy?.title ?? 'the next thing'}" starts in ${Math.max(1, Math.round(inp.freeMinutes))} min` })
        continue
      }
      if (effort <= inp.freeMinutes) {
        score += 8
        // Worth saying only when the window is what makes it fit; "fits in the 10 h before…" is noise.
        if (inp.nextBusy && inp.freeMinutes <= 180) windowReason = `fits in the ${minutesText(inp.freeMinutes)} before "${inp.nextBusy.title}"`
      } else {
        score -= 12
        windowReason = `you can make a start, though it won't finish before "${inp.nextBusy?.title ?? 'the next thing'}"`
      }
    }

    const overdue = isOverdue(c, inp.nowUtc, inp.zone)
    const dtd = daysToDue(c, inp.nowUtc, inp.zone)
    if (overdue) {
      score += 50
      reasons.push(`overdue (was ${dueWord(c, inp.zone)})`)
    }
    if (c.kind === 'commitment') {
      score += 30
      reasons.push(`promised to ${c.committed_to ?? 'someone'}`)
    }
    if (c.hardness === 'hard' || c.kind === 'deadline') {
      score += 25
      if (!overdue && c.due_at_utc) reasons.push(`hard deadline ${dueWord(c, inp.zone)}`)
    }
    const imp = c.importance ?? 2
    if (imp <= 0) {
      score += 30
      reasons.push('critical')
    } else if (imp === 1) {
      score += 15
      if (!reasons.length) reasons.push('high importance')
    } else if (imp >= 3) score -= 8
    if (c.kind === 'idea') score -= 25
    if (dtd !== null && !overdue) {
      if (dtd <= 0) {
        score += 14
        if (!reasons.some((r) => r.startsWith('hard deadline'))) reasons.push('due today')
      } else if (dtd === 1) {
        score += 8
        if (!reasons.some((r) => r.startsWith('hard deadline'))) reasons.push('due tomorrow')
      } else if (dtd <= 3) score += 4
    }
    if (c.unblocks > 0) {
      score += 8 * Math.min(3, c.unblocks)
      reasons.push(`unblocks ${c.unblocks === 1 ? 'one other thing' : `${c.unblocks} other things`}`)
    }
    // Time of day and energy: late or low means small things first, big ones penalised — the 9 am answer differs from 11 pm.
    if (band === 'night') {
      if (effort > 45) score -= 25
      else if (effort <= 20) {
        score += 10
        reasons.push("it's late — a small one")
      }
    } else if (band === 'evening' && effort > 120) score -= 8
    else if (band === 'morning' && effort >= 60 && imp <= 1) {
      score += 6
      reasons.push('a big one for a fresh morning')
    }
    if (inp.context.energyLow) {
      if (effort >= 45) score -= 20
      else if (effort <= 20) {
        score += 10
        reasons.push('light enough for a low day')
      }
    }
    // Small and quick things get a nudge when nothing above already made the case.
    if (effort <= 15 && !reasons.length) reasons.push(`about ${minutesText(effort)}`)
    if (!reasons.length) reasons.push(dtd !== null ? `due ${dueWord(c, inp.zone)}` : 'the oldest thing on your list')
    if (windowReason) reasons.push(windowReason)
    ranked.push({ candidate: c, score, reasons, effort_minutes: effort, effort_assumed: effortAssumed })
  }

  ranked.sort((a, b) => b.score - a.score || (a.candidate.due_at_utc ?? '9').localeCompare(b.candidate.due_at_utc ?? '9') || a.candidate.created_at.localeCompare(b.candidate.created_at))
  const pick = ranked[0] ?? null
  const alternatives = pick ? ranked.slice(1).filter((r) => r.score >= pick.score - 12).slice(0, 2) : []

  let noneReason: string | null = null
  if (!pick) {
    if (!inp.candidates.length) noneReason = 'Nothing open at all.'
    else if (inp.inEvent) noneReason = `Nothing to start right now — you're in "${inp.inEvent.title}"${excluded.length ? `; ${excluded.slice(0, 3).map((e) => `${e.candidate.title} ${e.why}`).join('; ')}` : ''}.`
    else noneReason = `Nothing you can start right now: ${excluded.slice(0, 4).map((e) => `${e.candidate.title} ${e.why}`).join('; ')}.`
  }
  return { band, pick, alternatives, excluded, none_reason: noneReason, energy_low: inp.context.energyLow }
}

/** The reply, computed. One action with its reason; runners-up only when genuinely close; honesty when nothing can start. */
export function describeRecommendation(r: Recommendation): string {
  if (!r.pick) {
    const late = r.band === 'night' ? " It's late — nothing here needs tonight." : ''
    return `${r.none_reason ?? 'Nothing to suggest.'}${late}`
  }
  const p = r.pick
  const name = `${p.candidate.title}${p.candidate.project ? ` (${p.candidate.project})` : ''}`
  const effort = p.effort_assumed ? '' : ` It's about ${minutesText(p.effort_minutes)}, your figure.`
  let text = `${name} — ${p.reasons.slice(0, 3).join(', ')}.${effort}`
  if (r.energy_low && p.effort_minutes >= 45) text += ` You said you're low today — this is the smallest thing that's actually open (about ${minutesText(p.effort_minutes)}${p.effort_assumed ? ', assumed' : ''}). Leaving it for tomorrow is fine.`
  // Late at night the honest answer to "a big job is all that's left" is to say so, not to push it.
  if (r.band === 'night' && p.effort_minutes > 45 && !p.candidate.scheduled_now && !r.energy_low) text += ` It's late and this is about ${minutesText(p.effort_minutes)}${p.effort_assumed ? ' (assumed)' : ''} — tomorrow morning may suit it better.`
  if (r.alternatives.length) text += ` If not that: ${r.alternatives.map((a) => `${a.candidate.title} (${a.reasons[0]})`).join(', or ')}.`
  const blockedNote = r.excluded.filter((e) => e.why.startsWith('waits on')).slice(0, 2)
  if (blockedNote.length && r.pick.score < 40) text += ` Set aside: ${blockedNote.map((e) => `${e.candidate.title} ${e.why}`).join('; ')}.`
  return text
}
