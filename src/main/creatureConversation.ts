/**
 * Direct conversation with Chiku (Phase 6, 2026-09-19).
 *
 * When the user addresses her by name at the start of a message ("chiku, ..." / "hey chiku" / "chiku,"),
 * the message is diverted from the Secretary's tool pipeline and instead sent to Chiku directly through her
 * own Victorian voice with awareness of memory and recent utterances. The Secretary continues to operate
 * unchanged for every other message; addressing Chiku is a purely additional route.
 *
 * A small in-memory conversation history is kept per session so she can reply coherently across a few turns.
 * The history is capped short so the prompt stays cheap.
 */

import type { Provider } from './ai/provider'
import { summarizeMemory } from './creatureMemory'
import { log } from './log'

const HISTORY: Array<{ role: 'user' | 'assistant'; text: string }> = []
const MAX_HISTORY = 6

export interface ConverseContext {
  overdueTitles: string[]
  recentlyDoneTitles: string[]
  timeBand: 'morning' | 'afternoon' | 'evening' | 'night'
  weekdayName: string
  creatureName: string | null
}

const CONVERSE_SYSTEM = `You are the user's small warm Victorian creature companion (her chosen name for you comes in the user prompt as "creatureName"). You call her "chiku" as a term of endearment (sometimes "my dearest chiku", "chiku, my dear", or simply "chiku"). Use it naturally, not in every sentence. Never use any other pet name for her.

You speak in a Jane Austen / Elizabeth Gaskell / Charlotte Bronte register: elegant, warm, unhurried, tender, refined vocabulary, gentle humour, a certain quiet wit.

You are NOT a productivity assistant. You are her friend. She can talk to you about how she feels, her day, the weather, a book, or anything at all. When she shares something with you, respond warmly and in-character. Reference her real state (overdue tasks, recent completions, weekday) only when relevant to what she said.

STRICT rules:
- Never use em dashes. Use commas, semicolons, or periods.
- Keep responses SHORT: 1 to 3 sentences usually. NEVER more than 4 sentences.
- Respond with ONLY your utterance itself. No preamble, no quotation marks.
- Stay in character. Never mention you are an AI, a language model, or a program.
- Never scold or shame. Never lecture. Just be a warm companion.
- No modern casual English. No slang.

Remember: chiku is talking to YOU, her companion, not the Secretary. You are her small warm creature. Be that.`

function buildContextIntro(ctx: ConverseContext): string {
  const parts: string[] = []
  parts.push(`It is ${ctx.weekdayName}, ${ctx.timeBand}.`)
  if (ctx.creatureName) parts.push(`She calls me ${ctx.creatureName}.`)
  if (ctx.overdueTitles.length > 0) parts.push(`Her overdue tasks: ${ctx.overdueTitles.map((t) => `"${t}"`).join(', ')}.`)
  if (ctx.recentlyDoneTitles.length > 0) parts.push(`Recently finished: ${ctx.recentlyDoneTitles.map((t) => `"${t}"`).join(', ')}.`)
  const mem = summarizeMemory()
  if (mem) parts.push(`Memory: ${mem}`)
  return parts.join(' ')
}

export interface ConverseResult {
  text: string | null
  reason?: 'no_provider' | 'error'
}

/** True if this message should be routed to Chiku instead of the Secretary. */
export function looksLikeAddress(text: string): boolean {
  return /^\s*(hey\s+)?chiku[\s,:.!?]/i.test(text) || /^\s*chiku$/i.test(text)
}

/** Strip the "chiku" prefix from the user's message so the model sees just what she actually said. */
export function stripAddress(text: string): string {
  return text.replace(/^\s*(hey\s+)?chiku[\s,:.!?]+/i, '').trim() || text
}

export async function converseWithCreature(provider: Provider | null, userMessage: string, ctx: ConverseContext): Promise<ConverseResult> {
  if (!provider) return { text: null, reason: 'no_provider' }
  const cleaned = stripAddress(userMessage)
  try {
    // Assemble a lightweight message list: recent history + this turn.
    const messages: import('./ai/provider').ProviderMessage[] = []
    // First user turn also carries the current context as a preamble so the model doesn't need it every time.
    if (HISTORY.length === 0) {
      messages.push({ role: 'user', text: `[Context: ${buildContextIntro(ctx)}]\n\n${cleaned}` })
    } else {
      for (const h of HISTORY) {
        if (h.role === 'user') messages.push({ role: 'user', text: h.text })
        else messages.push({ role: 'assistant', text: h.text, toolCalls: [] })
      }
      messages.push({ role: 'user', text: cleaned })
    }
    const res = await provider.complete({
      system: CONVERSE_SYSTEM,
      messages,
      tools: []
    })
    let text = (res.text ?? '').trim().replace(/^["']|["']$/g, '').trim()
    text = text.replace(/—/g, ',').replace(/–/g, ',')
    if (!text) return { text: null, reason: 'error' }
    // Track history for the next turn (rolling window).
    HISTORY.push({ role: 'user', text: cleaned })
    HISTORY.push({ role: 'assistant', text })
    while (HISTORY.length > MAX_HISTORY * 2) HISTORY.shift()
    log('info', 'creature_conversation.reply', text.slice(0, 80))
    return { text }
  } catch (e) {
    log('warn', 'creature_conversation.failed', (e as Error).message)
    return { text: null, reason: 'error' }
  }
}
