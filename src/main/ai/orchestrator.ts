import { log } from '../log'
import * as repo from '../repo'
import { assembleContext } from './context'
import { ProviderUnavailableError, type Provider, type ProviderMessage, type ToolCall, type ToolResult } from './provider'
import { executeTool, inTransaction, isWriteTool, toolDefinitions } from './tools'
import type { AppliedChange, ChatResponse, ChatStatus } from '../../shared/types'

const TIER = 2
const MAX_ROUNDS = 4

const SYSTEM_PROMPT = `You are a personal secretary living inside a small desktop app. One user, warm and brief.

How you work:
- The user talks in plain language. You record, change, complete and cancel their items and reminders by calling tools. You never write to storage any other way.
- Only claim something was recorded, moved, completed or cancelled if the tool result for it says ok. If a tool fails, say plainly what did not happen.
- Prefer acting over asking. If the target is genuinely ambiguous (e.g. "move that" with two plausible items), ask one short question instead of guessing.

Reference resolution:
- "it", "that", "the earlier one" usually mean the most recently touched item listed in the context. When the user gives a new time for something just created ("actually make it 4"), update THAT item with update_item — never create a second one. Its reminder moves with it automatically.

Times — be honest about precision:
- The context tells you today's date and time. Resolve relative phrases yourself.
- If the user stated a clock time ("Thursday at 3", "tomorrow at 9", "in two hours"), use the *_at_local field ("YYYY-MM-DDTHH:MM"). A bare number for an appointment means the afternoon/business hour (3 → 15:00) unless context says otherwise.
- If the user gave only a day ("tomorrow", "Friday", "tom", "next week"), use the *_date_local field ("YYYY-MM-DD"). NEVER invent a clock time. "Next week" → the Monday with due_looseness "week". "Sometime"/"at some point" → due_looseness "vague".
- "Thursday" means the next Thursday from today (today if it is Thursday and the time is still ahead).

Reminders are alarms, tasks are obligations:
- Create a reminder only when the user asks for one ("remind me", "ping me", "alarm"). A task with a due date and no reminder is normal.
- If they ask to be reminded on a day without a clock time, use remind_date_local; the app picks their default reminder time and tells them. If they give a time, use remind_at_local.
- "Cancel the reminder" → cancel_reminder only; the item stays. "I'm not doing X" → cancel_item for that one item only. If the user asks to forget/drop something that sounds like a project with several parts, ask first and name what would go.

Importance is inferred, never asked: read it from their wording and deadline pressure. If they override ("that's not actually important"), update importance.

Suggestions: anything you propose that the user did not state gets is_suggestion=true, and you phrase it as an offer, not a fact.

Replies: one or two short sentences, no bullet lists unless listing several items. State what you did with the concrete day/time exactly as the tool result reports it — if the result says a reminder fires "at 09:00 (default …)", tell them that so they can change it. Never mention tools, ids or JSON.`

export interface OrchestratorDeps {
  provider: Provider | null
  onStatus: (s: ChatStatus) => void
  onChanged: () => void
}

let queue: Promise<unknown> = Promise.resolve()

/** Messages are processed strictly one at a time so throttling never loses or reorders input. */
export function enqueueChat(deps: OrchestratorDeps, text: string): Promise<ChatResponse> {
  const run = queue.then(() => handleChat(deps, text))
  queue = run.catch(() => undefined)
  return run
}

