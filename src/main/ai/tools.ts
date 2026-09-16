import { detectHappeningStart, kindForLabel } from '../happenings'
import { METAPHORS } from '../../shared/happenings'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { describeRRule as describeRule, firstOccurrence, normalizeRRule } from '../recurrence'
import { getDb } from '../db'
import { log } from '../log'
import * as repo from '../repo'
import { clearOffer, getFocus, pushFocus, setOffer, shortId } from './context'
import { resolveEntity } from '../entity'
import { afterConflicts, blockingConflicts, bookingWindowForDue, conflictsFor, describeConflict, describeConstraint } from '../planning'
import { formatClock, formatDue } from '../../shared/format'
import type { ToolDefinition } from './provider'
import type { Actor, AppliedChange, Item, Note, Reminder } from '../../shared/types'

/**
 * Tool layer (spec §4). Small, flat schemas. Every call is validated with Zod before it touches
 * the database; write tools run inside a transaction opened by the orchestrator; every write is
 * recorded in `activities` with before/after state so undo is a real operation.
 *
 * Time fields (spec invariant 1 — precision is always honest):
 *   *_at_local   = "YYYY-MM-DDTHH:MM"  → exact
 *   *_date_local = "YYYY-MM-DD"        → day (or week/vague if the phrasing was looser)
 */

const DT_DESC = 'Local wall-clock "YYYY-MM-DDTHH:MM" in the user\'s timezone, ONLY when the user stated a clock time. No timezone suffix.'
const DATE_DESC = 'Local date "YYYY-MM-DD", when the user gave a day but no clock time ("tomorrow", "Friday", "next week"). Never add a time.'

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:MM')
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const idRef = z.string().min(6).max(36).describe('The 8-character id shown in square brackets, e.g. "a1b2c3d4".')
const KINDS = ['task', 'deadline', 'project', 'waiting', 'note', 'commitment', 'idea', 'checklist_item'] as const
// A wrong kind from the model ("case_study", "appointment") should not sink the whole write: anything unknown is a task.
const kind = z.preprocess((v) => (typeof v === 'string' && (KINDS as readonly string[]).includes(v) ? v : 'task'), z.enum(KINDS))
const status = z.enum(['open', 'in_progress', 'done', 'cancelled', 'blocked', 'waiting', 'archived'])
const hardness = z.enum(['hard', 'soft']).describe('hard = a real deadline ("must submit Monday at 5"); soft = a target ("I\'d like to finish this weekend").')
const loose = z.enum(['week', 'vague']).describe('Only with a date-only value: "week" for "sometime next week", "vague" for "at some point around then".')
const importance = z
  .number()
  .int()
  .min(1)
  .max(4)
  .describe('Inferred from how the user talks: 1 low ("maybe someday"), 2 normal (default), 3 high ("really need to"), 4 critical ("absolutely must, tonight"). Never ask the user for this.')
const rruleStr = z
  .string()
  .max(200)
  .nullable()
  .describe('RFC 5545 recurrence rule such as "FREQ=WEEKLY;BYDAY=SU" or "FREQ=DAILY", or null for one-off.')

const dueFields = {
  due_at_local: localDateTime.optional().describe('Due time. ' + DT_DESC),
  due_date_local: localDate.optional().describe('Due day. ' + DATE_DESC),
  due_looseness: loose.optional(),
  hardness: hardness.optional(),
  override_conflicts: z.boolean().optional().describe('Only after the user, told of a clash with their availability, says to book it anyway.')
}

const noBothDue = (v: { due_at_local?: string; due_date_local?: string }): boolean => !(v.due_at_local && v.due_date_local)

export const toolSchemas = {
  create_item: z
    .object({
      kind: kind.describe('task = something to do; deadline = must be done by a time; waiting = waiting on someone; note/idea = information only; commitment = promised to someone; project = a Thing with parts.'),
      title: z.string().min(1).max(200).describe('Short imperative title, e.g. "Call the bank".'),
      details: z.string().max(2000).optional().describe('Extra context from the user, if any.'),
      ...dueFields,
      importance: importance.optional(),
      waiting_on: z.string().max(100).optional().describe('For kind=waiting: who or what is being waited on.'),
      remind_at_local: localDateTime.optional().describe('Only if the user asked to be reminded AND gave a clock time. ' + DT_DESC),
      remind_date_local: localDate.optional().describe('Only if the user asked to be reminded on a day without a clock time; the reminder fires at their default reminder time. ' + DATE_DESC),
      remind_rrule: rruleStr.optional().describe('For a RECURRING reminder ("every Sunday", "daily at 8"): the RRULE, e.g. "FREQ=WEEKLY;BYDAY=SU". Give remind_at_local as the first occurrence. Leave due fields empty for recurring chores.'),
      project_id: idRef.optional().describe('If this belongs to an existing project/Thing listed in the context, its id — the item becomes part of it.'),
      project_title: z.string().max(200).optional().describe('If it belongs to a project the user named that is NOT yet in the context, the project name; the app matches an existing project by name or creates it.'),
      is_suggestion: z.boolean().optional().describe('true if YOU are proposing this and the user did not state it. Suggestions are not obligations until confirmed.'),
      confidence: z.number().min(0).max(1).optional().describe('For suggestions: how sure you are the user meant this.')
    })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both')
    .refine((v) => !(v.remind_at_local && v.remind_date_local), 'Give either remind_at_local or remind_date_local, not both')
    .refine((v) => !v.remind_rrule || !!v.remind_at_local || !!v.remind_date_local, 'A recurring reminder needs remind_at_local (its first occurrence)'),
  update_item: z
    .object({
      id: idRef,
      title: z.string().min(1).max(200).optional(),
      details: z.string().max(2000).nullable().optional(),
      due_at_local: localDateTime.optional().describe('New due time (moves pending reminders that sat on the old due time). ' + DT_DESC),
      due_date_local: localDate.optional().describe('New due day. ' + DATE_DESC),
      due_looseness: loose.optional(),
      clear_due: z.boolean().optional().describe('true to remove the due date entirely.'),
      override_conflicts: z.boolean().optional().describe('Only after the user, told of a clash with their availability, says to move it anyway.'),
      hardness: hardness.optional(),
      importance: importance.optional().describe('Set when the user overrides ("that is not actually important").'),
      kind: kind.optional(),
      status: status.optional().describe('Use for in_progress / blocked / waiting / open. For done use complete_item; for cancelled use cancel_item.'),
      waiting_on: z.string().max(100).nullable().optional(),
      confirm_suggestion: z.boolean().optional().describe('true when the user confirms a suggested item — it becomes a real obligation.')
    })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both'),
  create_project: z
    .object({
      title: z.string().min(1).max(200).describe('The Thing\'s name as the user says it, e.g. "TISS mailing", "IIM application".'),
      details: z.string().max(2000).optional(),
      ...dueFields,
      use_existing_id: idRef.optional().describe('After the app asked whether a near-match is the same Thing and the user said yes: the existing project id.'),
      force_new: z.boolean().optional().describe('Only after the user explicitly said it is a DIFFERENT Thing from the near-match.')
    })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both'),
  archive_project: z.object({
    id: idRef,
    confirmed: z.boolean().optional().describe('Archiving is consequential: first call returns a question naming the parts; call again with confirmed=true after a yes.')
  }),
  attach_to_project: z.object({
    item_id: idRef,
    project_id: idRef
  }),
  detach_from_project: z.object({ item_id: idRef }),
  get_project: z.object({ id: idRef }).describe('A project with its parts and history.'),
  add_note: z
    .object({
      body: z.string().min(1).max(2000).describe('The note itself, in the user\'s words: "the transcript must be a PDF".'),
      item_id: idRef.optional().describe('Attach to this item/project/waiting item (id from the context).'),
      item_title: z.string().max(200).optional().describe('Or the item/project as the user named it ("the application"); the app matches it.'),
      reminder_id: idRef.optional().describe('Attach to a reminder.'),
      date_local: localDate.optional().describe('Attach to a day instead of an item: "I\'ll be travelling Friday" → that Friday. ' + DATE_DESC)
    })
    .refine((v) => [v.item_id, v.item_title, v.reminder_id, v.date_local].filter(Boolean).length === 1, 'Give exactly one target: item_id, item_title, reminder_id or date_local'),
  add_link: z
    .object({
      from_id: idRef.describe('For type blocks: the item that must be done FIRST (the blocker).'),
      to_id: idRef.describe('For type blocks: the item that cannot proceed until then.'),
      type: z.enum(['blocks', 'relates_to']).default('blocks')
    })
    .refine((v) => v.from_id !== v.to_id, 'An item cannot depend on itself'),
  remove_link: z.object({ from_id: idRef, to_id: idRef, type: z.enum(['blocks', 'relates_to']).default('blocks') }),
  add_constraint: z
    .object({
      kind: z.enum(['unavailable', 'prefer', 'avoid']).describe('unavailable = cannot do anything then ("busy", "travelling", "class"); avoid = would rather not ("no mornings"); prefer = good time for work.'),
      label: z.string().min(1).max(100).describe('Short label in the user\'s words: "busy", "travelling", "class", "no mornings".'),
      starts_at_local: localDateTime.optional().describe('Start of the (first) window. ' + DT_DESC),
      ends_at_local: localDateTime.optional().describe('End of the (first) window. Afternoon = 12:00–18:00, morning = 08:00–12:00, evening = 18:00–22:00.'),
      date_local: localDate.optional().describe('Whole day unavailable ("travelling Friday"). ' + DATE_DESC),
      rrule: rruleStr.optional().describe('For a standing constraint ("every Tuesday 2–5"): the RRULE; the window repeats.')
    })
    .refine((v) => !!v.date_local || (!!v.starts_at_local && !!v.ends_at_local), 'Give date_local, or both starts_at_local and ends_at_local'),
  remove_constraint: z.object({ id: idRef.optional(), label: z.string().max(100).optional() }).refine((v) => !!v.id || !!v.label, 'Give id or label'),
  start_happening: z.object({
    label: z.string().min(1).max(80).describe('What is happening, in the user\'s words: "egg", "washing machine", "tea", "focus session", "shower".'),
    minutes: z.number().int().min(1).max(24 * 60).optional().describe('How long it runs, ONLY if the user said so ("for 8 minutes"). Omit for open-ended.'),
    metaphor: z.enum(['egg', 'tea', 'laundry', 'plant', 'download', 'focus']).optional().describe('Only when obvious. Omit otherwise; the app shows a plain timer.'),
    project_id: idRef.optional().describe('Only if the happening is genuinely work on a tracked Thing (a focus session on it).')
  }),
  finish_happening: z.object({
    id: idRef.optional(),
    label: z.string().max(80).optional().describe('Words from the running happening ("egg", "the wash"). Omit only when exactly one thing is running.'),
    outcome: z.enum(['done', 'abandoned']).default('done').describe('done = it finished / the user is done with it; abandoned = never mind.')
  }),
  time_happening: z.object({
    id: idRef.describe('The running happening.'),
    minutes: z.number().int().min(1).max(24 * 60).describe('How long from now it should end.')
  }),
  decline_ritual: z.object({
    kind: z.string().min(1).max(30).describe('The kind of happening the user does not want timer offers for: tea, egg, focus, break.')
  }),
  check_conflicts: z
    .object({
      starts_at_local: localDateTime.describe(DT_DESC),
      ends_at_local: localDateTime.optional().describe('Defaults to one hour after the start.')
    })
    .describe('Deterministic: what clashes with this time (unavailability, events). Use before proposing or booking a time.'),
  update_note: z.object({ id: idRef.describe('The note id.'), body: z.string().min(1).max(2000) }),
  delete_note: z.object({ id: idRef.describe('The note id.') }),
  add_checklist_item: z.object({
    project_id: idRef.describe('The project the checklist belongs to.'),
    titles: z.array(z.string().min(1).max(200)).min(1).max(20).describe('One title per checklist item, in order. "Add send first email, follow up, and attach the document" → three titles.')
  }),
  complete_checklist_item: z
    .object({
      id: idRef.optional().describe('The checklist item id, if you can see it in the context.'),
      title: z.string().max(200).optional().describe('Otherwise the item as the user referred to it ("the first email"); matched against the project\'s checklist.'),
      project_id: idRef.optional().describe('The project, when known — narrows the match.')
    })
    .refine((v) => !!v.id || !!v.title, 'Give id or title'),
  remove_checklist_item: z.object({ id: idRef }).describe('Strike a checklist item off the list (status cancelled, nothing deleted).'),
  reorder_checklist: z.object({
    project_id: idRef,
    ordered_ids: z.array(idRef).min(1).max(50).describe('All of the project\'s open checklist item ids in the new order.')
  }),
  promote_checklist_item: z
    .object({ id: idRef, ...dueFields })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both')
    .describe('Turn a checklist item into a standalone task (it stays part of the project), optionally with a due day/time.'),
  complete_item: z.object({ id: idRef }),
  cancel_item: z.object({
    id: idRef,
    confirmed: z.boolean().optional().describe('Set true only after the user has explicitly confirmed a consequential cancel (a project with parts).')
  }),
  delete_item: z.object({
    id: idRef,
    confirmed: z.boolean().optional().describe('Deletion is always consequential: the first call returns a confirmation question; call again with confirmed=true after the user says yes.')
  }),
  create_reminder: z
    .object({
      item_id: idRef,
      fire_at_local: localDateTime.optional().describe(DT_DESC),
      fire_date_local: localDate.optional().describe('Day without clock time; fires at the default reminder time. ' + DATE_DESC),
      rrule: rruleStr.optional(),
      unless_resolved: idRef.optional().describe('Conditional follow-up: fire ONLY if this item (usually the waiting item) is still open at that time. "If they haven\'t replied by Friday afternoon, remind me" → the waiting item\'s id here, item_id the same, fire_at_local Friday 14:00.')
    })
    .refine((v) => !!v.fire_at_local !== !!v.fire_date_local, 'Give exactly one of fire_at_local or fire_date_local'),
  create_waiting: z
    .object({
      waiting_on: z.string().min(1).max(100).describe('Who or what the user is waiting on: "TISS", "the professor", "the bank".'),
      about: z.string().max(200).optional().describe('What it is about, e.g. "reply to the first email", "the transcript".'),
      project_id: idRef.optional().describe('The Thing this belongs to, if any (it becomes a part of it).'),
      expected_at_local: localDateTime.optional().describe('When they said they would get back, if a clock time was given. ' + DT_DESC),
      expected_date_local: localDate.optional().describe('When they said they would get back, day only ("Friday"). ' + DATE_DESC)
    })
    .refine((v) => !(v.expected_at_local && v.expected_date_local), 'Give either expected_at_local or expected_date_local'),
  resolve_waiting: z
    .object({
      id: idRef.optional().describe('The waiting item id when visible in the context.'),
      waiting_on: z.string().max(100).optional().describe('Otherwise who replied ("TISS", "the professor").'),
      project_id: idRef.optional(),
      outcome: z.enum(['replied', 'received', 'no_longer_needed']).default('replied'),
      note: z.string().max(300).optional().describe('What they said, if the user told you.')
    })
    .refine((v) => !!v.id || !!v.waiting_on, 'Give id or waiting_on'),
  update_reminder: z
    .object({
      id: idRef.describe('The reminder id (not the item id).'),
      fire_at_local: localDateTime.optional().describe(DT_DESC),
      rrule: rruleStr.optional()
    })
    .refine((v) => v.fire_at_local !== undefined || v.rrule !== undefined, 'Nothing to change'),
  cancel_reminder: z.object({ id: idRef.describe('The reminder id (not the item id). The item itself stays exactly as it is.') }),
  snooze_reminder: z.object({
    id: idRef.describe('The reminder id.'),
    minutes: z.number().int().min(1).max(60 * 24 * 14)
  }),
  pause_reminder: z.object({
    id: idRef.describe('The reminder id.'),
    resume: z.boolean().optional().describe('true to resume a paused reminder.')
  }),
  record_activity: z.object({
    summary: z.string().min(1).max(300).describe('What the user did, past tense, e.g. "Emailed the professor about the transcript".'),
    item_id: idRef.optional().describe('The existing item this was progress on, if any. Do NOT create a task for a completed action.'),
    now_waiting_on: z.string().max(100).optional().describe('If the action leaves the user waiting on someone ("haven\'t heard back"), who — a waiting item is created.')
  }),
  set_preference: z.object({
    key: z
      .enum(['default_reminder_time', 'day_start', 'day_end', 'name'])
      .describe('default_reminder_time: "HH:MM" used when a reminder is asked for on a day with no clock time. day_start/day_end: "HH:MM". name: what to call the user.'),
    value: z.string().min(1).max(100)
  }),
  undo_last: z.object({}).describe('Reverse the most recent change ("undo that"). Works on the last created/updated/completed/cancelled item or reminder change.'),
  get_item: z.object({ id: idRef }),
  search_memory: z.object({ query: z.string().min(1).max(200).describe('Words to look for in titles and details.') }),
  search_activity: z.object({ item_id: idRef.optional(), query: z.string().max(200).optional() }).describe('History: what happened to an item, or recent activity matching words.'),
  get_today: z.object({}),
  get_upcoming: z.object({ days: z.number().int().min(1).max(60).optional().describe('Default 7.') })
} as const

