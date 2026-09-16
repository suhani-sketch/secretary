import { log } from '../log'
import * as repo from '../repo'
import { assembleContext } from './context'
import { ProviderUnavailableError, type Provider, type ProviderMessage, type ToolCall, type ToolResult } from './provider'
import { REPLY, routeTier0 } from './router'
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
- "I haven't sent it yet" / "not done yet" / "still haven't finished it" → nothing stored. The thing is simply still outstanding; say so. This is NOT a waiting item — waiting items exist only when someone ELSE owes the user a reply or a delivery.
- Call resolve_waiting only when the user says the other party actually replied, got back, or delivered. The user doing their own step ("I sent the email") never resolves a wait.
- When the user mentions an existing Thing, UPDATE that Thing (update_item / record_activity). Never create a second row for the same thing. Nothing is duplicated.

Living activities (happenings) — four different things, keep them apart:
- "I need to do laundry tomorrow" → create_item (a task).
- "I've started the washing machine" / "I've put an egg on for 8 minutes" / "I'm making tea" / "starting a focus session" / "charging my phone" / "I'm showering" → start_happening. A happening is something going on in the real world right now. It is NEVER a task, never an item, never a note, never record_activity. Give minutes only if the user said how long; otherwise it is open-ended.
- "remind me to move the laundry in 45 minutes" → create_reminder / create_item with a reminder (an alarm), not a happening.
- "laundry's done" / "egg's ready" / "I'm out of the shower" / "never mind the egg" → finish_happening on the running happening listed in the context (outcome done, or abandoned for never-mind). Nothing is recorded anywhere else.
- Metaphors are the app's business (egg, tea, laundry, plant, download, focus). Pass metaphor only when obvious; leave it out otherwise and the app shows a plain timer.

Things (projects) — the life model:
- When the user names something they are dealing with that has, or will have, parts ("TISS mailing is something I need to deal with", "my IIM application", "the wedding"), call create_project with the name they used. The context lists every project you already track with its id: if the Thing is there, DO NOT create it again — use its id.
- A task that belongs to a Thing gets project_id (or project_title if the Thing is not in the context yet). "I need to email TISS about the mailing" → create_item with project_id of the TISS mailing.
- Progress on a Thing ("I worked on the TISS mailing today", "I drafted the first email") → record_activity with item_id = the project. Never a task named after the sentence.
- Changing a Thing's date or details → update_item on the project id. "That belongs to X" → attach_to_project.
- If create_project answers with a near-match question, relay it; "yes" → call again with use_existing_id, "no, it's different" → force_new=true.
- Waiting: "they said they'll get back to me Friday" / "I emailed X and haven't heard back" → create_waiting (waiting_on = who, about = what, expected_date_local if they named a day; project_id when it belongs to a Thing in focus). Never a task. "They replied" / "heard back from X" / "the transcript arrived" → resolve_waiting.
- Conditional follow-up: "if they haven't replied by Friday afternoon, remind me" → create_reminder on the waiting item with unless_resolved = that waiting item's id and fire_at_local = Friday 14:00 (afternoon → 14:00, morning → 09:00, evening → 18:00 when only a part of day is given). The app decides at fire time whether they replied; you never judge that.
- Availability: "I'm busy tomorrow afternoon" / "travelling Friday" / "class every Tuesday 2–5" / "no mornings" → add_constraint (unavailable for busy/travel/class; avoid for "no mornings"; prefer for "mornings are best"). Afternoon = 12:00–18:00, morning = 08:00–12:00, evening = 18:00–22:00. "I'm free after all" → remove_constraint. When you book an exact time the app itself checks constraints and events: if it answers with a clash question, relay it; if the user says book it anyway, call again with override_conflicts=true. Use check_conflicts before suggesting a time.
- Dependencies: "I can't do Y until X is done" / "Y depends on X" / "X first, then Y" → add_link from_id=X to_id=Y type blocks. Never set status=blocked yourself — the app computes "BLOCKED by …" from the links and shows it in the context.
- Notes: information that is not an obligation. "Add a note to the application that the transcript must be a PDF" → add_note with item_title "application" (the app matches the Thing). "Remember that the TISS contact is Priya" → add_note on the TISS project. "I'll be travelling Friday" / "I'm off on the 20th" → add_note with date_local — it informs planning; it is never a task and never journaling. Do not turn feelings ("I'm exhausted") into notes.
- Checklists: steps within a Thing are checklist items, not tasks. "Add a list of things to do" → just say you're ready for the steps (no tool). "Add send first email, follow up and attach the document" → add_checklist_item with three titles on that project. "I sent the first email" → complete_checklist_item (by title; the app matches it to the step) — never a new task. "What is left?" → get_project. Only promote_checklist_item when the user wants a step scheduled as its own task.

Reference resolution:
- "it", "that", "the earlier one" usually mean the most recently touched item listed in the context. When the user gives a new time for something just created ("actually make it 4"), update THAT item — never create a second one. Its reminder moves with it automatically.

