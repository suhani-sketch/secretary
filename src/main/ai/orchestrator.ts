import { log } from '../log'
import * as repo from '../repo'
import { assembleContext } from './context'
import { ProviderUnavailableError, type Provider, type ProviderMessage, type ToolCall, type ToolResult } from './provider'
import { routeTier0 } from './router'
import { executeTool, inTransaction, isWriteTool, toolDefinitions, type ExecContext } from './tools'
import { formatDue } from '../../shared/format'
import type { Actor, AppliedChange, ChatResponse, ChatStatus, ToolRunResult } from '../../shared/types'

/** Spec §4: one user message costs at most one API call. Asserted, not hoped for. */
export const MAX_MODEL_CALLS_PER_MESSAGE = 1

const SYSTEM_PROMPT = `You are a personal secretary living inside a small desktop app. One user, warm and brief. You remember what is happening in their life.

How you work:
- The user talks in plain language. You record, change, complete and cancel their items and reminders by calling tools. You never write to storage any other way.
- When you call a write tool, do not also write a confirmation — the app composes the confirmation itself from what was actually saved. Just call the tool(s).
- You get ONE response per message. Either call tools, or answer in words from the context you were given. Do not call a read tool and expect a second turn — the context already contains today's, upcoming and recent items; answer from it.
- Prefer acting over asking. If the target is genuinely ambiguous (e.g. "move that" with two plausible items) and the action is consequential, ask one short question instead of guessing.

Actionability — what deserves a row:
- "I need to email the professor" → create_item (obligation).
- "I emailed the professor" → record_activity, NOT a task. If they add "but haven't heard back" → record_activity with now_waiting_on.
- "I should probably email the professor" → create_item kind idea, importance 1.
- "I'm exhausted today" / "I need to get my life together" → nothing stored; just respond kindly.
- When the user mentions an existing Thing, UPDATE that Thing (update_item / record_activity). Never create a second row for the same thing. Nothing is duplicated.

Reference resolution:
- "it", "that", "the earlier one" usually mean the most recently touched item listed in the context. When the user gives a new time for something just created ("actually make it 4"), update THAT item — never create a second one. Its reminder moves with it automatically.

Times — be honest about precision:
- The context tells you today's date and time. Resolve relative phrases yourself.
- If the user stated a clock time ("Thursday at 3", "tomorrow at 9", "in two hours"), use the *_at_local field ("YYYY-MM-DDTHH:MM"). A bare number for an appointment means the afternoon/business hour (3 → 15:00) unless context says otherwise.
- If the user gave only a day ("tomorrow", "Friday", "tom", "next week"), use the *_date_local field ("YYYY-MM-DD"). NEVER invent a clock time. "Next week" → the Monday with due_looseness "week". "Sometime"/"at some point" → due_looseness "vague".
- hardness: "must submit by", "deadline", "due" → hard. "I'd like to", "hoping to", "try to" → soft.

Reminders are alarms, tasks are obligations:
- Create a reminder only when the user asks for one ("remind me", "ping me", "alarm"). A task with a due date and no reminder is normal; the app itself offers a reminder when it makes sense.
- If they ask to be reminded on a day without a clock time, use remind_date_local; the app picks their default reminder time and tells them. If they give a time, use remind_at_local.
- Recurring ("every Sunday", "daily at 8", "each weekday"): set remind_rrule (RFC 5545, e.g. FREQ=WEEKLY;BYDAY=SU / FREQ=DAILY / FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR) and remind_at_local = the FIRST occurrence. Leave the due fields empty; a recurring chore has no single due date. For an existing item use create_reminder with rrule.
- "Cancel the reminder" → cancel_reminder only; the item stays. "I'm not doing X" → cancel_item for that one item only. cancel_item on a project (or delete_item ever) returns a confirmation question — relay it; when the user then says yes, call again with confirmed=true.
- "Undo" / "undo that" → undo_last.

Importance is inferred, never asked: read it from their wording and deadline pressure. If they override ("that's not actually important"), update importance.

Suggestions: anything you propose that the user did not state gets is_suggestion=true, and you phrase it as an offer, not a fact.

When you reply in words (no tool call): one or two short sentences, no bullet lists unless listing several items. Never mention tools, ids or JSON.`

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

const joinPhrases = (applied: AppliedChange[]): string => applied.map((a) => a.phrase).join(' ')