export type ToolName = keyof typeof toolSchemas

const descriptions: Record<ToolName, string> = {
  create_item: 'Record a NEW obligation or piece of information the user stated (task, deadline, waiting-on, note, idea, commitment, project). Never for something already in memory — update that instead. Never for a completed action — use record_activity.',
  update_item: 'Change fields on an existing item: title, details, due day/time, hardness, importance, kind, status. Use for "move it to 4", "actually make it Tuesday", renames, confirming a suggestion, "I started on it".',
  create_project: 'Start tracking a Thing the user is dealing with that has, or will have, parts ("TISS mailing is something I need to deal with", "my IIM application"). The app first matches existing projects by name — never make a second project for the same Thing.',
  archive_project: 'Put a finished or abandoned project away (status archived). Asks first, naming its parts.',
  attach_to_project: 'Make an existing item part of a project ("that belongs to the TISS mailing").',
  detach_from_project: 'Take an item out of its project.',
  get_project: 'Read one project: its fields, parts and history. Use for "what is left?" / "what have I done for X?".',
  add_note: 'Attach a note to an item, project, reminder or day. "Add a note to the application that the transcript must be a PDF" → item_title "application". "I\'ll be travelling Friday" → date_local. Notes are information, never tasks.',
  add_link: 'Record a dependency: from_id blocks to_id ("I can\'t send the mailing until the list is cleaned" → the list-cleaning item blocks the mailing item). Blocked status is then computed by the app.',
  remove_link: 'Remove a dependency.',
  add_constraint: 'Record when the user is unavailable or prefers/avoids a time ("I\'m busy tomorrow afternoon", "travelling Friday", "no mornings", "class every Tuesday 2–5"). Used to detect conflicts when booking.',
  remove_constraint: 'Remove an availability constraint ("I\'m free tomorrow afternoon after all").',
  start_happening: 'Something is happening in the real world right now: "I\'ve put an egg on for 8 minutes", "started the washing machine", "making tea", "starting a focus session", "charging my phone", "I\'m showering". NOT a task, NOT an obligation, NOT history — it expires on its own. Minutes only if stated.',
  finish_happening: 'A running happening ended: "laundry\'s done", "egg\'s ready", "I\'m out of the shower" (done) or "never mind the egg" (abandoned).',
  time_happening: 'Put a timer on a running open-ended happening ("yes" to a timer offer, "make the tea 4 minutes").',
  decline_ritual: 'The user said no to a timer offer for a kind of happening; the app will not offer it for that kind again.',
  check_conflicts: 'What clashes with a proposed time. The app computes it; you phrase it.',
  update_note: 'Change the text of an existing note.',
  delete_note: 'Remove a note.',
  add_checklist_item: 'Add one or more checklist items to a project ("add a list: send first email, follow up, attach the document"). Checklist items are steps within the Thing, not standalone tasks.',
  complete_checklist_item: 'Tick off a checklist item when the user reports doing it ("I sent the first email", "attached the doc").',
  remove_checklist_item: 'Strike a checklist item off the list.',
  reorder_checklist: 'Change the order of a project\'s checklist.',
  promote_checklist_item: 'Make a checklist item a proper task with its own due date, when the user wants it scheduled ("make the follow-up a task for Friday").',
  complete_item: 'Mark an item done ("done", "finished the CV"). Its own pending reminders stop.',
  cancel_item: 'Cancel ONE item the user no longer wants (status becomes cancelled, nothing is deleted). Its own reminders stop. Projects with parts require confirmation first.',
  delete_item: 'Permanently delete an item. Always requires confirmation. Prefer cancel_item.',
  create_reminder: 'Add a reminder (alarm) to an existing item, optionally recurring, or conditional (unless_resolved) for "if they haven\'t replied by Friday, remind me".',
  create_waiting: 'The user is now waiting on someone or something ("they said they\'ll get back to me Friday", "I emailed her and haven\'t heard back"). Creates a waiting item — not a task.',
  resolve_waiting: 'They replied / it arrived / no longer needed: closes the waiting item and drops any conditional follow-up on it.',
  update_reminder: 'Move an existing reminder to a new clock time and/or change its recurrence.',
  cancel_reminder: 'Cancel a reminder while keeping the underlying item untouched. Use for "cancel the reminder".',
  snooze_reminder: 'Push a reminder that already fired forward by a number of minutes from now.',
  pause_reminder: 'Pause a (recurring) reminder without cancelling it, or resume it.',
  record_activity: 'Record something the user has ALREADY DONE ("I emailed the professor", "I drafted the first email") as history, not as a task. Optionally attach it to the item it was progress on, and create a waiting item if they are now waiting on someone.',
  set_preference: 'Remember a stated preference such as the default reminder time ("remind me at 8 by default").',
  undo_last: 'Undo the most recent change when the user says "undo", "undo that", "revert that".',
  get_item: 'Fetch full details for one item by id.',
  search_memory: 'Search saved items by keyword when the context above does not already include what you need.',
  search_activity: 'What has happened: history for an item, or recent activity matching words.',
  get_today: 'List what is due or overdue today.',
  get_upcoming: 'List open items due in the next N days.'
}

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'start_happening',
  'finish_happening',
  'time_happening',
  'decline_ritual',
  'add_link',
  'remove_link',
  'add_constraint',
  'remove_constraint',
  'add_note',
  'update_note',
  'delete_note',
  'create_waiting',
  'resolve_waiting',
  'add_checklist_item',
  'complete_checklist_item',
  'remove_checklist_item',
  'reorder_checklist',
  'promote_checklist_item',
  'create_project',
  'archive_project',
  'attach_to_project',
  'detach_from_project',
  'create_item',
  'update_item',
  'complete_item',
  'cancel_item',
  'delete_item',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'snooze_reminder',
  'pause_reminder',
  'record_activity',
  'set_preference',
  'undo_last'
])
export const isWriteTool = (name: string): boolean => WRITE_TOOLS.has(name)

function stripSchema(js: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = js
  return rest
}

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    name,
    description: descriptions[name],
    parameters: stripSchema(z.toJSONSchema(toolSchemas[name], { io: 'input' }) as Record<string, unknown>)
  }))
}

export interface ExecContext {
  /** Who is acting: the person (typed tier-0 or manual UI), the assistant (model), or the system (scheduler). */
  actor: Actor
  sourceMsgId: string | null
}

export interface ToolOutcome {
  /** What goes back to the model. */
  result: Record<string, unknown>
  /** What the UI shows as ground truth, for write tools only. */
  applied?: AppliedChange
  /** The tool declined to act until the user confirms (consequential change). */
  confirm?: { question: string; wouldAffect: string[] }
}

export class ToolValidationError extends Error {}