async function handleChat(deps: OrchestratorDeps, rawText: string): Promise<ChatResponse> {
  const text = rawText.trim()
  const userMessage = repo.insertMessage('user', text, null)
  const applied: AppliedChange[] = []
  let error: string | null = null
  let replyText: string | null = null

  try {
    if (!deps.provider) {
      throw new ProviderUnavailableError('No AI provider is configured. Add GEMINI_API_KEY to the .env file and restart the app.')
    }
    deps.onStatus({ kind: 'thinking' })

    const history = repo
      .recentMessages(11)
      .filter((m) => m.id !== userMessage.id && m.role !== 'system')
      .slice(-10)
    const messages: ProviderMessage[] = history.map((m) =>
      m.role === 'user' ? { role: 'user', text: m.content } : { role: 'assistant', text: m.content, toolCalls: [] }
    )
    messages.push({ role: 'user', text: `Context:\n${assembleContext(text)}\n\nUser message:\n${text}` })
    const tools = toolDefinitions()

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await deps.provider.complete({ system: SYSTEM_PROMPT, messages, tools, turnId: userMessage.id }, (s) =>
        deps.onStatus({ kind: 'throttled', retryInSeconds: s })
      )
      log(
        'info',
        'ai.response',
        `round ${round + 1} (${res.model ?? '?'}): ${res.toolCalls.length} tool call(s)${res.text ? ', text' : ''}; tokens in=${res.usage?.input ?? '?'} out=${res.usage?.output ?? '?'}`
      )

      if (res.toolCalls.length === 0) {
        replyText = res.text
        break
      }

      deps.onStatus({ kind: 'tools', count: res.toolCalls.length })
      // Text that arrives alongside tool calls is a promise, not a fact — it is discarded (hard rule 3).
      messages.push({ role: 'assistant', text: null, toolCalls: res.toolCalls })
      const results = runToolRound(res.toolCalls, userMessage.id, applied)
      messages.push({ role: 'tool', results })
      deps.onChanged()

      if (round === MAX_ROUNDS - 1) {
        replyText = applied.length
          ? 'Done: ' + applied.map((a) => a.summary).join('; ') + '.'
          : "I got tangled up and didn't finish that. Nothing was changed — could you say it again?"
      }
    }

    if (!replyText) {
      replyText = applied.length
        ? 'Done: ' + applied.map((a) => a.summary).join('; ') + '.'
        : "I'm not sure what you'd like me to do with that — could you say a bit more?"
    }
  } catch (e) {
    const err = e as Error
    error = err.message
    log('error', 'ai.failed', err.stack ?? err.message)
    replyText =
      e instanceof ProviderUnavailableError
        ? err.message
        : applied.length
          ? `I recorded this much: ${applied.map((a) => a.summary).join('; ')}. Then something went wrong (${short(err.message)}), so anything after that was not done.`
          : `Something went wrong talking to the model (${short(err.message)}). Nothing was changed — please try again in a moment.`
  } finally {
    deps.onStatus({ kind: 'idle' })
  }

  const assistantMessage = repo.insertMessage('assistant', replyText!, TIER)
  deps.onChanged()
  return { userMessage, assistantMessage, applied, error }
}

/**
 * Execute one round of tool calls. All write calls in the round share one transaction:
 * if any fails to validate or execute, none of them are applied, and the model is told why.
 * Read calls run outside the transaction and can never change data.
 * Every round is logged to `extractions` (spec invariant 3), applied or not.
 */
function runToolRound(calls: ToolCall[], messageId: string | null, applied: AppliedChange[]): ToolResult[] {
  const writes = calls.filter((c) => isWriteTool(c.name))
  const reads = calls.filter((c) => !isWriteTool(c.name))
  const results: ToolResult[] = []
  const proposed = JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args })))

  if (writes.length) {
    const roundApplied: AppliedChange[] = []
    try {
      const outcomes = inTransaction(() =>
        writes.map((c) => {
          const o = executeTool(c.name, c.args, messageId)
          if (o.applied) roundApplied.push(o.applied)
          return { call: c, result: o.result }
        })
      )
      // Transaction committed — only now do these become facts.
      applied.push(...roundApplied)
      for (const o of outcomes) results.push({ callId: o.call.id, name: o.call.name, result: o.result })
      repo.insertExtraction(messageId, proposed, true, null)
      log('info', 'tools.applied', roundApplied.map((a) => a.summary).join(' | '))
    } catch (e) {
      const msg = (e as Error).message
      repo.insertExtraction(messageId, proposed, false, msg)
      log('warn', 'tools.rejected', msg)
      for (const c of writes) {
        results.push({ callId: c.id, name: c.name, result: { ok: false, error: `Not applied. ${msg}` } })
      }
    }
  } else {
    repo.insertExtraction(messageId, proposed, true, null)
  }

  for (const c of reads) {
    try {
      results.push({ callId: c.id, name: c.name, result: executeTool(c.name, c.args, messageId).result })
    } catch (e) {
      results.push({ callId: c.id, name: c.name, result: { ok: false, error: (e as Error).message } })
    }
  }
  return results
}

/**
 * Actions that arrive from outside the conversation (toast buttons) go through the very same
 * validated, transactional tool path — never a separate code path (spec §5 "Notification actions").
 */
export function applyExternalTools(origin: string, calls: { name: string; args: Record<string, unknown> }[]): AppliedChange[] {
  const applied: AppliedChange[] = []
  const sys = repo.insertMessage('system', `[${origin}] ${calls.map((c) => c.name).join(', ')}`, 0)
  runToolRound(
    calls.map((c, i) => ({ id: `local_ext_${i}`, name: c.name, args: c.args })),
    sys.id,
    applied
  )
  // Rewrite the placeholder into something a person can read in the conversation.
  repo.updateMessageContent(
    sys.id,
    applied.length
      ? `From the notification: ${applied.map((a) => a.summary).join('; ')}`
      : `From the notification: ${calls.map((c) => c.name.replace(/_/g, ' ')).join(', ')} — nothing was changed`
  )
  return applied
}

/** Providers often throw JSON blobs; pull out the human message if there is one, then trim. */
function short(s: string): string {
  let msg = s
  const start = s.indexOf('{')
  if (start >= 0) {
    try {
      const parsed = JSON.parse(s.slice(start)) as { error?: { message?: string }; message?: string }
      msg = parsed.error?.message ?? parsed.message ?? s
    } catch {
      /* not JSON — keep as is */
    }
  }
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg
}