async function handleChat(deps: OrchestratorDeps, rawText: string): Promise<ChatResponse> {
  const text = rawText.trim()
  const userMessage = repo.insertMessage('user', text, null)
  const applied: AppliedChange[] = []
  let error: string | null = null
  let replyText: string | null = null
  let tier = 2
  let modelCalls = 0
  const started = Date.now()

  try {
    // ---- Tier 0: deterministic, no model call ----
    const t0 = routeTier0(text)
    if (t0) {
      tier = 0
      deps.onStatus({ kind: 'tools', count: t0.length })
      const outcome = runToolRound(
        t0.map((c, i) => ({ id: `local_t0_${i}`, name: c.name, args: c.args })),
        { actor: 'user', sourceMsgId: userMessage.id },
        applied
      )
      replyText = outcome.confirm
        ? outcome.confirm.question
        : outcome.error
          ? `I couldn't do that: ${outcome.error}. Nothing was changed.`
          : joinPhrases(applied)
      deps.onChanged()
      log('info', 'router.tier0', `${t0.map((c) => c.name).join(', ')} in ${Date.now() - started}ms`)
    } else {
      // ---- Tier 2: the model decides; exactly one call ----
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

      const res = await deps.provider.complete({ system: SYSTEM_PROMPT, messages, tools: toolDefinitions(), turnId: userMessage.id }, (s) =>
        deps.onStatus({ kind: 'throttled', retryInSeconds: s })
      )
      modelCalls++
      log(
        'info',
        'ai.response',
        `call ${modelCalls} (${res.model ?? '?'}): ${res.toolCalls.length} tool call(s)${res.text ? ', text' : ''}; tokens in=${res.usage?.input ?? '?'} out=${res.usage?.output ?? '?'}`
      )

      if (res.toolCalls.length === 0) {
        replyText = res.text ?? "I'm not sure what you'd like me to do with that — could you say a bit more?"
      } else {
        deps.onStatus({ kind: 'tools', count: res.toolCalls.length })
        const outcome = runToolRound(res.toolCalls, { actor: 'assistant', sourceMsgId: userMessage.id }, applied)
        deps.onChanged()
        if (outcome.confirm) {
          replyText = (applied.length ? joinPhrases(applied) + ' ' : '') + outcome.confirm.question
        } else if (outcome.hadWrites) {
          // Committed (or rejected) — the reply is composed from ground truth. No second model call.
          replyText = outcome.error
            ? applied.length
              ? `${joinPhrases(applied)} But I couldn't do the rest: ${outcome.error}.`
              : `I couldn't do that: ${outcome.error}. Nothing was changed.`
            : joinPhrases(applied)
        } else {
          // Read-only round: phrase the answer in code rather than spend a second call.
          replyText = phraseReadResults(outcome.results) ?? res.text ?? "I looked, but couldn't put that into words — could you ask again?"
        }
      }
    }
  } catch (e) {
    const err = e as Error
    error = err.message
    log('error', 'ai.failed', err.stack ?? err.message)
    replyText =
      e instanceof ProviderUnavailableError
        ? err.message
        : applied.length
          ? `${joinPhrases(applied)} Then something went wrong (${short(err.message)}), so anything after that was not done.`
          : `Something went wrong talking to the model (${short(err.message)}). Nothing was changed — please try again in a moment.`
  } finally {
    deps.onStatus({ kind: 'idle' })
  }

  if (modelCalls > MAX_MODEL_CALLS_PER_MESSAGE) {
    log('error', 'ai.call_budget_exceeded', `${modelCalls} calls for one message (budget ${MAX_MODEL_CALLS_PER_MESSAGE})`)
  }
  log('info', 'chat.done', `tier ${tier}, ${modelCalls} model call(s), ${applied.length} change(s), ${Date.now() - started}ms`)
  const assistantMessage = repo.insertMessage('assistant', replyText!, tier)
  deps.onChanged()
  return { userMessage, assistantMessage, applied, error }
}

/** Deterministic phrasing for read-only tool results, so a lookup never costs a second model call. */
function phraseReadResults(results: ToolResult[]): string | null {
  const lines: string[] = []
  for (const r of results) {
    const res = r.result as { items?: { title: string; due: string | null; status: string; is_suggestion?: boolean }[]; history?: string[]; item?: { title: string; due: string | null; status: string }; reminders?: { fires: string }[]; error?: string }
    if (res.error) {
      lines.push(`I couldn't look that up: ${res.error}`)
      continue
    }
    if (r.name === 'get_today' || r.name === 'get_upcoming' || r.name === 'search_memory') {
      const items = res.items ?? []
      const label = r.name === 'get_today' ? 'today' : r.name === 'get_upcoming' ? 'coming up' : 'matching that'
      if (!items.length) lines.push(`Nothing ${label}.`)
      else
        lines.push(
          `${items.length === 1 ? 'One thing' : `${items.length} things`} ${label}: ` +
            items.map((i) => `${i.title}${i.due ? ` (${i.due})` : ''}${i.is_suggestion ? ' — suggested' : ''}`).join('; ') +
            '.'
        )
    } else if (r.name === 'get_item' && res.item) {
      const rs = res.reminders ?? []
      lines.push(`"${res.item.title}" is ${res.item.status}${res.item.due ? `, due ${res.item.due}` : ''}${rs.length ? `, reminder ${rs.map((x) => x.fires).join(' and ')}` : ', no reminder'}.`)
      if (res.history?.length) lines.push(`Recently: ${res.history.slice(0, 3).join('; ')}.`)
    } else if (r.name === 'search_activity') {
      const h = res.history ?? []
      lines.push(h.length ? `Here's what happened: ${h.slice(0, 6).join('; ')}.` : 'No history recorded for that yet.')
    }
  }
  return lines.length ? lines.join(' ') : null
}