const DEFAULT_REMINDER_CLOCK = '09:00'

/** A reminder on a day with no stated time fires at the default reminder time — and we say so. */
function reminderFromDate(dateOnly: string): { fireAtUtc: string; note: string } {
  const pref = repo.getPreference('default_reminder_time', DEFAULT_REMINDER_CLOCK)
  return {
    fireAtUtc: repo.dateAtClockToUtc(dateOnly, pref.value),
    note: pref.stated ? '(your usual reminder time)' : '(default time — say "remind me at 8 by default" to change it)'
  }
}

const dueText = (i: Item): string => formatDue(i.due_at_utc, i.due_precision)

/**
 * A reminder in the past is never what anyone meant. The common slip is a wrong year ("on the 25th" → last year's
 * 25th): if the same calendar date next year is in the future, use it and say so. Anything else in the past is refused.
 */
function futureReminderTime(utcIso: string): { utc: string; note: string } {
  const t = DateTime.fromISO(utcIso, { zone: 'utc' })
  const now = DateTime.utc()
  if (t >= now.minus({ minutes: 5 })) return { utc: utcIso, note: '' }
  const bumped = t.setZone(DateTime.local().zoneName).plus({ years: 1 })
  if (t < now.minus({ days: 30 }) && bumped > now) {
    return { utc: bumped.toUTC().toISO()!, note: ' (I took that as next year, since the date had already passed)' }
  }
  throw new ToolValidationError(`${formatClock(utcIso)} is already in the past — tell me a future time`)
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const strip = (r: Reminder): Omit<Reminder, 'item_title'> => {
  const { item_title: _t, ...rest } = r
  return rest
}

function validateRRule(s: string | null | undefined): string | null {
  if (!s) return null
  try {
    return normalizeRRule(s)
  } catch {
    throw new ToolValidationError(`"${s}" is not a valid recurrence rule`)
  }
}

const describeRRule = (s: string | null): string => (s ? ', ' + describeRule(s) : '')

/**
 * Validate and execute one tool call. Throws on validation or execution failure.
 * Write tools must be called inside a transaction (the orchestrator does this).
 */
export function executeTool(name: string, rawArgs: unknown, ctx: ExecContext): ToolOutcome {
  if (!(name in toolSchemas)) throw new ToolValidationError(`Unknown tool "${name}"`)
  const schema = toolSchemas[name as ToolName]
  const parsed = schema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ToolValidationError(`Invalid arguments for ${name}: ${issues}`)
  }
  const a = parsed.data as never
  /** Record an activity; project_id is denormalised so project timelines are one query (spec §3). */
  const act = (n: Omit<repo.NewActivity, 'actor'>): void => {
    let projectId = n.projectId ?? null
    if (!projectId && n.targetType === 'item') {
      const it = repo.getItem(n.targetId)
      projectId = it?.kind === 'project' ? it.id : (repo.parentProjectOf(n.targetId)?.id ?? null)
    }
    repo.insertActivity({ ...n, projectId, actor: ctx.actor })
  }
  const focusIds = getFocus().map((f) => f.itemId)

  /**
   * Conflict gate (spec 3f / §6): booking an exact time inside an "unavailable" window or over an event is not done
   * silently — the round is rolled back with a question unless the caller passed override_conflicts. Softer clashes
   * (avoid/prefer) are allowed but named. Returns the note to append, or throws NeedsConfirmation via `confirm`.
   */
  const conflictGate = (dueAtUtc: string | null, precision: string | null, override: boolean | undefined, what: string, replay: { toolName: string; args: unknown }): { note: string; confirm?: ToolOutcome['confirm'] } => {
    if (!dueAtUtc) return { note: '' }
    const win = precision === 'exact' ? bookingWindowForDue(dueAtUtc) : { startUtc: dueAtUtc, endUtc: DateTime.fromISO(dueAtUtc, { zone: 'utc' }).plus({ days: 1 }).toISO()! }
    const all = conflictsFor(win.startUtc, win.endUtc)
    if (!all.length) return { note: '' }
    const hard = blockingConflicts(all)
    // A day-only due date is compatible with a partial-day unavailability; only whole-day blocks matter then.
    const relevant = precision === 'exact' ? hard : hard.filter((c) => DateTime.fromISO(c.window.endUtc).diff(DateTime.fromISO(c.window.startUtc), 'hours').hours >= 23)
    if (relevant.length && !override) {
      const alt = afterConflicts(relevant)
      // Remember the refused booking so a plain "yes" / "book it anyway" replays it with the override — deterministically.
      setOffer({ kind: 'conflict_override', toolName: replay.toolName, args: { ...(replay.args as Record<string, unknown>), override_conflicts: true } })
      return {
        note: '',
        confirm: {
          question: `${what} clashes with ${relevant.map(describeConflict).join(' and ')}. Book it anyway${alt ? `, or would ${formatClock(alt)} onwards suit better` : ''}?`,
          wouldAffect: relevant.map((c) => c.label)
        }
      }
    }
    const soft = all.filter((c) => c.kind === 'avoid' || c.kind === 'prefer')
    if (relevant.length) return { note: ` (booked over ${relevant.map((c) => `"${c.label}"`).join(', ')} as you asked)` }
    if (soft.length) return { note: ` — note: that's ${soft.map(describeConflict).join(' and ')}` }
    return { note: '' }
  }

  /**
   * A waiting item (spec 3c): "Waiting on X — about Y", kind waiting, optionally part of a project, with the expected reply
   * time as a soft due date. Nothing is duplicated: an open waiting item on the same person within the same project is updated.
   */
  const createWaiting = (args: { waitingOn: string; about?: string | null; projectId?: string | null; expectedUtc?: string | null; expectedPrecision?: import('../../shared/types').DuePrecision | null }): { item: Item; reused: boolean } => {
    const existing = repo.openWaitingFor(args.projectId ?? null, args.waitingOn)[0]
    if (existing) {
      const { item } = repo.updateItem(existing.id, {
        ...(args.expectedUtc ? { dueAtUtc: args.expectedUtc, duePrecision: args.expectedPrecision ?? 'day', hardness: 'soft' } : {}),
        ...(args.about && !existing.details ? { details: args.about } : {})
      })
      act({ targetType: 'item', targetId: item.id, verb: 'updated', summary: `Still waiting on ${args.waitingOn}${args.expectedUtc ? ` — now expected ${dueText(item)}` : ''}`, before: existing, after: item })
      pushFocus(item.id, item.title, 'waiting updated')
      return { item, reused: true }
    }
    const item = repo.insertItem({
      kind: 'waiting',
      title: `Waiting on ${args.waitingOn}${args.about ? ` — ${args.about}` : ''}`,
      details: args.about ?? null,
      waitingOn: args.waitingOn,
      dueAtUtc: args.expectedUtc ?? null,
      duePrecision: args.expectedUtc ? (args.expectedPrecision ?? 'day') : null,
      hardness: args.expectedUtc ? 'soft' : null,
      sourceMsgId: ctx.sourceMsgId
    })
    if (args.projectId) repo.setParentProject(item.id, args.projectId)
    act({ targetType: 'item', targetId: item.id, projectId: args.projectId ?? null, verb: 'created', summary: `Waiting on ${args.waitingOn}${args.about ? ` (${args.about})` : ''}${args.expectedUtc ? `, expected ${dueText(item)}` : ''}`, after: item })
    pushFocus(item.id, item.title, 'created')
    return { item, reused: false }
  }

  /** Entity resolution for a project named in conversation (spec §8): match → existing; none → create (inferred). */
  const projectForTitle = (title: string): Item => {
    const res = resolveEntity(title, repo.openProjects(), focusIds)
    if (res.kind !== 'none') return res.entity
    const p = repo.insertItem({ kind: 'project', title, sourceMsgId: ctx.sourceMsgId })
    act({ targetType: 'item', targetId: p.id, projectId: p.id, verb: 'created', summary: `Started tracking "${p.title}"`, after: p })
    return p
  }

  switch (name as ToolName) {
    case 'create_project': {
      const x = a as z.infer<typeof toolSchemas.create_project>
      const pool = repo.openProjects()
      const existing = x.use_existing_id ? repo.getItem(repo.resolveItemId(x.use_existing_id)) : undefined
      const res = existing ? ({ kind: 'match', entity: existing, score: 1 } as const) : x.force_new ? ({ kind: 'none' } as const) : resolveEntity(x.title, pool, focusIds)
      if (res.kind === 'match') {
        pushFocus(res.entity.id, res.entity.title, 'referred to')
        clearOffer()
        const summary = `Matched existing project "${res.entity.title}" (no duplicate created)`
        return {
          result: { ok: true, project_id: shortId(res.entity.id), matched_existing: true, title: res.entity.title, summary },
          applied: { tool: name, summary, phrase: `That's your existing "${res.entity.title}" — I'll keep everything under it.`, itemId: res.entity.id }
        }
      }
      if (res.kind === 'maybe') {
        setOffer({ kind: 'project_match', existingId: res.entity.id, proposedTitle: x.title })
        return {
          result: { ok: false, needs_confirmation: true, near_match_id: shortId(res.entity.id), near_match_title: res.entity.title, question: `Is "${x.title}" the same as the existing project "${res.entity.title}"? If yes call again with use_existing_id; if the user says it is different, call again with force_new=true.` },
          confirm: { question: `Is "${x.title}" the same as your "${res.entity.title}" project? Say yes to keep them together, or "no, new project".`, wouldAffect: [res.entity.title] }
        }
      }
      const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
      const p = repo.insertItem({ kind: 'project', title: x.title, details: x.details ?? null, dueAtUtc: due.dueAtUtc, duePrecision: due.precision, hardness: x.hardness ?? null, sourceMsgId: ctx.sourceMsgId })
      act({ targetType: 'item', targetId: p.id, projectId: p.id, verb: 'created', summary: `Started tracking "${p.title}"${p.due_at_utc ? `, due ${dueText(p)}` : ''}`, after: p })
      pushFocus(p.id, p.title, 'created')
      clearOffer()
      const summary = `Started project "${p.title}"` + (p.due_at_utc ? ` · due ${dueText(p)}` : '')
      return {
        result: { ok: true, project_id: shortId(p.id), matched_existing: false, summary },
        applied: { tool: name, summary, phrase: `Got it — I'm tracking "${p.title}" as a Thing now${p.due_at_utc ? `, due ${dueText(p)}` : ''}. Tell me its parts as they come up.`, itemId: p.id }
      }
    }
    case 'archive_project': {
      const x = a as z.infer<typeof toolSchemas.archive_project>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      const parts = repo.projectParts(id, false)
      if (!x.confirmed) {
        const would = [`"${before.title}"`, ...parts.map((c) => `"${c.title}"`)]
        return {
          result: { ok: false, needs_confirmation: true, would_affect: would, question: `Archive ${would.join(', ')}? Say yes to confirm.` },
          confirm: { question: `Archive "${before.title}"${parts.length ? ` and its ${plural(parts.length, 'open part')}` : ''}? Nothing is deleted; it just leaves your active list.`, wouldAffect: would }
        }
      }
      const tx = repo.updateItem(id, { status: 'archived' })
      for (const c of parts) repo.updateItem(c.id, { status: 'archived' })
      act({ targetType: 'item', targetId: id, projectId: id, verb: 'status_changed', summary: `Archived "${before.title}"${parts.length ? ` with ${plural(parts.length, 'part')}` : ''}`, before: { item: before, parts }, after: tx.item, reversible: false })
      clearOffer()
      const summary = `Archived "${before.title}"${parts.length ? ` and ${plural(parts.length, 'part')}` : ''}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Archived "${before.title}"${parts.length ? ` and its ${plural(parts.length, 'part')}` : ''}. It's out of the way but still in history.`, itemId: id } }
    }
    case 'attach_to_project': {
      const x = a as z.infer<typeof toolSchemas.attach_to_project>
      const itemId = repo.resolveItemId(x.item_id)
      const projectId = repo.resolveItemId(x.project_id)
      const project = repo.getItem(projectId)!
      if (project.kind !== 'project') throw new ToolValidationError(`"${project.title}" is not a project`)
      const item = repo.getItem(itemId)!
      const prev = repo.setParentProject(itemId, projectId)
      act({ targetType: 'item', targetId: itemId, projectId, verb: 'updated', summary: `"${item.title}" is now part of "${project.title}"${prev ? ` (was in "${prev.title}")` : ''}`, before: { parent: prev?.id ?? null }, after: { parent: projectId }, reversible: false })
      pushFocus(project.id, project.title, 'referred to')
      const summary = `"${item.title}" → part of "${project.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Filed "${item.title}" under "${project.title}".`, itemId } }
    }
    case 'detach_from_project': {
      const x = a as z.infer<typeof toolSchemas.detach_from_project>
      const itemId = repo.resolveItemId(x.item_id)
      const item = repo.getItem(itemId)!
      const prev = repo.setParentProject(itemId, null)
      if (!prev) throw new Error(`"${item.title}" is not part of any project`)
      act({ targetType: 'item', targetId: itemId, projectId: prev.id, verb: 'updated', summary: `"${item.title}" taken out of "${prev.title}"`, before: { parent: prev.id }, after: { parent: null }, reversible: false })
      const summary = `"${item.title}" no longer part of "${prev.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Took "${item.title}" out of "${prev.title}".`, itemId } }
    }
    case 'get_project': {
      const x = a as z.infer<typeof toolSchemas.get_project>
      const id = repo.resolveItemId(x.id)
      const p = repo.getItem(id)!
      const parts = repo.projectParts(id).filter((c) => c.status !== 'cancelled' && c.status !== 'archived')
      const history = repo.activitiesForProject(id, 30).filter((h) => h.verb !== 'note_added')
      const notes = [...repo.notesFor('item', id), ...parts.flatMap((c) => repo.notesFor('item', c.id).map((n) => ({ ...n, body: `${c.title}: ${n.body}` })))]
      return {
        result: {
          project: publicItem(p),
          parts: parts.map(publicItem),
          notes: notes.map((n) => ({ id: shortId(n.id), body: n.body })),
          history: history.map((h) => `${h.created_at.slice(0, 16).replace('T', ' ')} · ${h.actor}: ${h.summary}`),
          // The user's own progress (record_activity, ticked steps, finished tasks) — what "what have I done?" is asking about.
          done: history.filter((h) => h.verb === 'completed').map((h) => `${h.summary} (${h.created_at.slice(0, 10)})`).reverse()
        }
      }
    }
    case 'add_link': {
      const x = a as z.infer<typeof toolSchemas.add_link>
      const from = repo.getItem(repo.resolveItemId(x.from_id))!
      const to = repo.getItem(repo.resolveItemId(x.to_id))!
      if (x.type === 'blocks' && repo.hasLink(to.id, from.id, 'blocks')) throw new Error(`"${to.title}" already blocks "${from.title}" — that would be circular`)
      const added = repo.addLink(from.id, to.id, x.type)
      if (!added) throw new Error(`That link already exists`)
      act({ targetType: 'link', targetId: `${from.id}|${to.id}|${x.type}`, projectId: repo.parentProjectOf(to.id)?.id ?? null, verb: 'created', summary: x.type === 'blocks' ? `"${from.title}" blocks "${to.title}"` : `"${from.title}" relates to "${to.title}"`, after: { from: from.id, to: to.id, type: x.type } })
      pushFocus(to.id, to.title, x.type === 'blocks' ? 'now blocked' : 'linked')
      const summary = x.type === 'blocks' ? `"${from.title}" blocks "${to.title}"` : `"${from.title}" ↔ "${to.title}"`
      const phrase = x.type === 'blocks' ? `Got it — "${to.title}" waits on "${from.title}". I'll show it as blocked until that's done.` : `Linked "${from.title}" with "${to.title}".`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: to.id } }
    }
    case 'remove_link': {
      const x = a as z.infer<typeof toolSchemas.remove_link>
      const from = repo.getItem(repo.resolveItemId(x.from_id))!
      const to = repo.getItem(repo.resolveItemId(x.to_id))!
      if (!repo.removeLink(from.id, to.id, x.type)) throw new Error('No such link')
      act({ targetType: 'link', targetId: `${from.id}|${to.id}|${x.type}`, verb: 'deleted', summary: `"${from.title}" no longer ${x.type === 'blocks' ? 'blocks' : 'relates to'} "${to.title}"`, before: { from: from.id, to: to.id, type: x.type } })
      const summary = `Unlinked "${from.title}" → "${to.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `"${to.title}" no longer waits on "${from.title}".`, itemId: to.id } }
    }
    case 'start_happening': {
      // Phase 5. Deliberately NO act(): a happening is not history, not an obligation, not undoable. Its own row is all there is.
      const x = a as z.infer<typeof toolSchemas.start_happening>
      const label = x.label.trim().replace(/[.!]+$/, '')
      const detected = detectHappeningStart(label) ?? kindForLabel(label)
      const kind = detected.kind
      const metaphor = x.metaphor ?? detected.metaphor ?? null
      const dup = repo.runningHappenings().find((h) => h.label.toLowerCase() === label.toLowerCase())
      if (dup) {
        const summary = `"${label}" is already running`
        return { result: { ok: true, happening_id: shortId(dup.id), summary, already_running: true }, applied: { tool: name, summary, phrase: `"${capital(label)}" is already on${dup.ends_at ? ` — until ${formatClock(dup.ends_at)}` : ''}.` } }
      }
      const startedAt = new Date().toISOString()
      const endsAt = x.minutes ? new Date(Date.now() + x.minutes * 60_000).toISOString() : null
      const projectId = x.project_id ? repo.resolveItemId(x.project_id) : null
      const h = repo.insertHappening({ label, kind, metaphor, startedAt, endsAt, projectId })
      clearOffer()
      const untilClock = endsAt ? DateTime.fromISO(endsAt, { zone: 'utc' }).toLocal().toFormat('HH:mm') : null
      const summary = `Happening: ${label}${x.minutes ? ` · ${x.minutes} min (until ${untilClock})` : ' · open-ended'}`
      let phrase = x.minutes ? `${capital(label)} — ${x.minutes} min, I'll say when it's ${metaphor === 'egg' || metaphor === 'tea' || kind === 'cooking' ? 'ready' : 'done'} (${untilClock}).` : `${capital(label)} — noted. Say when it's done.`
      // Micro-ritual (spec Phase 5): offer a timer once, only for kinds with a sensible default, never if this kind was declined.
      const ritual = !x.minutes && kind ? RITUALS[kind] : undefined
      if (ritual && repo.getSettingValue(`ritual.declined.${kind}`) !== '1') {
        setOffer({ kind: 'ritual', happeningId: h.id, happeningKind: kind!, minutes: ritual.minutes, label })
        phrase = `${capital(label)} — noted. ${ritual.question}`
      }
      return { result: { ok: true, happening_id: shortId(h.id), summary, ends_at: endsAt, offered_timer_minutes: ritual ? ritual.minutes : undefined }, applied: { tool: name, summary, phrase, tag: kind ?? undefined } }
    }
    case 'finish_happening': {
      const x = a as z.infer<typeof toolSchemas.finish_happening>
      const ref = x.id ?? x.label ?? ''
      const h = repo.resolveRunningHappening(ref)
      if (!h) {
        const running = repo.runningHappenings()
        const recent = repo.matchHappening(repo.recentlyEndedHappenings(new Date(Date.now() - 6 * 3600_000).toISOString()), ref, true)
        if (recent) throw new Error(`the ${recent.label} already ${recent.state === 'done' ? 'finished' : 'was dropped'} at ${formatClock(recent.ends_at!).replace(/^.*? at /, '')}`)
        throw new Error(running.length ? `nothing running matches "${ref}" — running now: ${running.map((r) => r.label).join(', ')}` : 'nothing is happening right now')
      }
      const ended = repo.finishHappening(h.id, x.outcome)!
      const mins = Math.max(0, Math.round((new Date(ended.ends_at!).getTime() - new Date(h.started_at).getTime()) / 60_000))
      const summary = x.outcome === 'done' ? `Finished: ${h.label}${mins ? ` (${mins} min)` : ''}` : `Dropped: ${h.label}`
      const phrase = x.outcome === 'done' ? doneLineFor(h.label, h.metaphor) : `Okay, forgetting the ${h.label}.`
      clearOffer()
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, tag: x.outcome } }
    }
    case 'time_happening': {
      const x = a as z.infer<typeof toolSchemas.time_happening>
      const h = repo.resolveRunningHappening(x.id)
      if (!h) throw new Error('that is no longer running')
      const endsAt = new Date(Date.now() + x.minutes * 60_000).toISOString()
      getDb().prepare('UPDATE happenings SET ends_at = ? WHERE id = ?').run(endsAt, h.id)
      clearOffer()
      const until = DateTime.fromISO(endsAt, { zone: 'utc' }).toLocal().toFormat('HH:mm')
      const summary = `Timer: ${h.label} · ${x.minutes} min (until ${until})`
      return { result: { ok: true, summary, ends_at: endsAt }, applied: { tool: name, summary, phrase: `${x.minutes} minutes on the ${h.label} — I'll say at ${until}.` } }
    }
    case 'decline_ritual': {
      const x = a as z.infer<typeof toolSchemas.decline_ritual>
      const kind = x.kind.toLowerCase().trim()
      repo.setSettingValue(`ritual.declined.${kind}`, '1')
      clearOffer()
      const summary = `No more timer offers for ${kind}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Okay — I won't offer a timer for ${kind} again.` } }
    }
    case 'add_constraint': {
      const x = a as z.infer<typeof toolSchemas.add_constraint>
      let startsAt: string
      let endsAt: string
      if (x.date_local) {
        const d = DateTime.fromISO(x.date_local, { zone: DateTime.local().zoneName }).startOf('day')
        startsAt = d.toUTC().toISO()!
        endsAt = d.plus({ days: 1 }).toUTC().toISO()!
      } else {
        startsAt = repo.localToUtc(x.starts_at_local!)
        endsAt = repo.localToUtc(x.ends_at_local!)
        if (endsAt <= startsAt) throw new ToolValidationError('The window ends before it starts')
      }
      const rr = validateRRule(x.rrule)
      const c = repo.insertConstraint({ kind: x.kind, label: x.label, startsAt, endsAt, rrule: rr, source: ctx.actor === 'assistant' ? 'inferred' : 'stated' })
      act({ targetType: 'constraint', targetId: c.id, verb: 'created', summary: `${x.kind === 'unavailable' ? 'Unavailable' : x.kind === 'avoid' ? 'Avoid' : 'Prefer'}: ${describeConstraint(c)}`, after: c })
      clearOffer()
      const summary = `${x.kind}: ${describeConstraint(c)}`
      const phrase = x.kind === 'unavailable' ? `Noted — you're ${c.label} ${describeConstraint(c).replace(`${c.label} — `, '')}. I won't book anything there without asking.` : `Noted: ${x.kind === 'avoid' ? 'avoid' : 'prefer'} ${describeConstraint(c)}.`
      return { result: { ok: true, constraint_id: shortId(c.id), summary }, applied: { tool: name, summary, phrase } }
    }
    case 'remove_constraint': {
      const x = a as z.infer<typeof toolSchemas.remove_constraint>
      let c: import('../../shared/types').Constraint | undefined
      if (x.id) c = repo.getConstraint(repo.resolveConstraintId(x.id))
      else {
        const pool = repo.activeConstraints().filter((k) => k.label.toLowerCase().includes(x.label!.toLowerCase()))
        if (pool.length === 1) c = pool[0]
        else if (pool.length > 1) throw new Error(`Several constraints are called "${x.label}" — which one?`)
      }
      if (!c) throw new Error(`No constraint like "${x.label ?? x.id}"`)
      repo.deleteConstraintRow(c.id)
      act({ targetType: 'constraint', targetId: c.id, verb: 'deleted', summary: `Removed constraint: ${describeConstraint(c)}`, before: c })
      const summary = `Removed: ${describeConstraint(c)}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Removed — you're no longer marked ${c.label} then.` } }
    }
    case 'check_conflicts': {
      const x = a as z.infer<typeof toolSchemas.check_conflicts>
      const s = repo.localToUtc(x.starts_at_local)
      const e = x.ends_at_local ? repo.localToUtc(x.ends_at_local) : DateTime.fromISO(s, { zone: 'utc' }).plus({ hours: 1 }).toISO()!
      const cs = conflictsFor(s, e)
      return { result: { window: `${formatClock(s)} – ${formatClock(e)}`, conflicts: cs.map((c) => ({ kind: c.kind, text: describeConflict(c) })), clear: blockingConflicts(cs).length === 0, next_free_from: afterConflicts(blockingConflicts(cs)) ? formatClock(afterConflicts(blockingConflicts(cs))!) : null } }
    }
    case 'add_note': {
      const x = a as z.infer<typeof toolSchemas.add_note>
      let targetType: Note['target_type']
      let targetId: string
      let label: string
      let projectId: string | null = null
      if (x.date_local) {
        targetType = 'date'
        targetId = x.date_local
        label = formatDue(repo.resolveDue(x.date_local, null).dueAtUtc, 'day')
      } else if (x.reminder_id) {
        targetType = 'reminder'
        targetId = repo.resolveReminderId(x.reminder_id)
        label = `the reminder for "${repo.getReminder(targetId)?.item_title ?? 'that'}"`
      } else {
        let item: Item | undefined
        if (x.item_id) item = repo.getItem(repo.resolveItemId(x.item_id))
        else {
          // Entity resolution over everything live: projects first (they are what people name), then other items.
          const pool = [...repo.openProjects(), ...repo.openItems(200).filter((i) => i.kind !== 'project')]
          const res = resolveEntity(x.item_title!, pool, focusIds)
          if (res.kind === 'none') throw new Error(`I couldn't find anything called "${x.item_title}" to note that on`)
          item = res.entity
        }
        if (!item) throw new Error('No such item')
        targetType = 'item'
        targetId = item.id
        label = `"${item.title}"`
        projectId = item.kind === 'project' ? item.id : (repo.parentProjectOf(item.id)?.id ?? null)
        pushFocus(item.id, item.title, 'note added')
      }
      const note = repo.insertNote(targetType, targetId, x.body, ctx.actor === 'assistant' ? 'assistant' : 'user')
      act({ targetType: 'note', targetId: note.id, projectId, verb: 'note_added', summary: `Note on ${label}: ${note.body.slice(0, 80)}${note.body.length > 80 ? '…' : ''}`, after: note })
      clearOffer()
      const summary = `Note on ${label}: ${note.body}`
      const phrase = targetType === 'date' ? `Noted for ${label}: ${note.body}. I'll bear it in mind when planning.` : `Noted on ${label}: ${note.body}.`
      return { result: { ok: true, note_id: shortId(note.id), summary }, applied: { tool: name, summary, phrase, itemId: targetType === 'item' ? targetId : undefined } }
    }
    case 'update_note': {
      const x = a as z.infer<typeof toolSchemas.update_note>
      const id = repo.resolveNoteId(x.id)
      const before = repo.getNote(id)!
      const after = repo.updateNoteBody(id, x.body)
      act({ targetType: 'note', targetId: id, verb: 'updated', summary: `Note changed: "${before.body.slice(0, 40)}" → "${after.body.slice(0, 40)}"`, before, after })
      const summary = `Note updated: ${after.body}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Updated the note: ${after.body}.` } }
    }
    case 'delete_note': {
      const x = a as z.infer<typeof toolSchemas.delete_note>
      const id = repo.resolveNoteId(x.id)
      const before = repo.getNote(id)!
      repo.deleteNoteRow(id)
      act({ targetType: 'note', targetId: id, verb: 'deleted', summary: `Note removed: ${before.body.slice(0, 80)}`, before })
      const summary = `Removed note: ${before.body}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Removed that note. Say "undo" if you want it back.` } }
    }
    case 'create_waiting': {
      const x = a as z.infer<typeof toolSchemas.create_waiting>
      const projectId = x.project_id ? repo.resolveItemId(x.project_id) : (getFocus().map((f) => repo.getItem(f.itemId)).find((i) => i?.kind === 'project')?.id ?? null)
      const due = repo.resolveDue(x.expected_date_local, x.expected_at_local, null)
      const { item, reused } = createWaiting({ waitingOn: x.waiting_on, about: x.about ?? null, projectId, expectedUtc: due.dueAtUtc, expectedPrecision: due.precision })
      clearOffer()
      const project = projectId ? repo.getItem(projectId) : undefined
      const when = item.due_at_utc ? ` · expected ${dueText(item)}` : ''
      const summary = `${reused ? 'Updated waiting' : 'Waiting'} on ${x.waiting_on}${x.about ? ` — ${x.about}` : ''}${project ? ` (${project.title})` : ''}${when}`
      const phrase = reused
        ? `Still waiting on ${x.waiting_on}${item.due_at_utc ? ` — I've noted they said ${dueText(item)}` : ''}. I'll keep it on the waiting list${project ? ` under "${project.title}"` : ''}.`
        : `Got it — you're waiting on ${x.waiting_on}${x.about ? ` for ${x.about}` : ''}${item.due_at_utc ? `, expected ${dueText(item)}` : ''}. I'll keep it on the waiting list${project ? ` under "${project.title}"` : ''}. Say "if they haven't replied by …, remind me" and I'll follow up only if needed.`
      return { result: { ok: true, waiting_id: shortId(item.id), reused, expected: item.due_at_utc ? dueText(item) : null, summary }, applied: { tool: name, summary, phrase, itemId: item.id } }
    }
    case 'resolve_waiting': {
      const x = a as z.infer<typeof toolSchemas.resolve_waiting>
      let target: Item | undefined
      if (x.id) target = repo.getItem(repo.resolveItemId(x.id))
      else {
        const projectId = x.project_id ? repo.resolveItemId(x.project_id) : null
        const pool = repo.openWaitingFor(projectId, x.waiting_on)
        if (pool.length === 1) target = pool[0]
        else if (pool.length > 1) {
          const res = resolveEntity(x.waiting_on!, pool.map((w) => ({ ...w, title: `${w.waiting_on} ${w.details ?? ''}` })), focusIds)
          if (res.kind !== 'none') target = repo.getItem(res.entity.id)
          else throw new Error(`I'm waiting on ${x.waiting_on} for ${pool.length} things — which one?`)
        }
      }
      if (!target) throw new Error(`I don't have an open waiting item for ${x.waiting_on ?? 'that'}`)
      if (target.kind !== 'waiting') throw new ToolValidationError(`"${target.title}" is not a waiting item`)
      const before = target
      const followUps = repo.conditionalRemindersOn(target.id)
      const { stoppedIds } = repo.completeItem(target.id)
      // Conditional follow-ups that watched this item are now moot — the condition can never be met.
      for (const f of followUps) if (!stoppedIds.includes(f.id)) repo.cancelReminder(f.id)
      const dropped = new Set([...stoppedIds, ...followUps.map((f) => f.id)]).size
      const after = repo.getItem(target.id)!
      const project = repo.parentProjectOf(target.id)
      const verbText = x.outcome === 'replied' ? 'replied' : x.outcome === 'received' ? 'arrived' : 'no longer needed'
      act({ targetType: 'item', targetId: target.id, projectId: project?.id ?? null, verb: 'completed', summary: `${target.waiting_on ?? 'They'} ${verbText}${x.note ? ` — ${x.note}` : ''}${dropped ? ` (${plural(dropped, 'follow-up')} dropped)` : ''}`, before: { item: before, stopped: [...new Set([...stoppedIds, ...followUps.map((f) => f.id)])] }, after })
      pushFocus(target.id, target.title, 'resolved')
      if (project) pushFocus(project.id, project.title, 'waiting resolved')
      clearOffer()
      const summary = `Resolved: ${target.title} — ${verbText}${dropped ? ` · ${plural(dropped, 'follow-up')} dropped` : ''}`
      const phrase = `Good — ${target.waiting_on ?? 'they'} ${verbText}${x.note ? ` (${x.note})` : ''}. I've closed that wait${dropped ? ` and dropped the follow-up` : ''}${project ? ` on "${project.title}"` : ''}.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: target.id } }
    }
    case 'add_checklist_item': {
      const x = a as z.infer<typeof toolSchemas.add_checklist_item>
      const projectId = repo.resolveItemId(x.project_id)
      const project = repo.getItem(projectId)!
      if (project.kind !== 'project') throw new ToolValidationError(`"${project.title}" is not a project`)
      const existing = repo.checklistItems(projectId, false)
      let order = repo.nextSortOrder(projectId)
      const created: Item[] = []
      for (const raw of x.titles) {
        const title = raw.trim().replace(/^[-•*\d.)\s]+/, '')
        if (!title) continue
        // Nothing is duplicated: an identical open step is reused, not re-added.
        const dup = existing.find((e) => e.title.toLowerCase() === title.toLowerCase())
        if (dup) continue
        const it = repo.insertItem({ kind: 'checklist_item', title: title.charAt(0).toUpperCase() + title.slice(1), sourceMsgId: ctx.sourceMsgId })
        repo.setSortOrder(it.id, order++)
        repo.addLink(it.id, projectId, 'part_of')
        created.push(repo.getItem(it.id)!)
      }
      if (!created.length) throw new Error('Those steps are already on the list')
      // One activity for the batch so a single "undo" removes all of them.
      act({
        targetType: 'checklist',
        targetId: projectId,
        projectId,
        verb: 'created',
        summary: `Added ${plural(created.length, 'step')} to "${project.title}": ${created.map((c) => c.title).join(', ')}`,
        after: { ids: created.map((c) => c.id), titles: created.map((c) => c.title) }
      })
      pushFocus(project.id, project.title, 'checklist added')
      clearOffer()
      const summary = `Checklist for "${project.title}": +${created.map((c) => `"${c.title}"`).join(', ')}`
      const total = existing.length + created.length
      return {
        result: { ok: true, items: created.map((c) => ({ id: shortId(c.id), title: c.title })), open_total: total, summary },
        applied: { tool: name, summary, phrase: `Added to "${project.title}": ${created.map((c) => c.title).join(', ')}. ${plural(total, 'step')} on the list.`, itemId: projectId }
      }
    }
    case 'complete_checklist_item': {
      const x = a as z.infer<typeof toolSchemas.complete_checklist_item>
      let target: Item | undefined
      if (x.id) target = repo.getItem(repo.resolveItemId(x.id))
      else {
        const projectId = x.project_id ? repo.resolveItemId(x.project_id) : undefined
        const pool = projectId ? repo.checklistItems(projectId, false) : repo.openChecklistItems()
        const res = resolveEntity(x.title!, pool, focusIds)
        if (res.kind === 'none') throw new Error(`I couldn't find a checklist step like "${x.title}"`)
        target = res.entity
      }
      if (!target) throw new Error('No such checklist item')
      if (target.status === 'done') {
        return { result: { ok: true, already_done: true, summary: `"${target.title}" was already ticked off` }, applied: { tool: name, summary: `"${target.title}" already done`, phrase: `"${target.title}" was already ticked off.`, itemId: target.id } }
      }
      const before = target
      const { cancelledReminders, stoppedIds } = repo.completeItem(target.id)
      const after = repo.getItem(target.id)!
      const project = repo.parentProjectOf(target.id)
      const remaining = project ? repo.checklistItems(project.id, false) : []
      act({ targetType: 'item', targetId: target.id, projectId: project?.id ?? null, verb: 'completed', summary: `Ticked off "${after.title}"${project ? ` on "${project.title}"` : ''}${cancelledReminders ? ` (${plural(cancelledReminders, 'reminder')} stopped)` : ''}`, before: { item: before, stopped: stoppedIds }, after })
      if (project) pushFocus(project.id, project.title, 'step completed')
      pushFocus(after.id, after.title, 'completed')
      clearOffer()
      const summary = `Ticked off "${after.title}"${project ? ` · ${remaining.length} left on "${project.title}"` : ''}`
      const phrase = `Ticked off "${after.title}"${project ? ` — ${remaining.length ? `${plural(remaining.length, 'step')} left on "${project.title}": ${remaining.map((r) => r.title).join(', ')}` : `that was the last step on "${project.title}"`}` : ''}.`
      return { result: { ok: true, summary, remaining: remaining.map((r) => ({ id: shortId(r.id), title: r.title })) }, applied: { tool: name, summary, phrase, itemId: after.id } }
    }
    case 'remove_checklist_item': {
      const x = a as z.infer<typeof toolSchemas.remove_checklist_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      const { stoppedIds } = repo.cancelItem(id)
      const project = repo.parentProjectOf(id)
      act({ targetType: 'item', targetId: id, projectId: project?.id ?? null, verb: 'cancelled', summary: `Struck "${before.title}" off "${project?.title ?? 'the list'}"`, before: { item: before, stopped: stoppedIds }, after: repo.getItem(id) })
      const summary = `Struck off "${before.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Struck "${before.title}" off the list.`, itemId: id } }
    }
    case 'reorder_checklist': {
      const x = a as z.infer<typeof toolSchemas.reorder_checklist>
      const projectId = repo.resolveItemId(x.project_id)
      const project = repo.getItem(projectId)!
      const ids = x.ordered_ids.map((r) => repo.resolveItemId(r))
      const current = repo.checklistItems(projectId, false)
      const known = new Set(current.map((c) => c.id))
      for (const id of ids) if (!known.has(id)) throw new ToolValidationError(`${shortId(id)} is not an open step of "${project.title}"`)
      const before = current.map((c) => ({ id: c.id, sort_order: c.sort_order }))
      let order = 1
      for (const id of ids) repo.setSortOrder(id, order++)
      for (const c of current) if (!ids.includes(c.id)) repo.setSortOrder(c.id, order++) // anything omitted keeps relative order at the end
      const afterList = repo.checklistItems(projectId, false)
      act({ targetType: 'checklist', targetId: projectId, projectId, verb: 'updated', summary: `Reordered the checklist on "${project.title}"`, before: { orders: before }, after: { orders: afterList.map((c) => ({ id: c.id, sort_order: c.sort_order })) } })
      const summary = `Reordered "${project.title}": ${afterList.map((c) => c.title).join(' → ')}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `New order on "${project.title}": ${afterList.map((c) => c.title).join(', ')}.`, itemId: projectId } }
    }
    case 'promote_checklist_item': {
      const x = a as z.infer<typeof toolSchemas.promote_checklist_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      if (before.kind !== 'checklist_item') throw new ToolValidationError(`"${before.title}" is not a checklist item`)
      const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
      const { item } = repo.updateItem(id, { kind: 'task', ...(due.dueAtUtc ? { dueAtUtc: due.dueAtUtc, duePrecision: due.precision } : {}), ...(x.hardness ? { hardness: x.hardness } : {}) })
      const project = repo.parentProjectOf(id)
      act({ targetType: 'item', targetId: id, projectId: project?.id ?? null, verb: 'updated', summary: `Promoted "${item.title}" to a task${item.due_at_utc ? ` due ${dueText(item)}` : ''}`, before, after: item })
      pushFocus(item.id, item.title, 'promoted to task')
      const summary = `"${item.title}" is now a task${item.due_at_utc ? ` · due ${dueText(item)}` : ''}${project ? ` (still part of "${project.title}")` : ''}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `"${item.title}" is a proper task now${item.due_at_utc ? `, due ${dueText(item)}` : ''}${project ? `, still under "${project.title}"` : ''}.`, itemId: id } }
    }
    case 'create_item': {
      const x = a as z.infer<typeof toolSchemas.create_item>
      const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
      const gate = conflictGate(due.dueAtUtc, due.precision, x.override_conflicts, `"${x.title}" at ${due.dueAtUtc ? formatDue(due.dueAtUtc, due.precision) : ''}`, { toolName: name, args: rawArgs })
      if (gate.confirm) return { result: { ok: false, needs_confirmation: true, question: gate.confirm.question }, confirm: gate.confirm }
      const item = repo.insertItem({
        kind: x.kind,
        title: x.title,
        details: x.details ?? null,
        dueAtUtc: due.dueAtUtc,
        duePrecision: due.precision,
        hardness: x.hardness ?? (x.kind === 'deadline' ? 'hard' : null),
        importance: x.importance ?? null,
        waitingOn: x.waiting_on ?? null,
        isSuggestion: x.is_suggestion ?? false,
        confidence: x.is_suggestion ? (x.confidence ?? 0.5) : null,
        sourceMsgId: ctx.sourceMsgId
      })
      let reminder: Reminder | null = null
      let reminderNote = ''
      const rr = validateRRule(x.remind_rrule)
      const zone = DateTime.local().zoneName
      if (x.remind_at_local) {
        const fixed = futureReminderTime(repo.localToUtc(x.remind_at_local))
        reminderNote = fixed.note
        reminder = repo.insertReminder(item.id, fixed.utc, rr ? { rrule: rr, seriesAnchorLocal: x.remind_at_local, seriesTz: zone } : {})
      } else if (x.remind_date_local) {
        const r = reminderFromDate(x.remind_date_local)
        if (rr) {
          // Day-only recurring: first occurrence at the default clock, then the rule takes over.
          const clock = repo.getPreference('default_reminder_time', DEFAULT_REMINDER_CLOCK).value
          const first = firstOccurrence(rr, clock, zone, new Date().toISOString())
          reminder = repo.insertReminder(item.id, first?.fireAtUtc ?? r.fireAtUtc, { rrule: rr, seriesAnchorLocal: first?.anchorLocal, seriesTz: zone })
        } else reminder = repo.insertReminder(item.id, r.fireAtUtc)
        reminderNote = ` ${r.note}`
      }
      // Belongs to a Thing? Resolve or infer the project, then attach via part_of (spec §8 3a).
      let project: Item | null = null
      if (x.project_id) project = repo.getItem(repo.resolveItemId(x.project_id)) ?? null
      else if (x.project_title) project = projectForTitle(x.project_title)
      if (project && project.kind !== 'project') project = null
      if (project) repo.setParentProject(item.id, project.id)
      act({ targetType: 'item', targetId: item.id, projectId: project?.id ?? null, verb: 'created', summary: `Created ${item.kind} "${item.title}"${item.due_at_utc ? `, due ${dueText(item)}` : ''}${project ? ` (part of "${project.title}")` : ''}`, after: item })
      if (reminder) {
        act({ targetType: 'reminder', targetId: reminder.id, verb: 'created', summary: `Reminder set for "${item.title}" ${formatClock(reminder.fire_at_utc)}`, after: strip(reminder), reversible: false })
      }
      pushFocus(item.id, item.title, x.is_suggestion ? 'suggested' : 'created')
      clearOffer()
      // Silence on a known deadline is not secretarial (spec §5): offer a reminder for a timed item that has none.
      let offer = ''
      if (!reminder && item.due_at_utc && !x.is_suggestion && item.kind !== 'note' && item.kind !== 'idea') {
        setOffer({ kind: 'reminder', itemId: item.id })
        offer = ' Want a reminder?'
      }
      const summary =
        `${x.is_suggestion ? 'Suggested' : 'Created'} ${item.kind} "${item.title}"` +
        (project ? ` · part of "${project.title}"` : '') +
        (item.due_at_utc ? ` · due ${dueText(item)}` : '') +
        (reminder ? ` · reminder ${formatClock(reminder.fire_at_utc)}${describeRRule(reminder.rrule)}${reminderNote}` : '')
      const phrase = x.is_suggestion
        ? `I've pencilled in "${item.title}" as a suggestion${item.due_at_utc ? ` for ${dueText(item)}` : ''} — say the word and I'll make it real.`
        : reminder
          ? reminder.rrule
            ? `Noted — I'll remind you about "${item.title}" ${describeRule(reminder.rrule)}, starting ${formatClock(reminder.fire_at_utc)}${reminderNote}.`
            : `Noted — I'll remind you about "${item.title}" ${formatClock(reminder.fire_at_utc)}${reminderNote}.`
          : item.due_at_utc
            ? `Noted "${item.title}"${project ? ` under "${project.title}"` : ''}, due ${dueText(item)}${item.due_precision === 'day' ? ' (no time set)' : ''}${gate.note}.${offer}`
            : `Noted "${item.title}"${project ? ` under "${project.title}"` : ''}.`
      return {
        result: {
          ok: true,
          item_id: shortId(item.id),
          reminder_id: reminder ? shortId(reminder.id) : null,
          due: item.due_at_utc ? dueText(item) : null,
          due_precision: item.due_precision,
          reminder: reminder ? formatClock(reminder.fire_at_utc) + reminderNote : null,
          summary
        },
        applied: { tool: name, summary, phrase, itemId: item.id, reminderId: reminder?.id }
      }
    }
    case 'update_item': {
      const x = a as z.infer<typeof toolSchemas.update_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      const patch: repo.ItemPatch = {}
      const changed: string[] = []
      if (x.title !== undefined) (patch.title = x.title), changed.push('title')
      if (x.details !== undefined) (patch.details = x.details), changed.push('details')
      if (x.clear_due) {
        patch.dueAtUtc = null
        changed.push('due removed')
      } else if (x.due_at_local || x.due_date_local) {
        const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
        const gate = conflictGate(due.dueAtUtc, due.precision, x.override_conflicts, `Moving "${before.title}" to ${formatDue(due.dueAtUtc, due.precision)}`, { toolName: name, args: rawArgs })
        if (gate.confirm) return { result: { ok: false, needs_confirmation: true, question: gate.confirm.question }, confirm: gate.confirm }
        if (gate.note) changed.push(gate.note.trim().replace(/^[—(]\s*/, '').replace(/\)$/, ''))
        patch.dueAtUtc = due.dueAtUtc
        patch.duePrecision = due.precision
        changed.push('due')
      }
      if (x.hardness !== undefined) (patch.hardness = x.hardness), changed.push('hardness')
      if (x.importance !== undefined) (patch.importance = x.importance), changed.push('importance')
      if (x.kind !== undefined) (patch.kind = x.kind), changed.push('kind')
      if (x.status !== undefined) (patch.status = x.status), changed.push('status')
      if (x.waiting_on !== undefined) (patch.waitingOn = x.waiting_on), changed.push('waiting on')
      if (x.confirm_suggestion) (patch.isSuggestion = false), changed.push('confirmed')
      const { item, movedReminders } = repo.updateItem(id, patch)
      const verb = patch.dueAtUtc !== undefined ? 'rescheduled' : patch.status !== undefined ? 'status_changed' : 'updated'
      act({
        targetType: 'item',
        targetId: item.id,
        verb,
        summary:
          verb === 'rescheduled'
            ? `"${item.title}" moved ${before.due_at_utc ? dueText(before) : 'undated'} → ${item.due_at_utc ? dueText(item) : 'undated'}`
            : `"${item.title}" ${changed.join(', ')} changed`,
        before,
        after: item
      })
      pushFocus(item.id, item.title, 'updated')
      clearOffer()
      const summary =
        `Updated "${item.title}" (${changed.join(', ') || 'nothing'})` +
        (patch.dueAtUtc !== undefined ? ` · now due ${item.due_at_utc ? dueText(item) : 'no date'}` : '') +
        (movedReminders ? ` · moved ${plural(movedReminders, 'reminder')} with it` : '')
      const phrase =
        patch.dueAtUtc !== undefined
          ? `Updated — "${item.title}" is now ${item.due_at_utc ? `due ${dueText(item)}` : 'undated'}.${movedReminders ? ' The reminder moved with it.' : ''}`
          : `Updated "${item.title}" (${changed.join(', ') || 'no change'}).`
      return {
        result: { ok: true, item_id: shortId(item.id), due: item.due_at_utc ? dueText(item) : null, due_precision: item.due_precision, moved_reminders: movedReminders, summary },
        applied: { tool: name, summary, phrase, itemId: item.id }
      }
    }
    case 'complete_item': {
      const x = a as z.infer<typeof toolSchemas.complete_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      const { cancelledReminders, stoppedIds } = repo.completeItem(id)
      const item = repo.getItem(id)!
      const freed = repo.newlyUnblockedBy(id) // computed from links, never asserted
      act({ targetType: 'item', targetId: id, verb: 'completed', summary: `Completed "${item.title}"${cancelledReminders ? ` (${plural(cancelledReminders, 'reminder')} stopped)` : ''}${freed.length ? ` — unblocks ${freed.map((f) => `"${f.title}"`).join(', ')}` : ''}`, before: { item: before, stopped: stoppedIds }, after: item })
      pushFocus(item.id, item.title, 'completed')
      clearOffer()
      const summary = `Completed "${item.title}"` + (cancelledReminders ? ` · its ${plural(cancelledReminders, 'reminder')} stopped` : '') + (freed.length ? ` · unblocks ${freed.map((f) => `"${f.title}"`).join(', ')}` : '')
      const phrase = `Marked "${item.title}" done.${cancelledReminders ? ` Its ${plural(cancelledReminders, 'reminder')} won't fire.` : ''}${freed.length ? ` That unblocks ${freed.map((f) => `"${f.title}"`).join(' and ')}.` : ''}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: id, tag: item.kind === 'project' ? 'project' : item.kind } }
    }
    case 'cancel_item': {
      const x = a as z.infer<typeof toolSchemas.cancel_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      // Consequential? A project, or anything with parts, needs an explicit yes (spec §4 confidence tiers).
      const children = repo.childItems(id)
      if ((before.kind === 'project' || children.length > 0) && !x.confirmed) {
        const would = [`"${before.title}"`, ...children.map((c) => `"${c.title}"`)]
        return {
          result: { ok: false, needs_confirmation: true, would_affect: would, question: `Cancel ${would.join(', ')}? This stops ${would.length} item(s). Say yes to confirm.` },
          confirm: { question: `Cancel "${before.title}"${children.length ? ` and its ${plural(children.length, 'part')}` : ''}? Nothing is deleted, but they all stop being live.`, wouldAffect: would }
        }
      }
      const { cancelledReminders, stoppedIds } = repo.cancelItem(id)
      const item = repo.getItem(id)!
      act({ targetType: 'item', targetId: id, verb: 'cancelled', summary: `Cancelled "${item.title}"${cancelledReminders ? ` (${plural(cancelledReminders, 'reminder')} stopped)` : ''}`, before: { item: before, stopped: stoppedIds }, after: item })
      pushFocus(item.id, item.title, 'cancelled')
      clearOffer()
      const summary = `Cancelled "${item.title}"` + (cancelledReminders ? ` · its ${plural(cancelledReminders, 'reminder')} stopped` : '') + ' · nothing else touched'
      const phrase = `Cancelled "${item.title}".${cancelledReminders ? ` Its ${plural(cancelledReminders, 'reminder')} won't fire.` : ''} Nothing else was touched.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: id } }
    }
    case 'delete_item': {
      const x = a as z.infer<typeof toolSchemas.delete_item>
      const id = repo.resolveItemId(x.id)
      const before = repo.getItem(id)!
      const rems = repo.pendingRemindersForItems([id])
      const parts = before.kind === 'project' ? repo.projectParts(id, false) : []
      if (!x.confirmed) {
        const would = [
          `"${before.title}"`,
          ...(rems.length ? [`its ${plural(rems.length, 'reminder')}`] : []),
          ...(parts.length ? [`${plural(parts.length, 'part')} left on their own (${parts.map((p) => `"${p.title}"`).join(', ')})`] : [])
        ]
        return {
          result: { ok: false, needs_confirmation: true, would_affect: would, question: `Permanently delete ${would.join(', ')}? Say yes to confirm.` },
          confirm: {
            question:
              `Delete "${before.title}" for good` +
              (rems.length ? ` along with its ${plural(rems.length, 'reminder')}` : '') +
              `?` +
              (parts.length ? ` Its ${plural(parts.length, 'part')} (${parts.map((p) => p.title).join(', ')}) would stay but no longer belong to anything.` : '') +
              ` Cancelling instead keeps the history.`,
            wouldAffect: would
          }
        }
      }
      // Snapshot everything the deletion detaches, so undo restores links and history pointers too.
      const snapshot = repo.snapshotForDeletion(id)
      repo.deleteItemRow(id)
      act({ targetType: 'item', targetId: id, verb: 'deleted', summary: `Deleted "${before.title}"${parts.length ? ` (${plural(parts.length, 'part')} left on their own)` : ''}`, before: snapshot })
      clearOffer()
      const allRems = snapshot.reminders
      const summary = `Deleted "${before.title}"` + (allRems.length ? ` and ${plural(allRems.length, 'reminder')}` : '') + (parts.length ? ` · ${plural(parts.length, 'part')} kept, unattached` : '')
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase: `Deleted "${before.title}". Say "undo" if that was a mistake.` } }
    }
    case 'create_reminder': {
      const x = a as z.infer<typeof toolSchemas.create_reminder>
      const itemId = repo.resolveItemId(x.item_id)
      let note = ''
      let fireAt: string
      if (x.fire_at_local) {
        const fixed = futureReminderTime(repo.localToUtc(x.fire_at_local))
        fireAt = fixed.utc
        note = fixed.note
      } else {
        const r = reminderFromDate(x.fire_date_local!)
        const fixed = futureReminderTime(r.fireAtUtc)
        fireAt = fixed.utc
        note = ` ${r.note}${fixed.note}`
      }
      const rr = validateRRule(x.rrule)
      // Conditional follow-up: the condition is data the scheduler checks at fire time — never a question for the model.
      let condition: string | null = null
      let watched: Item | null = null
      if (x.unless_resolved) {
        watched = repo.getItem(repo.resolveItemId(x.unless_resolved)) ?? null
        if (!watched) throw new ToolValidationError('unless_resolved points at nothing')
        if (['done', 'cancelled', 'archived'].includes(watched.status)) throw new Error(`"${watched.title}" is already resolved — no follow-up needed`)
        condition = JSON.stringify({ unless_resolved: watched.id })
      }
      const r = repo.insertReminder(itemId, fireAt, { ...(rr ? { rrule: rr, seriesAnchorLocal: x.fire_at_local ?? undefined, seriesTz: DateTime.local().zoneName } : {}), conditionJson: condition })
      const item = repo.getItem(itemId)!
      const condText = watched ? ` unless "${watched.title}" is resolved by then` : ''
      act({ targetType: 'reminder', targetId: r.id, projectId: repo.parentProjectOf(itemId)?.id ?? null, verb: 'created', summary: `${watched ? 'Follow-up' : 'Reminder'} set for "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}${condText}`, after: strip(r) })
      pushFocus(item.id, item.title, watched ? 'follow-up added' : 'reminder added')
      clearOffer()
      const summary = `${watched ? 'Follow-up' : 'Reminder'} for "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}${note}${condText}`
      const phrase = watched
        ? `Noted — if that's still unresolved by ${formatClock(r.fire_at_utc)}, I'll nudge you${note}. If they reply first, the follow-up quietly drops.`
        : `I'll remind you about "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}${note}.`
      return { result: { ok: true, reminder_id: shortId(r.id), fires: formatClock(r.fire_at_utc) + note, summary }, applied: { tool: name, summary, phrase, itemId, reminderId: r.id } }
    }
    case 'update_reminder': {
      const x = a as z.infer<typeof toolSchemas.update_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      if (before.state === 'cancelled') throw new Error('That reminder is cancelled; create a new one instead')
      const patch: repo.ReminderPatch = {}
      let timeNote = ''
      if (x.fire_at_local !== undefined) {
        const fixed = futureReminderTime(repo.localToUtc(x.fire_at_local))
        patch.fireAtUtc = fixed.utc
        timeNote = fixed.note
        patch.state = 'pending'
      }
      if (x.rrule !== undefined) patch.rrule = validateRRule(x.rrule)
      const r = repo.updateReminder(id, patch)
      const title = r.item_title ?? 'that'
      act({
        targetType: 'reminder',
        targetId: id,
        verb: 'rescheduled',
        summary: `Reminder for "${title}" ${formatClock(before.fire_at_utc)} → ${formatClock(r.fire_at_utc)}${x.rrule !== undefined ? ` (${r.rrule ? 'repeats' + describeRRule(r.rrule) : 'no longer repeats'})` : ''}`,
        before: strip(before),
        after: strip(r)
      })
      if (r.target_type === 'item') pushFocus(r.target_id, title, 'reminder moved')
      const summary = `Moved reminder for "${title}" to ${formatClock(r.fire_at_utc)}${describeRRule(r.rrule)}${timeNote}`
      const phrase = `The reminder for "${title}" now fires ${formatClock(r.fire_at_utc)}${describeRRule(r.rrule)}${timeNote}.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: r.target_type === 'item' ? r.target_id : undefined, reminderId: id } }
    }
    case 'cancel_reminder': {
      const x = a as z.infer<typeof toolSchemas.cancel_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      repo.cancelReminder(id)
      const after = repo.getReminder(id)!
      const title = before.item_title ?? 'that'
      act({ targetType: 'reminder', targetId: id, verb: 'cancelled', summary: `Reminder for "${title}" cancelled (item kept)`, before: strip(before), after: strip(after) })
      if (before.target_type === 'item') pushFocus(before.target_id, title, 'reminder cancelled')
      const summary = `Cancelled the reminder for "${title}" · the item itself is unchanged`
      const phrase = `Reminder cancelled. "${title}" itself is still on your list.`
      return { result: { ok: true, item_still_open: true, summary }, applied: { tool: name, summary, phrase, itemId: before.target_type === 'item' ? before.target_id : undefined, reminderId: id } }
    }
    case 'snooze_reminder': {
      const x = a as z.infer<typeof toolSchemas.snooze_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      const r = repo.snoozeReminder(id, x.minutes)
      const title = r.item_title ?? 'that'
      act({ targetType: 'reminder', targetId: id, verb: 'snoozed', summary: `Reminder for "${title}" snoozed ${x.minutes} min → ${formatClock(r.fire_at_utc)}`, before: strip(before), after: strip(r) })
      if (r.target_type === 'item') pushFocus(r.target_id, title, 'reminder snoozed')
      const summary = `Snoozed reminder for "${title}" until ${formatClock(r.fire_at_utc)}`
      const phrase = `Snoozed — I'll nudge you about "${title}" again ${formatClock(r.fire_at_utc)}.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: r.target_type === 'item' ? r.target_id : undefined, reminderId: id } }
    }
    case 'pause_reminder': {
      const x = a as z.infer<typeof toolSchemas.pause_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      if (x.resume ? before.state !== 'paused' : !['pending', 'snoozed'].includes(before.state)) {
        throw new Error(x.resume ? 'That reminder is not paused' : 'Only a pending reminder can be paused')
      }
      const r = repo.updateReminder(id, { state: x.resume ? 'pending' : 'paused' })
      const title = r.item_title ?? 'that'
      act({ targetType: 'reminder', targetId: id, verb: 'status_changed', summary: `Reminder for "${title}" ${x.resume ? 'resumed' : 'paused'}`, before: strip(before), after: strip(r) })
      const summary = `${x.resume ? 'Resumed' : 'Paused'} reminder for "${title}"`
      const phrase = x.resume ? `Resumed — the reminder for "${title}" is live again.` : `Paused the reminder for "${title}". Say "resume" when you want it back.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: r.target_type === 'item' ? r.target_id : undefined, reminderId: id } }
    }
    case 'record_activity': {
      const x = a as z.infer<typeof toolSchemas.record_activity>
      const itemId = x.item_id ? repo.resolveItemId(x.item_id) : null
      const item = itemId ? repo.getItem(itemId) : undefined
      const today = DateTime.local().toISODate()!
      // Through act() so project_id is filled — "what have I done for X?" reads the project timeline (fixed 2026-09-16).
      act({
        targetType: item ? 'item' : 'date',
        targetId: item ? item.id : today,
        verb: 'completed',
        summary: x.summary,
        reversible: false
      })
      if (item) {
        repo.updateItem(item.id, {})
        getDb().prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), item.id)
        pushFocus(item.id, item.title, 'progress recorded')
      }
      let waiting: Item | null = null
      if (x.now_waiting_on) {
        const project = item ? (item.kind === 'project' ? item : repo.parentProjectOf(item.id)) : undefined
        waiting = createWaiting({ waitingOn: x.now_waiting_on, about: item && item.kind !== 'project' ? item.title : null, projectId: project?.id ?? null }).item
      }
      const summary = `Recorded: ${x.summary}` + (item ? ` (on "${item.title}")` : '') + (waiting ? ` · now waiting on ${x.now_waiting_on}` : '')
      // Don't say the project's name twice ("worked on the TISS mailing on TISS mailing").
      const mentionsItem = item ? x.summary.toLowerCase().includes(item.title.toLowerCase()) : false
      const phrase =
        `Got it — noted that you ${lowerFirst(x.summary)}${item && !mentionsItem ? ` on "${item.title}"` : ''}.` +
        (item && item.kind === 'project' ? ` It's in the "${item.title}" history.` : '') +
        (waiting ? ` I'll keep track that you're waiting on ${x.now_waiting_on}.` : '')
      return { result: { ok: true, summary, waiting_item_id: waiting ? shortId(waiting.id) : null }, applied: { tool: name, summary, phrase, itemId: item?.id ?? waiting?.id } }
    }
    case 'set_preference': {
      const x = a as z.infer<typeof toolSchemas.set_preference>
      if (x.key !== 'name' && !/^\d{1,2}:\d{2}$/.test(x.value)) throw new ToolValidationError(`${x.key} must be "HH:MM"`)
      const before = repo.getPreference(x.key, '')
      repo.setPreference(x.key, x.value, 'stated')
      act({ targetType: 'preference', targetId: x.key, verb: 'updated', summary: `${x.key.replace(/_/g, ' ')} set to ${x.value}`, before: before.value || null, after: x.value, reversible: false })
      const summary = `Remembered ${x.key.replace(/_/g, ' ')} = ${x.value}`
      const phrase = `Got it — your ${x.key.replace(/_/g, ' ')} is now ${x.value}.`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase } }
    }
    case 'undo_last': {
      const last = repo.lastUndoableActivity()
      if (!last) throw new Error('There is nothing to undo')
      const undone = undoActivity(last)
      repo.markActivityIrreversible(last.id)
      repo.insertActivity({ targetType: last.target_type, targetId: last.target_id, projectId: last.project_id ?? null, verb: 'undone', actor: ctx.actor, summary: `Undid: ${last.summary}`, before: last.after_json ? JSON.parse(last.after_json) : null, after: last.before_json ? JSON.parse(last.before_json) : null, reversible: false })
      clearOffer()
      const summary = `Undid: ${last.summary}`
      return { result: { ok: true, summary, restored: undone }, applied: { tool: name, summary, phrase: `Undone — ${lowerFirst(undone)}.` } }
    }
    case 'get_item': {
      const x = a as z.infer<typeof toolSchemas.get_item>
      const item = repo.getItem(repo.resolveItemId(x.id))!
      const rs = repo.pendingRemindersForItems([item.id])
      return {
        result: {
          item: publicItem(item),
          reminders: rs.map(publicReminder),
          notes: repo.notesFor('item', item.id).map((n) => ({ id: shortId(n.id), body: n.body })),
          history: repo.activitiesFor('item', item.id, 10).map((h) => `${h.created_at.slice(0, 10)} ${h.summary}`)
        }
      }
    }
    case 'search_memory': {
      const x = a as z.infer<typeof toolSchemas.search_memory>
      return { result: { items: repo.searchItems(x.query).map(publicItem), notes: repo.searchNotes(x.query).map((n) => ({ id: shortId(n.id), on: n.target_type === 'date' ? n.target_id : n.target_type, body: n.body })) } }
    }
    case 'search_activity': {
      const x = a as z.infer<typeof toolSchemas.search_activity>
      const rows = x.item_id ? repo.activitiesFor('item', repo.resolveItemId(x.item_id), 30) : repo.listActivities(30)
      const q = (x.query ?? '').toLowerCase()
      return { result: { history: rows.filter((h) => !q || h.summary.toLowerCase().includes(q)).map((h) => `${h.created_at.slice(0, 16).replace('T', ' ')} · ${h.actor}: ${h.summary}`) } }
    }
    case 'get_today': {
      const now = DateTime.local()
      const start = now.startOf('day').toUTC().toISO()!
      const end = now.endOf('day').toUTC().toISO()!
      const items = [...repo.openItemsOverdue(now.toUTC().toISO()!), ...repo.itemsDueBetween(start, end)]
      return { result: { items: items.map(publicItem) } }
    }
    case 'get_upcoming': {
      const x = a as z.infer<typeof toolSchemas.get_upcoming>
      const now = DateTime.local()
      const items = repo.itemsDueBetween(now.toUTC().toISO()!, now.plus({ days: x.days ?? 7 }).toUTC().toISO()!)
      return { result: { items: items.map(publicItem) } }
    }
  }
}

