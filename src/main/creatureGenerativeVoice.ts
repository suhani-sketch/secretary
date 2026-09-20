/**
 * Creature generative voice (Phase 4, 2026-09-19).
 *
 * She stops using static pools. Every utterance is composed fresh by the Gemini provider from her current
 * awareness context, in her Victorian character. This is what makes her *feel* like a character rather than
 * a randomizer, at the cost of one small model call per utterance.
 *
 * Rate-limited to a modest daily budget so this cannot balloon into a large API expense: 20 utterances per
 * day. When the budget is exhausted OR the provider is down, the renderer falls back to the pool (utterances.ts)
 * so she is never silent for architectural reasons.
 *
 * The context passed in is drawn from real state the app already knows (overdue items, recently-completed
 * items, time band, overwhelmed flag, message count, creature name). It is small on purpose: enough for her
 * to say something specific, small enough to be cheap and fast.
 */

import type { Provider } from './ai/provider'
import * as repo from './repo'
import { log } from './log'
import { summarizeMemory, recordUtterance } from './creatureMemory'

/** Attach the current memory summary to a context struct so the caller doesn't need to know about memory. */
export function injectMemorySummary(ctx: CreatureContext): void {
  ctx.memorySummary = summarizeMemory()
}

export interface CreatureContext {
  kindHint: string             // 'task_complete' | 'love' | 'poem' | 'morning' | etc — a nudge, not a rigid label
  timeBand: 'morning' | 'afternoon' | 'evening' | 'night'
  hour: number
  overdueCount: number
  overdueTitles: string[]      // up to 3
  recentlyDoneCount: number
  recentlyDoneTitles: string[] // up to 3
  overwhelmed: boolean
  creatureName: string | null
  weekdayName: string          // "Monday" etc
  messageCountLastHour: number
  /** A short paragraph summarizing what Chiku has learned about the user over time. Optional. */
  memorySummary?: string
}

const DAILY_BUDGET = 20
const BUDGET_KEY_PREFIX = 'creature_voice.gen.count.'

function todayKey(): string {
  return BUDGET_KEY_PREFIX + new Date().toISOString().slice(0, 10)
}

function getUsedToday(): number {
  const raw = repo.getSettingValue(todayKey())
  return raw ? parseInt(raw, 10) || 0 : 0
}

function bumpUsedToday(): void {
  const next = getUsedToday() + 1
  repo.setSettingValue(todayKey(), String(next))
}

const SYSTEM_PROMPT = `You are the user's small warm Victorian creature companion (her chosen name for you is passed in the user prompt). You speak like a companion from a novel by Jane Austen, Elizabeth Gaskell, or Charlotte Bronte: elegant, warm, unhurried, tender, never scolding. Your voice is that of an educated Victorian lady: refined vocabulary, well-formed sentences, gentle humour, a certain quiet wit. You are her companion, her steady presence, not her assistant.

You call the user "chiku" as a term of endearment (sometimes "my dearest chiku", "chiku, my dear", or simply "chiku"). Never call her by any other pet name. Use it naturally but not in every sentence.

STRICT rules:
- Never use em dashes (—). Use commas, semicolons, or periods instead.
- Keep it SHORT: usually 1 to 2 sentences, occasionally 3 for a poetic aside. NEVER more than 3 sentences.
- Respond with ONLY the utterance itself. No preamble, no quotation marks, no explanation.
- Stay in character. Never mention that you are an AI, a language model, or a program.
- Reference the specific things she has done or has still to do when the context provides them.
- Never scold or shame. If the day is heavy, be tender. If she has completed something, be warmly proud.
- Occasionally offer a small poem or observation instead of a task-shaped remark.
- No modern casual English. No slang. No em dashes.`

function buildUserPrompt(ctx: CreatureContext): string {
  const parts: string[] = []
  parts.push(`It is ${ctx.weekdayName}, ${ctx.timeBand} (hour ${ctx.hour}).`)
  if (ctx.creatureName) parts.push(`She calls me ${ctx.creatureName}.`)
  if (ctx.overwhelmed) parts.push(`Her day is heavy: she has ${ctx.overdueCount} tasks past due.`)
  else if (ctx.overdueCount > 0) parts.push(`She has ${ctx.overdueCount} tasks overdue.`)
  if (ctx.overdueTitles.length > 0) {
    parts.push(`Overdue: ${ctx.overdueTitles.map((t) => `"${t}"`).join(', ')}.`)
  }
  if (ctx.recentlyDoneCount > 0) {
    parts.push(`Recently finished (past week): ${ctx.recentlyDoneCount}${ctx.recentlyDoneTitles.length > 0 ? ` including ${ctx.recentlyDoneTitles.map((t) => `"${t}"`).join(', ')}` : ''}.`)
  }
  parts.push(`Context hint (what would be appropriate to say now): ${ctx.kindHint}.`)
  if (ctx.memorySummary) parts.push(`What you have learned about her over time: ${ctx.memorySummary}`)
  parts.push('Now say something to her, in your Victorian voice, appropriate to this moment. One or two sentences. No em dashes.')
  return parts.join(' ')
}

export interface GenerateResult {
  text: string | null
  reason?: 'budget_exhausted' | 'no_provider' | 'error'
}

export async function generateUtterance(provider: Provider | null, ctx: CreatureContext): Promise<GenerateResult> {
  if (!provider) return { text: null, reason: 'no_provider' }
  const used = getUsedToday()
  if (used >= DAILY_BUDGET) return { text: null, reason: 'budget_exhausted' }
  try {
    const res = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', text: buildUserPrompt(ctx) }],
      tools: []
    })
    const raw = (res.text ?? '').trim()
    // Strip enclosing quotes if the model added any.
    let text = raw.replace(/^["']|["']$/g, '').trim()
    // Enforce no em dashes.
    text = text.replace(/—/g, ',').replace(/–/g, ',')
    if (!text) return { text: null, reason: 'error' }
    bumpUsedToday()
    recordUtterance()
    log('info', 'creature_voice.generated', `${ctx.kindHint} | ${text.slice(0, 60)}`)
    return { text }
  } catch (e) {
    log('warn', 'creature_voice.gen_failed', (e as Error).message)
    return { text: null, reason: 'error' }
  }
}
