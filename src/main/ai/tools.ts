import { z } from 'zod'
import { DateTime } from 'luxon'
import { describeRRule as describeRule, firstOccurrence, normalizeRRule } from '../recurrence'
import { getDb } from '../db'
import { log } from '../log'
import * as repo from '../repo'
import { clearOffer, getFocus, pushFocus, setOffer, shortId } from './context'
import { resolveEntity } from '../entity'
import { formatClock, formatDue } from '../../shared/format'
import type { ToolDefinition } from './provider'
import type { Actor, AppliedChange, Item, Reminder } from '../../shared/types'

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
const kind = z.enum(['task', 'deadline', 'project', 'waiting', 'note', 'commitment', 'idea', 'checklist_item'])
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
  hardness: hardness.optional()
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
      rrule: rruleStr.optional()
    })
    .refine((v) => !!v.fire_at_local !== !!v.fire_date_local, 'Give exactly one of fire_at_local or fire_date_local'),
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
  get_project: 'Read one project: its fields, parts and history.',
  complete_item: 'Mark an item done ("done", "finished the CV"). Its own pending reminders stop.',
  cancel_item: 'Cancel ONE item the user no longer wants (status becomes cancelled, nothing is deleted). Its own reminders stop. Projects with parts require confirmation first.',
  delete_item: 'Permanently delete an item. Always requires confirmation. Prefer cancel_item.',
  create_reminder: 'Add a reminder (alarm) to an existing item, optionally recurring.',
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
      const parts = repo.projectParts(id)
      const history = repo.activitiesForProject(id, 30)
      return { result: { project: publicItem(p), parts: parts.map(publicItem), history: history.map((h) => `${h.created_at.slice(0, 16).replace('T', ' ')} · ${h.actor}: ${h.summary}`) } }
    }
    case 'create_item': {
      const x = a as z.infer<typeof toolSchemas.create_item>
      const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
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
            ? `Noted "${item.title}"${project ? ` under "${project.title}"` : ''}, due ${dueText(item)}${item.due_precision === 'day' ? ' (no time set)' : ''}.${offer}`
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
      act({ targetType: 'item', targetId: id, verb: 'completed', summary: `Completed "${item.title}"${cancelledReminders ? ` (${plural(cancelledReminders, 'reminder')} stopped)` : ''}`, before: { item: before, stopped: stoppedIds }, after: item })
      pushFocus(item.id, item.title, 'completed')
      clearOffer()
      const summary = `Completed "${item.title}"` + (cancelledReminders ? ` · its ${plural(cancelledReminders, 'reminder')} stopped` : '')
      const phrase = `Marked "${item.title}" done.${cancelledReminders ? ` Its ${plural(cancelledReminders, 'reminder')} won't fire.` : ''}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, phrase, itemId: id } }
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
              (parts.length ? `? Its ${plural(parts.length, 'part')} (${parts.map((p) => p.title).join(', ')}) would stay but no longer belong to anything` : '') +
              `? Cancelling instead keeps the history.`,
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
      const r = repo.insertReminder(itemId, fireAt, rr ? { rrule: rr, seriesAnchorLocal: x.fire_at_local ?? undefined, seriesTz: DateTime.local().zoneName } : {})
      const item = repo.getItem(itemId)!
      act({ targetType: 'reminder', targetId: r.id, verb: 'created', summary: `Reminder set for "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}`, after: strip(r) })
      pushFocus(item.id, item.title, 'reminder added')
      clearOffer()
      const summary = `Reminder for "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}${note}`
      const phrase = `I'll remind you about "${item.title}" ${formatClock(r.fire_at_utc)}${describeRRule(rr)}${note}.`
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
      repo.insertActivity({
        targetType: item ? 'item' : 'date',
        targetId: item ? item.id : today,
        verb: 'completed',
        actor: ctx.actor,
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
        waiting = repo.insertItem({ kind: 'waiting', title: `Waiting on ${x.now_waiting_on}${item ? ` — ${item.title}` : ''}`, waitingOn: x.now_waiting_on, sourceMsgId: ctx.sourceMsgId })
        act({ targetType: 'item', targetId: waiting.id, verb: 'created', summary: `Waiting on ${x.now_waiting_on}`, after: waiting })
        pushFocus(waiting.id, waiting.title, 'created')
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
      repo.insertActivity({ targetType: last.target_type, targetId: last.target_id, verb: 'undone', actor: ctx.actor, summary: `Undid: ${last.summary}`, before: last.after_json ? JSON.parse(last.after_json) : null, after: last.before_json ? JSON.parse(last.before_json) : null, reversible: false })
      clearOffer()
      const summary = `Undid: ${last.summary}`
      return { result: { ok: true, summary, restored: undone }, applied: { tool: name, summary, phrase: `Undone — ${lowerFirst(undone)}.` } }
    }
    case 'get_item': {
      const x = a as z.infer<typeof toolSchemas.get_item>
      const item = repo.getItem(repo.resolveItemId(x.id))!
      const rs = repo.pendingRemindersForItems([item.id])
      return { result: { item: publicItem(item), reminders: rs.map(publicReminder), history: repo.activitiesFor('item', item.id, 10).map((h) => `${h.created_at.slice(0, 10)} ${h.summary}`) } }
    }
    case 'search_memory': {
      const x = a as z.infer<typeof toolSchemas.search_memory>
      return { result: { items: repo.searchItems(x.query).map(publicItem) } }
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
  return {
    id: shortId(i.id),
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