/** Reverse one activity from its recorded before-state. Returns a human sentence of what was restored. */
function undoActivity(a: import('../../shared/types').Activity): string {
  const before = a.before_json ? (JSON.parse(a.before_json) as unknown) : null
  const after = a.after_json ? (JSON.parse(a.after_json) as unknown) : null
  if (a.target_type === 'item') {
    if (a.verb === 'created') {
      const it = after as Item
      repo.deleteItemRow(a.target_id)
      return `removed "${it?.title ?? 'the item'}" again`
    }
    if (a.verb === 'deleted') {
      const b = before as Partial<repo.DeletionSnapshot> & { item: Item }
      repo.restoreFromSnapshot({ item: b.item, reminders: b.reminders ?? [], links: b.links ?? [], activityIds: b.activityIds ?? [], eventIds: b.eventIds ?? [] })
      const relinked = (b.links ?? []).length
      return `restored "${b.item.title}"${relinked ? ` with its ${plural(relinked, 'link')}` : ''}`
    }
    if (before) {
      // complete/cancel record { item, stopped }; plain updates record the item itself.
      const wrapped = before as { item?: Item; stopped?: string[] }
      const b = (wrapped.item ?? before) as Item
      repo.restoreItem(b)
      // Only the alarms that this very change stopped come back — never ones the user cancelled separately.
      if (wrapped.stopped?.length) repo.reviveReminders(wrapped.stopped)
      return `"${b.title}" is back to how it was${wrapped.stopped?.length ? ` and its ${plural(wrapped.stopped.length, 'reminder')} ${wrapped.stopped.length === 1 ? 'is' : 'are'} live again` : ''}`
    }
  }
  if (a.target_type === 'link') {
    const l = (a.verb === 'created' ? after : before) as { from: string; to: string; type: 'blocks' | 'relates_to' }
    if (a.verb === 'created') {
      repo.removeLink(l.from, l.to, l.type)
      return 'removed that dependency again'
    }
    if (a.verb === 'deleted') {
      repo.addLink(l.from, l.to, l.type)
      return 'restored the dependency'
    }
  }
  if (a.target_type === 'constraint') {
    if (a.verb === 'created') {
      repo.deleteConstraintRow(a.target_id)
      return 'forgot that availability constraint again'
    }
    if (a.verb === 'deleted' && before) {
      repo.restoreConstraint(before as import('../../shared/types').Constraint)
      return 'restored the availability constraint'
    }
  }
  if (a.target_type === 'note') {
    if (a.verb === 'note_added') {
      repo.deleteNoteRow(a.target_id)
      return 'removed that note again'
    }
    if (a.verb === 'deleted' && before) {
      repo.restoreNote(before as Note)
      return 'put the note back'
    }
    if (a.verb === 'updated' && before) {
      repo.updateNoteBody(a.target_id, (before as Note).body)
      return 'restored the previous wording of the note'
    }
  }
  if (a.target_type === 'checklist') {
    if (a.verb === 'created') {
      const ids = (after as { ids?: string[] })?.ids ?? []
      for (const id of ids) repo.deleteItemRow(id)
      return `removed ${plural(ids.length, 'step')} from the list again`
    }
    if (a.verb === 'updated' && before) {
      for (const o of (before as { orders: { id: string; sort_order: number | null }[] }).orders) repo.setSortOrder(o.id, o.sort_order ?? 0)
      return 'put the checklist back in its previous order'
    }
  }
  if (a.target_type === 'reminder') {
    if (a.verb === 'created') {
      repo.deleteReminderRow(a.target_id)
      return 'removed that reminder again'
    }
    if (before) {
      repo.restoreReminder(before as Reminder)
      const r = repo.getReminder(a.target_id)
      return `the reminder for "${r?.item_title ?? 'that'}" is back to ${r ? formatClock(r.fire_at_utc) : 'how it was'}`
    }
  }
  throw new Error(`Cannot undo "${a.summary}"`)
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

function publicItem(i: Item): Record<string, unknown> {
  const blockers = repo.blockersOf(i.id)
  return {
    id: shortId(i.id),
    blocked_by: blockers.length ? blockers.map((b) => b.title) : undefined,
    kind: i.kind,
    title: i.title,
    details: i.details,
    status: i.status,
    due: i.due_at_utc ? formatDue(i.due_at_utc, i.due_precision) : null,
    due_precision: i.due_precision,
    hardness: i.hardness,
    importance: i.importance,
    is_suggestion: !!i.is_suggestion,
    waiting_on: i.waiting_on
  }
}
function publicReminder(r: Reminder): Record<string, unknown> {
  return { id: shortId(r.id), state: r.state, fires: formatClock(r.fire_at_utc), repeats: r.rrule }
}

/** Run `fn` inside one SQLite transaction; anything thrown rolls everything back. */
export function inTransaction<T>(fn: () => T): T {
  const tx = getDb().transaction(fn)
  try {
    return tx()
  } catch (e) {
    // A confirmation request also unwinds the transaction, but it is a question, not a failure.
    const isQuestion = !!(e as { confirm?: unknown }).confirm
    log(isQuestion ? 'info' : 'warn', isQuestion ? 'tools.awaiting_confirmation' : 'tools.rolled_back', (e as Error).message)
    throw e
  }
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Micro-rituals (spec Phase 5): one gentle offer per open-ended happening, only where a default timer makes sense. */
const RITUALS: Record<string, { minutes: number; question: string }> = {
  tea: { minutes: 5, question: 'Want a 5-minute steep timer?' },
  egg: { minutes: 7, question: 'Want a 7-minute timer? That is about soft-medium.' },
  focus: { minutes: 25, question: 'Want a 25-minute timer for it?' },
  break: { minutes: 10, question: 'Want me to say when 10 minutes are up?' }
}

/** The metaphor's finishing line only when the label really is that thing; otherwise the label itself ("Coffee — ready."). */
export function doneLineFor(label: string, metaphor: string | null): string {
  const l = label.toLowerCase()
  if (metaphor === 'tea' && /\btea\b|\bchai\b/.test(l)) return METAPHORS.tea.doneLine
  if (metaphor === 'egg' && /\begg/.test(l)) return METAPHORS.egg.doneLine
  if (metaphor === 'laundry' && /laundry|wash/.test(l)) return METAPHORS.laundry.doneLine
  if (metaphor === 'focus') return METAPHORS.focus.doneLine
  if (metaphor === 'tea' || metaphor === 'egg' || metaphor === 'plant') return `${capital(label)} — ready.`
  return `${capital(label)} — done.`
}