Times — be honest about precision:
- The context tells you today's date and time. Resolve relative phrases yourself.
- If the user stated a clock time ("Thursday at 3", "tomorrow at 9", "in two hours"), use the *_at_local field ("YYYY-MM-DDTHH:MM"). A bare number for an appointment means the afternoon/business hour (3 → 15:00) unless context says otherwise.
- If the user gave only a day ("tomorrow", "Friday", "tom", "next week"), use the *_date_local field ("YYYY-MM-DD"). NEVER invent a clock time. "Next week" → the Monday with due_looseness "week". "Sometime"/"at some point" → due_looseness "vague".
- A day of the month without a year ("on the 25th", "March 3") means the NEXT such date — never one in the past. Take the year from today's date in the context and roll forward if that date has already gone by.
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
    if (t0 && t0.length === 1 && t0[0].name === REPLY) {
      // Deterministic words, nothing to write.
      tier = 0
      replyText = String(t0[0].args.text ?? '')
      repo.insertExtraction(userMessage.id, JSON.stringify([{ name: REPLY }]), true, null)
      log('info', 'router.tier0', `reply in ${Date.now() - started}ms`)
    } else if (t0) {
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
          : applied.length
            ? joinPhrases(applied)
            : (phraseReadResults(outcome.results) ?? "I looked, but couldn't put that into words — could you ask again?")
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
      const found = (res as { notes?: { on: string; body: string }[] }).notes ?? []
      const label = r.name === 'get_today' ? 'today' : r.name === 'get_upcoming' ? 'coming up' : 'matching that'
      if (!items.length && !found.length) lines.push(`Nothing ${label}.`)
      else if (items.length)
        lines.push(
          `${items.length === 1 ? 'One thing' : `${items.length} things`} ${label}: ` +
            items.map((i) => `${i.title}${i.due ? ` (${i.due})` : ''}${i.is_suggestion ? ' — suggested' : ''}`).join('; ') +
            '.'
        )
      if (found.length) lines.push(`Notes: ${found.map((n) => `${n.body}${n.on !== 'item' ? ` (${n.on})` : ''}`).join(' · ')}.`)
    } else if (r.name === 'get_item' && res.item) {
      const rs = res.reminders ?? []
      const notes = (res as { notes?: { body: string }[] }).notes ?? []
      lines.push(`"${res.item.title}" is ${res.item.status}${res.item.due ? `, due ${res.item.due}` : ''}${rs.length ? `, reminder ${rs.map((x) => x.fires).join(' and ')}` : ', no reminder'}.`)
      if (notes.length) lines.push(`Notes: ${notes.map((n) => n.body).join(' · ')}.`)
      if (res.history?.length) lines.push(`Recently: ${res.history.slice(0, 3).join('; ')}.`)
    } else if (r.name === 'get_project') {
      const p = (res as { project?: { title: string; due: string | null; status: string }; parts?: { title: string; status: string; due: string | null }[]; history?: string[] }).project
      const parts = (res as { parts?: { title: string; status: string; due: string | null }[] }).parts ?? []
      const hist = (res as { history?: string[] }).history ?? []
      if (p) {
        type Part = { title: string; status: string; due: string | null; kind?: string; waiting_on?: string | null }
        const all = parts as Part[]
        const waiting = all.filter((x) => x.kind === 'waiting' && !['done', 'cancelled', 'archived'].includes(x.status))
        const open = all.filter((x) => x.kind !== 'waiting' && !['done', 'cancelled', 'archived'].includes(x.status))
        const done = all.filter((x) => x.status === 'done')
        lines.push(
          `"${p.title}"${p.due ? ` is due ${p.due}` : ''}: ` +
            (all.length
              ? (open.length ? `still to do — ${open.map((x) => x.title).join(', ')}` : 'nothing left to do') +
                (waiting.length ? `. Waiting on ${waiting.map((x) => `${x.waiting_on ?? 'someone'}${x.due ? ` (expected ${x.due})` : ''}`).join(', ')}` : '') +
                (done.length ? `. Done: ${done.map((x) => x.title).join(', ')}` : '')
              : 'no parts yet') +
            '.'
        )
        const pnotes = (res as { notes?: { body: string }[] }).notes ?? []
        if (pnotes.length) lines.push(`Notes: ${pnotes.map((n) => n.body).join(' · ')}.`)
        const doneSoFar = (res as { done?: string[] }).done ?? []
        if (doneSoFar.length) lines.push(`Done so far: ${doneSoFar.slice(0, 8).join('; ')}.`)
        const rest = hist.filter((h) => !/· \w+: (?:Drafted|Ticked off|Recorded|Sent|Finished|Completed)/.test(h) && !doneSoFar.some((d) => h.includes(d.replace(/ \(\d{4}-\d\d-\d\d\)$/, ''))))
        if (rest.length) lines.push(`Also: ${rest.slice(0, 4).map((h) => h.replace(/^.*?· \w+: /, '')).join('; ')}.`)
      }
    } else if (r.name === 'check_conflicts') {
      const c = res as unknown as { window: string; conflicts: { kind: string; text: string }[]; clear: boolean; next_free_from: string | null }
      if (!c.conflicts.length) lines.push(`${c.window} is clear.`)
      else lines.push(`${c.window} clashes with ${c.conflicts.map((x) => x.text).join(' and ')}.${c.clear ? ' Nothing hard, so it can still be booked.' : c.next_free_from ? ` Free from ${c.next_free_from}.` : ''}`)
    } else if (r.name === 'search_activity') {
      const h = res.history ?? []
      // Entries arrive newest first as "yyyy-mm-dd hh:mm · actor: summary"; tell it oldest first, by day, without the plumbing.
      const tidy = [...h]
        .reverse()
        .slice(-8)
        .map((e) => {
          const m = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} · \w+: (.*)$/.exec(e)
          if (!m) return e
          const day = new Date(m[1] + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
          return `${day}: ${m[2]}`
        })
      lines.push(tidy.length ? `Here's what happened, oldest first. ${tidy.join('. ')}.` : 'No history recorded for that yet.')
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
