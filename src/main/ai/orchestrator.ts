import { DateTime } from 'luxon'
import { log } from '../log'
import * as repo from '../repo'
import { assembleContext, getOffer, setOffer } from './context'
import { ProviderUnavailableError, type Provider, type ProviderMessage, type ToolCall, type ToolResult } from './provider'
import { REPLY, looksLikeDump, routeTier0 } from './router'
import { executeTool, inTransaction, isWriteTool, toolDefinitions, type ExecContext } from './tools'
import { formatDue } from '../../shared/format'
import { personalityLine } from '../personality'
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
- Timer offers are the app's business too: it offers once ("Want a 5-minute steep timer?") and the user's yes/no is handled for you (time_happening / decline_ritual). Never offer a timer yourself, never nag, and never add cheerful commentary — the app adds the occasional observation itself.
- INVARIANT: saying what you are doing is not a request. "I'm making dinner", "I'm making tea", "cooking lunch" with no duration and no "remind me" → call NO tool at all; reply in a sentence like a person would. Only a stated duration ("for 8 minutes"), a thing with its own clock (a wash, a charge, a download, a focus session, a shower) or an explicit "remind me" creates anything.

Context and commitments (5d) — the last two things to keep apart:
- CONTEXT: "I'm exhausted today", "feeling low", "I'm at TISS until 5", "I'm free this evening" → note_context. It shapes what you recommend today and disappears tonight. NEVER a task, note, activity or preference. A durable pattern stated as such ("I work better on analytical writing in the afternoon", "no mornings") IS a preference → set_preference / add_constraint.
- COMMITMENT: an obligation with another person's expectation attached. "I should email Professor X" → a task (intention). "I told Professor X I'd email him tonight" / "I promised Priya the draft by Friday" → create_item kind=commitment, committed_to = the person, title = what was promised, due from their words. Commitments come first in "what am I forgetting?" and are shown with who they were made to. Never invent a person.

Brain dumps (7a) — one messy message, everything handled in this ONE response:
- Split the message into its clauses and deal with EVERY clause with the right tool, all in this single response: an obligation → create_item; a deadline → create_item kind=deadline (hardness hard if they said so); "remind me …" → the item's remind_* fields or create_reminder; a promise to someone → create_item kind=commitment with committed_to; "note:" / a fact to keep → add_note; how they feel or where they are → note_context; something they did → record_activity, or complete_checklist_item / complete_item when it is a listed step or item; "haven't heard back" / "waiting for X" → create_waiting (or record_activity.now_waiting_on); "can't do Y until X" → add_link (from = X, to = Y). Neither X nor Y needs to exist yet or be created first — NEVER invent an id or call create_item/create_waiting just to get one to link: pass from_title/to_title (their plain words) for whichever side is not already a known item/wait in the context, and the app resolves or creates it for you, in this same call. Use from_id/to_id only for a side that is already in the context; a clause about a Thing in the context → update that Thing, or pass project_id so the new item belongs to it.
- RESOLVE BEFORE CREATING (invariant 11): if a clause names something already in the context — an item, a step, a project, a wait — act on THAT row by its id (update, complete, attach). Never create a near-duplicate. The app merges same-named items as a backstop; do not lean on it.
- At most ONE clarifying question per message, through ask_clarification, and only where the ambiguity would change an action (which of two Things it belongs to; a date that cannot be read for something that plainly needs one). Never ask about wording, priority or detail. Never ask INSTEAD of acting: do every clear part in the same response and ask about the one unclear part.
- Ambiguous but harmless → pick the plain reading and act. Ambiguous and consequential → the one question.
- Time estimates: keep the user's figure as theirs; never invent one and present it as what they said.