interface RoundOutcome {
  results: ToolResult[]
  hadWrites: boolean
  /** Set when the write transaction was rolled back. */
  error: string | null
  /** A write tool declined and wants a yes first. Nothing in the round was applied. */
  confirm: { question: string; wouldAffect: string[] } | null
}

/**
 * Execute one round of tool calls. All write calls in the round share one transaction:
 * if any fails to validate or execute, none of them are applied, and the caller is told why.
 * If any write tool asks for confirmation, the whole round is rolled back and the question surfaces.
 * Read calls run outside the transaction and can never change data.
 * Every round is logged to `extractions` (spec invariant 3), applied or not.
 */
class NeedsConfirmation extends Error {
  constructor(readonly confirm: { question: string; wouldAffect: string[] }) {
    super(confirm.question)
  }
}

function runToolRound(calls: ToolCall[], ctx: ExecContext, applied: AppliedChange[]): RoundOutcome {
  const writes = calls.filter((c) => isWriteTool(c.name))
  const reads = calls.filter((c) => !isWriteTool(c.name))
  const results: ToolResult[] = []
  const proposed = JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args })))
  let error: string | null = null
  let confirm: RoundOutcome['confirm'] = null

  if (writes.length) {
    const roundApplied: AppliedChange[] = []
    try {
      const outcomes = inTransaction(() =>
        writes.map((c) => {
          const o = executeTool(c.name, c.args, ctx)
          if (o.confirm) throw new NeedsConfirmation(o.confirm)
          if (o.applied) roundApplied.push(o.applied)
          return { call: c, result: o.result }
        })
      )
      // Transaction committed — only now do these become facts.
      applied.push(...roundApplied)
      for (const o of outcomes) results.push({ callId: o.call.id, name: o.call.name, result: o.result })
      repo.insertExtraction(ctx.sourceMsgId, proposed, true, null)
      log('info', 'tools.applied', roundApplied.map((a) => a.summary).join(' | '))
    } catch (e) {
      if (e instanceof NeedsConfirmation) {
        confirm = e.confirm
        repo.insertExtraction(ctx.sourceMsgId, proposed, false, 'awaiting confirmation')
        log('info', 'tools.confirm', confirm.question)
        for (const c of writes) results.push({ callId: c.id, name: c.name, result: { ok: false, needs_confirmation: true, question: confirm.question } })
      } else {
        error = (e as Error).message
        repo.insertExtraction(ctx.sourceMsgId, proposed, false, error)
        log('warn', 'tools.rejected', error)
        for (const c of writes) results.push({ callId: c.id, name: c.name, result: { ok: false, error: `Not applied. ${error}` } })
      }
    }
  } else {
    repo.insertExtraction(ctx.sourceMsgId, proposed, true, null)
  }

  for (const c of reads) {
    try {
      results.push({ callId: c.id, name: c.name, result: executeTool(c.name, c.args, ctx).result })
    } catch (e) {
      results.push({ callId: c.id, name: c.name, result: { ok: false, error: (e as Error).message } })
    }
  }
  return { results, hadWrites: writes.length > 0, error, confirm }
}

/**
 * Actions that arrive from outside the conversation — toast buttons, manual UI edits — go through the very
 * same validated, transactional tool path (spec hard rule 3). Recorded as a system message in the conversation.
 */
export function applyExternalTools(origin: string, actor: Actor, calls: { name: string; args: Record<string, unknown> }[]): ToolRunResult {
  const applied: AppliedChange[] = []
  const sys = repo.insertMessage('system', `[${origin}] ${calls.map((c) => c.name).join(', ')}`, 0)
  const outcome = runToolRound(
    calls.map((c, i) => ({ id: `local_ext_${i}`, name: c.name, args: c.args })),
    { actor, sourceMsgId: sys.id },
    applied
  )
  const via = origin === 'toast' ? 'From the notification' : 'Edited by hand'
  if (outcome.confirm) {
    // Nothing happened; don't leave a note in the conversation.
    repo.updateMessageContent(sys.id, `${via}: asked for confirmation — ${outcome.confirm.question}`)
  } else {
    repo.updateMessageContent(
      sys.id,
      applied.length ? `${via}: ${joinPhrases(applied)}` : `${via}: ${calls.map((c) => c.name.replace(/_/g, ' ')).join(', ')} — nothing was changed${outcome.error ? ` (${outcome.error})` : ''}`
    )
  }
  return { applied, error: outcome.error, confirm: outcome.confirm }
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

// Re-export for callers that want to describe items the same way the tools do.
export { formatDue }