"What should I do right now / next / first?" (7c) → recommend_now. The app ranks every open thing (urgency, importance, hardness, overdue, blockers, free time before the next fixed thing, effort, today's context, promises, whether it can start this minute) and names ONE action with its reason — or says nothing can start and why. Relay its text. Never answer this from memory and never produce a list of your own.

"What am I forgetting?" (7d) → get_forgetting. The app separates DEFINITE (promises, overdue, waiting, due soon with no time set aside, plans falling behind, at-risk deadlines) from POSSIBLE (ideas, unconfirmed suggestions) in its own text — relay it exactly as given, keep the two apart, and never turn a "possible" item into a task yourself.

Smart scheduling (7e) — "I need two hours for the case study before Friday", "find time to write the draft by tomorrow" → propose_slot. The app searches the real calendar and grades what it found feasible, tight, or infeasible; it books NOTHING by itself. Relay its text. If the user then says to book it, call create_event with exactly the time and title it proposed — never a time of your own choosing. If the last proposal was infeasible or the deadline had passed, "book it" is handled for you deterministically (it refuses); do not call create_event yourself in that case, and never add override_conflicts to force something the app just said cannot fit — that is scheduling something that cannot happen, which this phase exists to prevent.

Replanning (7f) — "replan the study sessions", "catch up the plan", or after a session was just marked missed / a new unavailability now clashes with one: call replan_sessions. The app computes remaining workload against remaining capacity and previews EXACTLY what would be cleared and what would replace it, graded, never proposing a slot that clashes with something already on the calendar — then it asks. It is handled for you deterministically after that: a plain yes replays it with confirmed=true, a no changes nothing. Never call replan_sessions with confirmed=true yourself on the first mention — the preview always comes first, and nothing on the plan's own sessions moves without the user having seen it and said yes. Only this plan's own future sessions ever move; every other commitment on the calendar is untouched (invariant 10).

Conversational planning (7g) — ONE evolving proposal across turns, never a new plan on every message:
- "Plan my week" / "help me plan my week" → plan_week. Starts a FRESH proposal from this week's unplaced obligations, computed and graded by the app; relay its text. Books nothing.
- While that proposal is open, each further instruction REFINES the SAME proposal via refine_week_plan — never plan_week again (that would throw the proposal away and start over, which is exactly what this phase says not to do). "Nothing Tuesday" / "keep Saturday free" → exclude_day_local. "I have a presentation Thursday" (with or without a time) → add_fixed_title/add_fixed_date_local/add_fixed_at_local. Each refinement RECOMPUTES the whole proposal and shows the new consequences — relay that text plainly; do not summarise it yourself or claim anything is booked.
- Only once the user has clearly approved what was just shown ("okay, do it", "go ahead", "book it") → commit_week_plan. It books exactly what was last shown, nothing more, nothing the user has not seen. If they abandon it instead ("never mind", "scrap that", "start over") → discard_week_plan, then a later "plan my week" starts clean.
- Never call commit_week_plan on the same message as plan_week or a refinement — the user must see the proposal before approving it, even when they seem to want everything done at once ("plan my week and just do it") — show the proposal in your reply first; only the FOLLOWING message, once they confirm, commits.

Deadlines (7b) — computed, never weighed by you:
- "Is X on track?", "what's the bottleneck?", "can I still make Friday?", "how is X looking?" → assess_deadline (or get_project for a dated Thing). The app reasons back from the deadline over the user's OWN parts and blocks links: what remains, what is blocked by what, the bottleneck, whether it is still feasible given the free time left. Relay its text; do not re-rank or second-guess it.
- Never invent a component. If the parts listed seem incomplete, the app already says "that is everything you have listed — tell me if there are more parts"; do not add steps the user never mentioned.
- Effort: when the user gives a figure ("the report is about three hours") pass effort_minutes on the item. Never make one up as theirs — the app labels its own assumptions as assumed.

Things (projects) — the life model:
- When the user names something they are dealing with that has, or will have, parts ("TISS mailing is something I need to deal with", "my IIM application", "the wedding"), call create_project with the name they used. The context lists every project you already track with its id: if the Thing is there, DO NOT create it again — use its id.
- A task that belongs to a Thing gets project_id (or project_title if the Thing is not in the context yet). "I need to email TISS about the mailing" → create_item with project_id of the TISS mailing.
- Progress on a Thing ("I worked on the TISS mailing today", "I drafted the first email") → record_activity with item_id = the project. Never a task named after the sentence.
- Changing a Thing's date or details → update_item on the project id. "That belongs to X" → attach_to_project.
- If create_project answers with a near-match question, relay it; "yes" → call again with use_existing_id, "no, it's different" → force_new=true.
- Waiting: "they said they'll get back to me Friday" / "I emailed X and haven't heard back" → create_waiting (waiting_on = who, about = what, expected_date_local if they named a day; project_id when it belongs to a Thing in focus). Never a task. "They replied" / "heard back from X" / "the transcript arrived" → resolve_waiting.
- Conditional follow-up: "if they haven't replied by Friday afternoon, remind me" → create_reminder on the waiting item with unless_resolved = that waiting item's id and fire_at_local = Friday 14:00 (afternoon → 14:00, morning → 09:00, evening → 18:00 when only a part of day is given). The app decides at fire time whether they replied; you never judge that.
- Availability: "I'm busy tomorrow afternoon" / "travelling Friday" / "class every Tuesday 2–5" / "no mornings" → add_constraint (unavailable for busy/travel/class; avoid for "no mornings"; prefer for "mornings are best"). Afternoon = 12:00–18:00, morning = 08:00–12:00, evening = 18:00–22:00. "I'm free after all" → remove_constraint. When you book an exact time the app itself checks constraints and events: if it answers with a clash question, relay it; if the user says book it anyway, call again with override_conflicts=true. Use check_conflicts before suggesting a time.
- Dependencies: "I can't do Y until X is done" / "Y depends on X" / "X first, then Y" → add_link from=X to=Y type blocks. X and Y are very often mentioned for the first time right here — use from_title/to_title (their plain words) for whichever one is not already a known item/wait; NEVER invent an id or call create_item/create_waiting first just to get one — the app resolves or creates it for you in this same call. Never set status=blocked yourself — the app computes "BLOCKED by …" from the links and shows it in the context.
- Notes: information that is not an obligation. "Add a note to the application that the transcript must be a PDF" → add_note with item_title "application" (the app matches the Thing). "Remember that the TISS contact is Priya" → add_note on the TISS project. "I'll be travelling Friday" / "I'm off on the 20th" → add_note with date_local — it informs planning; it is never a task and never journaling. Do not turn feelings ("I'm exhausted") into notes.
- Checklists: steps within a Thing are checklist items, not tasks. "Add a list of things to do" → just say you're ready for the steps (no tool). "Add send first email, follow up and attach the document" → add_checklist_item with three titles on that project. "I sent the first email" → complete_checklist_item (by title; the app matches it to the step) — never a new task. "What is left?" → get_project. Only promote_checklist_item when the user wants a step scheduled as its own task.

Calendar (Phase 6) — events occupy time; tasks do not:
- "Meeting with Professor X Thursday at 3" / "dentist Friday 10:30" / "class every Tuesday 2–4" → create_event (kind commitment when other people are involved, work_block when it is the user's own working time). A task due Thursday is create_item, never an event, and it never occupies schedule time.
- "Move it to 4" after an event → update_event on that event. "Cancel the meeting" → delete_event. For one occurrence of a recurring series pass occurrence_start_local — the series itself is never rewritten.
- "What am I doing Thursday?" → get_day. "What have I got this week?" → get_calendar. The app phrases both.
- INVARIANT 10: never move an existing event to make room for something new. If a new booking clashes, the app refuses with an alternative; relay it. Only the user can say "book it anyway".
- Conflict LEVELS: the app grades a slot as clear, tight (fits, no breathing room), poor fit (violates a stated buffer or an avoid window) or hard (overlap). Hard is refused; tight and poor are BOOKED and named in the confirmation. When the user asks to book something, call create_event directly — the app does the grading and says "tight fit" / "poor fit" itself. Use check_conflicts only when the user asks whether a time works or you are proposing one.
- Buffers: "thirty minutes to get home from TISS", "nothing straight after class", "15 minutes before meetings" → add_buffer {minutes, side, scope}. Never a task, never a constraint window.

Plans (6f) — multi-day intentions that generate sessions:
- "Study econometrics two hours every Monday, Wednesday and Friday until October 15" → create_plan {title "Study econometrics", rrule FREQ=WEEKLY;BYDAY=MO,WE,FR, session_minutes 120, ends_on 2026-10-15, clock_local only if stated, target_hours only if stated}. ONE plan; the app creates the sessions on the calendar. Never create_event for each session, never a task.
- "Did my econometrics session" / "skip today's study session" → mark_session on the session listed in the context (done / missed). "How is the econometrics plan going?" → get_plan; the app phrases hours done against target — never a streak or a score.
- Moving one session is update_event on that session (it is an ordinary event); the plan is untouched. replan_sessions only when the user asks to re-lay the sessions ahead; nothing else on the calendar moves.

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
- "Cancel the reminder" → cancel_reminder only; the item stays. "I'm not doing X" → cancel_item for that one item only. cancel_item on a project, delete_event on a repeating series, or delete_item ever returns a confirmation question — relay it; when the user then says yes, call again with confirmed=true. If they decline ("no", "keep it", "leave it"), call NOTHING and say nothing changed — never reinterpret a "no" as a different, smaller change.
- "Undo" / "undo that" → undo_last.

Adaptive intensity and quiet hours (8d) — how insistently the app interrupts, never what it tracks:
- "Be less pushy about reminders" / "ease up on notifications" / "stop nagging me" → set_notification_intensity level=low. "Back to normal" / "you can be pushy again" → level=normal. Low intensity means toasts stop demanding acknowledgement, a deadline alert only fires when something genuinely will not fit (not merely tight), and the daily follow-up names fewer things at once — the app already computes all of this itself; you are only ever setting the preference, never deciding case by case.
- "Don't disturb me after 10" / "quiet hours from 10pm to 8am" / "no notifications before 9" → set_quiet_hours with whichever of start_local/end_local was stated (24-hour "HH:MM"; infer am/pm from context the way you would for any other time — evening for a DND *start*, morning for a DND *end*, when the user gave a bare number). "Turn off quiet hours" / "notify me anytime" → set_quiet_hours clear=true. Quiet hours only hold TOASTS (reminders, deadline alerts) until the window ends — they never affect the morning briefing or the daily follow-up, which only ever appear when the user opens the app themselves, so there is nothing to be "quiet" about there.

Importance is inferred, never asked: read it from their wording and deadline pressure. If they override ("that's not actually important"), update importance.

Suggestions: anything you propose that the user did not state gets is_suggestion=true, and you phrase it as an offer, not a fact.

When you reply in words (no tool call): one or two short sentences, no bullet lists unless listing several items. Never mention tools, ids or JSON.`

/** Appended only for a spoken turn (7a voice). The audio IS the message; note_transcript is how you report what was
 *  said, since free text alongside tool calls is unreliable — this turn, a tool call is the only dependable channel. */
const VOICE_ADDENDUM = `

Voice — this turn's message is SPOKEN, attached as audio, not typed:
- Call note_transcript EXACTLY ONCE, FIRST, with the verbatim words spoken (cleaned of "um"/false starts is fine; do not paraphrase or summarise). This is mandatory every single turn, even when nothing else is actionable.
- Then apply the Brain dumps (7a) rules exactly as you would to the same words typed: extract every obligation, deadline, reminder, commitment, note, context, status update, waiting state, dependency and project association; resolve against existing entities before creating anything; at most one clarifying question.
- If the recording is unclear, silent, or not really speech, call note_transcript with your best honest guess at what you heard (or an empty string if truly nothing), and create nothing you are not confident of.`

const NOTE_TRANSCRIPT_TOOL = {
  name: 'note_transcript',
  description: 'Voice only, mandatory, call first: the verbatim transcript of what the user said this turn.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

/**
 * 7g guard, enforced in code rather than trusted to the prompt: a proposal must be SEEN (returned as text) before it
 * can be approved, so committing it can never happen in the same round that just generated or changed it — the model
 * cannot approve on the user's behalf within its own turn. If both appear together, the commit is dropped and logged;
 * the proposal still goes out, and the user gets a real chance to say yes before anything is booked.
 */
function stripPrematureWeekPlanCommit(calls: ToolCall[]): ToolCall[] {
  const sawProposal = calls.some((c) => c.name === 'plan_week' || c.name === 'refine_week_plan')
  if (!sawProposal) return calls
  const out = calls.filter((c) => c.name !== 'commit_week_plan')
  if (out.length !== calls.length) log('warn', 'ai.weekplan_premature_commit', 'dropped a commit_week_plan called in the same round as the proposal it would be approving')
  return out
}

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

/** Voice (7a spoken): same queue as typed chat, so a recording never lands mid-transaction with a typed message. */
export function enqueueVoice(deps: OrchestratorDeps, audio: { base64: string; mimeType: string }): Promise<ChatResponse> {
  const run = queue.then(() => handleVoice(deps, audio))
  queue = run.catch(() => undefined)
  return run
}

/** One or two changes read as a sentence; a brain dump's worth reads as a list, one line per thing (7a). */
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

const joinPhrases = (applied: AppliedChange[]): string =>
  applied.length >= 3 ? `Got it — ${applied.length} things:\n${applied.map((a) => `• ${a.phrase}`).join('\n')}` : applied.map((a) => a.phrase).join(' ')

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

      // A brain dump (7a) is the one place the lite model reliably falls short; start one model up the chain. Still one call.
      const dump = looksLikeDump(text)
      const res = await deps.provider.complete({ system: SYSTEM_PROMPT, messages, tools: toolDefinitions(), turnId: userMessage.id, preferStrong: dump }, (s) =>
        deps.onStatus({ kind: 'throttled', retryInSeconds: s })
      )
      modelCalls++
      log(
        'info',
        'ai.response',
        `call ${modelCalls} (${res.model ?? '?'}${dump ? ', dump' : ''}): ${res.toolCalls.length} tool call(s)${res.text ? ', text' : ''}; tokens in=${res.usage?.input ?? '?'} out=${res.usage?.output ?? '?'}`
      )

      // 7a: at most ONE clarifying question per message. It rides alongside the actions in the same response; the
      // clear parts are applied, the question is appended. Extra questions are dropped (and logged), never asked.
      const asks = res.toolCalls.filter((c) => c.name === 'ask_clarification')
      const calls = stripPrematureWeekPlanCommit(res.toolCalls.filter((c) => c.name !== 'ask_clarification'))
      const question = asks.length ? String((asks[0].args as { question?: string }).question ?? '').trim() : ''
      if (asks.length) repo.insertExtraction(userMessage.id, JSON.stringify(asks.map((c) => ({ name: c.name, args: c.args }))), true, asks.length > 1 ? `${asks.length - 1} extra question(s) dropped — one per message` : null)
      if (asks.length > 1) log('warn', 'ai.clarify_capped', `${asks.length} clarifying questions proposed; asked the first only`)

      if (calls.length === 0) {
        replyText = question || res.text || "I'm not sure what you'd like me to do with that — could you say a bit more?"
      } else {
        deps.onStatus({ kind: 'tools', count: calls.length })
        const outcome = runToolRound(calls, { actor: 'assistant', sourceMsgId: userMessage.id }, applied)
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
        if (question && !outcome.confirm) replyText += `\n\nOne question: ${question}`
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
  // Personality, rationed (spec Phase 5): at most one quiet line, only after a clean change, never when things are hard.
  if (!error && applied.length) {
    try {
      const line = personalityLine(applied, text)
      if (line) {
        // A trailing question (a timer offer, "Want a reminder?") stays last; the observation slips in before it.
        const q = /^(.*?[.!])\s+([^.!?]*\?)$/.exec(replyText!.trim())
        replyText = q ? `${q[1]} ${line} ${q[2]}` : `${replyText} ${line}`
        log('info', 'personality.line', line)
      }
    } catch (e) {
      log('warn', 'personality.failed', (e as Error).message)
    }
  }
  const assistantMessage = repo.insertMessage('assistant', replyText!, tier)
  deps.onChanged()
  return { userMessage, assistantMessage, applied, error }
}

/**
 * Voice (spec §8 Phase 7, "Voice"): the recording goes to Gemini directly, through the exact same provider and tool
 * schema as a typed brain dump — one model call, the same extraction rules, never a second subsystem. There is no
 * tier 0 (nothing to pattern-match before the audio is heard) and no typed text to store up front, so the user message
 * row is a placeholder until the transcript comes back from `note_transcript` (see VOICE_ADDENDUM) — a dedicated,
 * mandatory tool call, not free text, because free text is unreliably present alongside tool calls in the same turn
 * (verified: gemini-3.6-flash regularly omits it) while a required tool call is not.
 */
async function handleVoice(deps: OrchestratorDeps, audio: { base64: string; mimeType: string }): Promise<ChatResponse> {
  const userMessage = repo.insertMessage('user', '🎙️ …', null)
  const applied: AppliedChange[] = []
  let error: string | null = null
  let replyText: string | null = null
  let transcript = ''
  let modelCalls = 0
  const started = Date.now()

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
    // No typed words to search on yet — the rest of the context (Things, calendar, commitments…) is still assembled in full.
    messages.push({ role: 'user', text: `Context:\n${assembleContext('')}\n\nThe user's message this turn is spoken. See the Voice section above.`, audio })

    // Audio understanding + extraction is inherently a hard task — always start on the stronger model, same one call.
    const res = await deps.provider.complete(
      { system: SYSTEM_PROMPT + VOICE_ADDENDUM, messages, tools: [...toolDefinitions(), NOTE_TRANSCRIPT_TOOL], turnId: userMessage.id, preferStrong: true },
      (s) => deps.onStatus({ kind: 'throttled', retryInSeconds: s })
    )
    modelCalls++

    const transcriptCalls = res.toolCalls.filter((c) => c.name === 'note_transcript')
    transcript = String((transcriptCalls[0]?.args as { text?: string } | undefined)?.text ?? '').trim()
    // Mutate the in-memory row too — this same object is what's returned to the renderer at the end; without this
    // the chat bubble would show the "🎙️ …" placeholder forever even though the database has the real transcript.
    userMessage.content = transcript ? `🎙️ ${transcript}` : '🎙️ (nothing heard)'
    repo.updateMessageContent(userMessage.id, userMessage.content)
    const asks = res.toolCalls.filter((c) => c.name === 'ask_clarification')
    const calls = stripPrematureWeekPlanCommit(res.toolCalls.filter((c) => c.name !== 'note_transcript' && c.name !== 'ask_clarification'))
    const question = asks.length ? String((asks[0].args as { question?: string }).question ?? '').trim() : ''
    log(
      'info',
      'ai.response',
      `call ${modelCalls} (${res.model ?? '?'}, voice): ${res.toolCalls.length} tool call(s), transcript ${transcript ? `${transcript.length} chars` : 'EMPTY'}; tokens in=${res.usage?.input ?? '?'} out=${res.usage?.output ?? '?'}`
    )
    if (asks.length) repo.insertExtraction(userMessage.id, JSON.stringify(asks.map((c) => ({ name: c.name, args: c.args }))), true, asks.length > 1 ? `${asks.length - 1} extra question(s) dropped — one per message` : null)
    if (asks.length > 1) log('warn', 'ai.clarify_capped', `${asks.length} clarifying questions proposed; asked the first only`)
    if (!transcript) log('warn', 'ai.voice_no_transcript', 'note_transcript was not called or returned empty text')

    if (calls.length === 0) {
      replyText = question || (transcript ? "Got it — I heard that, but there's nothing there for me to track." : "I couldn't make out anything in that recording — could you try again, a little closer to the mic?")
    } else {
      deps.onStatus({ kind: 'tools', count: calls.length })
      const outcome = runToolRound(calls, { actor: 'assistant', sourceMsgId: userMessage.id }, applied)
      deps.onChanged()
      if (outcome.confirm) {
        replyText = (applied.length ? joinPhrases(applied) + ' ' : '') + outcome.confirm.question
      } else if (outcome.hadWrites) {
        replyText = outcome.error
          ? applied.length
            ? `${joinPhrases(applied)} But I couldn't do the rest: ${outcome.error}.`
            : `I couldn't do that: ${outcome.error}. Nothing was changed.`
          : joinPhrases(applied)
      } else {
        replyText = phraseReadResults(outcome.results) ?? "I heard that, but couldn't put an answer into words — could you ask again?"
      }
      if (question && !outcome.confirm) replyText += `\n\nOne question: ${question}`
    }
  } catch (e) {
    const err = e as Error
    error = err.message
    log('error', 'ai.failed', err.stack ?? err.message)
    if (!transcript) {
      userMessage.content = '🎙️ (voice message — something went wrong)'
      repo.updateMessageContent(userMessage.id, userMessage.content)
    }
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
    log('error', 'ai.call_budget_exceeded', `${modelCalls} calls for one voice message (budget ${MAX_MODEL_CALLS_PER_MESSAGE})`)
  }
  log('info', 'chat.done', `tier voice, ${modelCalls} model call(s), ${applied.length} change(s), ${Date.now() - started}ms`)
  if (!error && applied.length) {
    try {
      const line = personalityLine(applied, transcript)
      if (line) {
        const q = /^(.*?[.!])\s+([^.!?]*\?)$/.exec(replyText!.trim())
        replyText = q ? `${q[1]} ${line} ${q[2]}` : `${replyText} ${line}`
        log('info', 'personality.line', line)
      }
    } catch (e) {
      log('warn', 'personality.failed', (e as Error).message)
    }
  }
  const assistantMessage = repo.insertMessage('assistant', replyText!, 2)
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
      const assessmentText = (res as { assessment_text?: string }).assessment_text
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
        // 7b: the computed deadline picture — bottleneck and feasibility — without being asked which part matters.
        if (assessmentText) lines.push(assessmentText)
        const pnotes = (res as { notes?: { body: string }[] }).notes ?? []
        if (pnotes.length) lines.push(`Notes: ${pnotes.map((n) => n.body).join(' · ')}.`)
        const doneSoFar = (res as { done?: string[] }).done ?? []
        if (doneSoFar.length) lines.push(`Done so far: ${doneSoFar.slice(0, 8).join('; ')}.`)
        const rest = hist.filter((h) => !/· \w+: (?:Drafted|Ticked off|Recorded|Sent|Finished|Completed)/.test(h) && !doneSoFar.some((d) => h.includes(d.replace(/ \(\d{4}-\d\d-\d\d\)$/, ''))))
        if (rest.length) lines.push(`Also: ${rest.slice(0, 4).map((h) => h.replace(/^.*?· \w+: /, '')).join('; ')}.`)
      }
    } else if (r.name === 'get_day') {
      type D = { date: string; is_past: boolean; status: string | null; priorities: { title: string; why: string }[]; due: { title: string }[]; overdue: { title: string; was_due: string | null }[]; schedule: { title: string; when: string }[]; reminders: { for: string; at: string; state: string }[]; waiting: { who: string | null; about: string | null }[]; notes: string[]; completed: string[]; history?: string[] }
      const d = res as unknown as D
      const day = DateTime.fromISO(d.date).toFormat('cccc d LLL')
      const bits: string[] = []
      // A work block that serves an obligation is ONE thing: it appears once, in the schedule, annotated — not again under a
      // separate "time set aside" sentence.
      const dws = (res as unknown as { due_with_time_set_aside?: { title: string; item: string; when: string }[] }).due_with_time_set_aside ?? []
      const served = new Map(dws.map((x) => [x.title, x.item]))
      const annotate = (s: { title: string; when: string }): string => {
        const item = served.get(s.title)
        if (item === undefined) return `${s.title} ${s.when}`
        return `${s.title} ${s.when} (time set aside${item !== s.title ? ` for "${item}"` : ''})`
      }
      if (d.schedule.length) bits.push(`${d.is_past ? 'Scheduled' : 'Schedule'}: ${d.schedule.map(annotate).join('; ')}.`)
      else bits.push(d.is_past ? 'Nothing was scheduled.' : 'Nothing scheduled.')
      if (d.due.length) bits.push(`Due that day: ${d.due.map((x) => x.title).join(', ')}.`)
      if (d.overdue.length) bits.push(`Still open from earlier: ${d.overdue.map((x) => `${x.title}${x.was_due ? ` (was ${x.was_due})` : ''}`).join(', ')}.`)
      if (d.priorities.length) bits.push(`What matters most: ${d.priorities.map((p) => `${p.title} — ${p.why}`).join('; ')}.`)
      if (d.reminders.length) bits.push(`Reminders: ${d.reminders.map((x) => `${x.for} at ${x.at}${d.is_past && x.state !== 'pending' ? ` (${x.state})` : ''}`).join(', ')}.`)
      if (d.waiting.length) bits.push(`Still waiting on ${d.waiting.map((w) => w.who ?? 'someone').join(', ')}.`)
      if (d.notes.length) bits.push(`Notes: ${d.notes.join(' · ')}.`)
      if (d.completed.length) bits.push(`Done: ${d.completed.join(', ')}.`)
      if (d.history?.length) bits.push(`That day: ${d.history.slice(0, 6).join('; ')}.`)
      lines.push(d.is_past ? `${day}, looking back. ${bits.join(' ')}` : `${day} looks ${d.status ?? 'quiet'}. ${bits.join(' ')}`)
    } else if (r.name === 'get_calendar') {
      const c = res as unknown as { from: string; to: string; events: { title: string; when: string; end: string | null; recurring: boolean }[] }
      lines.push(c.events.length ? `On the calendar: ${c.events.map((e) => `${e.title} ${e.when}${e.end ? `–${e.end}` : ''}${e.recurring ? ' ↻' : ''}`).join('; ')}.` : `Nothing on the calendar between ${c.from} and ${c.to}.`)
    } else if (r.name === 'get_forgetting') {
      type F = {
        commitments: { title: string; to: string | null; due: string | null; overdue: boolean }[]
        overdue: { title: string; kind: string; due: string }[]
        waiting: { who: string | null; about: string | null; expected: string | null; overdue: boolean }[]
        due_soon: { title: string; due: string }[]
        unscheduled: { title: string; due: string }[]
        plans_behind: { title: string; text: string }[]
        at_risk?: string[]
        possible: { ideas: string[]; suggestions: string[]; quiet_projects: string[] }
        today_context: string[]
      }
      const f = res as unknown as F
      const definite: string[] = []
      if (f.commitments.length) definite.push(`Promises first: ${f.commitments.map((c) => `${c.title} — to ${c.to ?? 'someone'}${c.due ? `, ${c.due}` : ''}${c.overdue ? ' (overdue)' : ''}`).join('; ')}.`)
      if (f.overdue.length) definite.push(`Overdue: ${f.overdue.map((o) => `${o.title} (was ${o.due})`).join('; ')}.`)
      if (f.waiting.length) definite.push(`Waiting on: ${f.waiting.map((w) => `${w.who ?? 'someone'}${w.about ? ` about ${w.about}` : ''}${w.expected ? `, expected ${w.expected}` : ''}${w.overdue ? ' — past due' : ''}`).join('; ')}.`)
      if (f.due_soon.length) definite.push(`Coming up: ${f.due_soon.map((s) => `${s.title} (${s.due})`).join('; ')}.`)
      if (f.unscheduled.length) definite.push(`Due soon, no time set aside: ${f.unscheduled.map((s) => `${s.title} (${s.due})`).join('; ')}.`)
      if (f.plans_behind.length) definite.push(`Plans falling behind: ${f.plans_behind.map((p) => `"${p.title}" — ${p.text}`).join('; ')}.`)
      if (f.at_risk?.length) definite.push(`Deadlines to watch: ${f.at_risk.join(' ')}`)
      const possibleBits: string[] = []
      if (f.possible.ideas.length) possibleBits.push(`${plural(f.possible.ideas.length, 'idea')} noted but never made a task: ${f.possible.ideas.join(', ')}`)
      if (f.possible.suggestions.length) possibleBits.push(`${plural(f.possible.suggestions.length, 'suggestion')} I made, still unconfirmed: ${f.possible.suggestions.join(', ')} — say the word to make one real`)
      if (f.possible.quiet_projects.length) possibleBits.push(`gone quiet: ${f.possible.quiet_projects.join(', ')}`)
      if (!definite.length && !possibleBits.length) lines.push('Nothing I can see slipping. No open promises, nothing overdue, nothing waiting.')
      else {
        if (definite.length) {
          if (f.today_context.some((t) => /exhaust|tired|wiped|drained|knackered|shattered|burnt|burned|worn|low|down|flat|anxious|stressed|overwhelmed|unwell|sick|ill/i.test(t))) definite.push(`You said you're ${f.today_context[0]} today — this is for the record, not a push. Nothing here needs to happen tonight unless it's a promise.`)
          lines.push(definite.join(' '))
        } else lines.push('Nothing definite.')
        // Kept visibly apart: possible things never silently become tasks, and this tool never creates anything either way.
        if (possibleBits.length) lines.push(`Possible, not acted on: ${possibleBits.join('; ')}.`)
      }
    } else if (r.name === 'propose_slot' || r.name === 'plan_week' || r.name === 'refine_week_plan') {
      const t = (res as { text?: string }).text
      if (t) lines.push(t)
    } else if (r.name === 'recommend_now') {
      const t = (res as { text?: string }).text
      if (t) lines.push(t)
    } else if (r.name === 'assess_deadline') {
      const t = (res as { text?: string }).text
      if (t) lines.push(t)
    } else if (r.name === 'get_plan') {
      const g = res as unknown as { ok?: boolean; plan?: { title: string; status: string; cadence: string | null; ends_on: string | null }; description?: string; next?: string | null; progress?: { sessions: { missed: number; done: number; planned: number } } }
      if (!g.plan) lines.push('No plans yet. Say something like "study econometrics two hours every Monday, Wednesday and Friday until October 15" to start one.')
      else lines.push(`"${g.plan.title}"${g.plan.status !== 'active' ? ` (${g.plan.status})` : ''}${g.plan.cadence ? `, ${g.plan.cadence}` : ''}${g.plan.ends_on ? ` until ${g.plan.ends_on}` : ''}: ${g.description}.${g.next ? ` Next session ${g.next}.` : ''}`)
    } else if (r.name === 'check_conflicts') {
      const c = res as unknown as { window: string; level: 'clear' | 'tight' | 'poor' | 'hard'; reasons: string[]; conflicts: { kind: string; text: string }[]; clear: boolean; next_free_from: string | null }
      if (c.level === 'clear') lines.push(`${c.window} is clear.`)
      else if (c.level === 'hard') lines.push(`${c.window} clashes with ${c.conflicts.map((x) => x.text).join(' and ')}.${c.next_free_from ? ` Free from ${c.next_free_from}.` : ''}`)
      else lines.push(`${c.window} works but is a ${c.level === 'tight' ? 'tight fit' : 'poor fit'}: ${c.reasons.join('; ')}.`)
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
  const offerBefore = getOffer()

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
        // Remember the question so a plain "yes" replays the call with confirmed=true and any "no" changes nothing —
        // both in tier 0, never left to the model. A tool that set its own offer (the conflict gate) keeps it.
        if (getOffer() === offerBefore && writes.length === 1) setOffer({ kind: 'confirm', toolName: writes[0].name, args: { ...(writes[0].args as Record<string, unknown>), confirmed: true }, question: e.confirm.question })
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
  const text = !outcome.hadWrites && !outcome.error ? (phraseReadResults(outcome.results) ?? undefined) : undefined
  return { applied, error: outcome.error, confirm: outcome.confirm, text }
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
