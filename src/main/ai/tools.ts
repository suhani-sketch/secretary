import { z } from 'zod'
import { DateTime } from 'luxon'
import { getDb } from '../db'
import { log } from '../log'
import * as repo from '../repo'
import { pushFocus, shortId } from './context'
import { formatClock, formatDue } from '../../shared/format'
import type { ToolDefinition } from './provider'
import type { AppliedChange, Item, Reminder } from '../../shared/types'

/**
 * Tool layer (spec §4). Small, flat schemas. Every call is validated with Zod before it touches
 * the database; write tools run inside a transaction opened by the orchestrator.
 *
 * Time fields (spec invariant 1 — precision is always honest):
 *   *_at_local   = "YYYY-MM-DDTHH:MM"  → exact
 *   *_date_local = "YYYY-MM-DD"        → day (or week/vague if the phrasing was looser)
 * The model must never invent a clock time to satisfy a datetime field.
 */

const DT_DESC = 'Local wall-clock "YYYY-MM-DDTHH:MM" in the user\'s timezone, ONLY when the user stated a clock time. No timezone suffix.'
const DATE_DESC = 'Local date "YYYY-MM-DD", when the user gave a day but no clock time ("tomorrow", "Friday", "next week"). Never add a time.'

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:MM')
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const idRef = z.string().min(6).max(36).describe('The 8-character id shown in square brackets, e.g. "a1b2c3d4".')
const kind = z.enum(['task', 'deadline', 'project', 'waiting', 'note', 'commitment', 'idea'])
const loose = z.enum(['week', 'vague']).describe('Only with a date-only value: "week" for "sometime next week", "vague" for "at some point around then".')
const importance = z
  .number()
  .int()
  .min(1)
  .max(4)
  .describe('Inferred from how the user talks: 1 low ("maybe someday"), 2 normal (default), 3 high ("really need to"), 4 critical ("absolutely must, tonight"). Never ask the user for this.')

const dueFields = {
  due_at_local: localDateTime.optional().describe('Due time. ' + DT_DESC),
  due_date_local: localDate.optional().describe('Due day. ' + DATE_DESC),
  due_looseness: loose.optional()
}

const noBothDue = (v: { due_at_local?: string; due_date_local?: string }): boolean => !(v.due_at_local && v.due_date_local)

export const toolSchemas = {
  create_item: z
    .object({
      kind: kind.describe('task = something to do; deadline = must be submitted/done by a time; waiting = waiting on someone; note/idea = information only; commitment = promised to someone.'),
      title: z.string().min(1).max(200).describe('Short imperative title, e.g. "Call the bank".'),
      details: z.string().max(2000).optional().describe('Extra context from the user, if any.'),
      ...dueFields,
      importance: importance.optional(),
      waiting_on: z.string().max(100).optional().describe('For kind=waiting: who or what is being waited on.'),
      remind_at_local: localDateTime.optional().describe('Only if the user asked to be reminded AND gave a clock time. ' + DT_DESC),
      remind_date_local: localDate.optional().describe('Only if the user asked to be reminded on a day without a clock time; the reminder fires at their default reminder time. ' + DATE_DESC),
      is_suggestion: z.boolean().optional().describe('true if YOU are proposing this and the user did not state it. Suggestions are not obligations until confirmed.'),
      confidence: z.number().min(0).max(1).optional().describe('For suggestions: how sure you are the user meant this.')
    })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both')
    .refine((v) => !(v.remind_at_local && v.remind_date_local), 'Give either remind_at_local or remind_date_local, not both'),
  update_item: z
    .object({
      id: idRef,
      title: z.string().min(1).max(200).optional(),
      details: z.string().max(2000).nullable().optional(),
      due_at_local: localDateTime.optional().describe('New due time (moves pending reminders that sat on the old due time). ' + DT_DESC),
      due_date_local: localDate.optional().describe('New due day. ' + DATE_DESC),
      due_looseness: loose.optional(),
      clear_due: z.boolean().optional().describe('true to remove the due date entirely.'),
      importance: importance.optional().describe('Set when the user overrides ("that is not actually important").'),
      kind: kind.optional(),
      waiting_on: z.string().max(100).nullable().optional(),
      confirm_suggestion: z.boolean().optional().describe('true when the user confirms a suggested item — it becomes a real obligation.')
    })
    .refine(noBothDue, 'Give either due_at_local or due_date_local, not both'),
  complete_item: z.object({ id: idRef }),
  cancel_item: z.object({ id: idRef }).describe('Cancel ONE item the user no longer wants (status becomes cancelled, nothing is deleted). Its own reminders stop. Never use it to sweep away several things at once — cancel each, and ask first if the user names a project with parts.'),
  create_reminder: z
    .object({
      item_id: idRef,
      fire_at_local: localDateTime.optional().describe(DT_DESC),
      fire_date_local: localDate.optional().describe('Day without clock time; fires at the default reminder time. ' + DATE_DESC)
    })
    .refine((v) => !!v.fire_at_local !== !!v.fire_date_local, 'Give exactly one of fire_at_local or fire_date_local'),
  update_reminder: z.object({
    id: idRef.describe('The reminder id (not the item id).'),
    fire_at_local: localDateTime.describe(DT_DESC)
  }),
  cancel_reminder: z.object({ id: idRef.describe('The reminder id (not the item id). The item itself stays exactly as it is.') }),
  snooze_reminder: z.object({
    id: idRef.describe('The reminder id.'),
    minutes: z.number().int().min(1).max(60 * 24 * 14)
  }),
  set_preference: z.object({
    key: z
      .enum(['default_reminder_time', 'day_start', 'day_end', 'name'])
      .describe('default_reminder_time: "HH:MM" used when a reminder is asked for on a day with no clock time. day_start/day_end: "HH:MM". name: what to call the user.'),
    value: z.string().min(1).max(100)
  }),
  get_item: z.object({ id: idRef }),
  search_memory: z.object({ query: z.string().min(1).max(200).describe('Words to look for in titles and details.') }),
  get_today: z.object({}),
  get_upcoming: z.object({ days: z.number().int().min(1).max(60).optional().describe('Default 7.') })
} as const

export type ToolName = keyof typeof toolSchemas

const descriptions: Record<ToolName, string> = {
  create_item: 'Record a new item the user mentioned (task, deadline, waiting-on, note, idea, commitment), with an honest due precision and, only if asked, a reminder.',
  update_item: 'Change fields on an existing item: title, details, due day/time, importance, kind. Use for "move it to 4", "actually make it Tuesday", renames, confirming a suggestion.',
  complete_item: 'Mark an item done ("done", "finished the CV"). Its own pending reminders stop.',
  cancel_item: 'Cancel one item entirely because the user no longer needs it.',
  create_reminder: 'Add a reminder (alarm) to an existing item.',
  update_reminder: 'Move an existing reminder to a new clock time.',
  cancel_reminder: 'Cancel a reminder while keeping the underlying item untouched. Use for "cancel the reminder".',
  snooze_reminder: 'Push a reminder forward by a number of minutes from now.',
  set_preference: 'Remember a stated preference such as the default reminder time ("remind me at 8 by default").',
  get_item: 'Fetch full details for one item by id.',
  search_memory: 'Search saved items by keyword when the context above does not already include what you need.',
  get_today: 'List what is due or overdue today.',
  get_upcoming: 'List open items due in the next N days.'
}

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_item',
  'update_item',
  'complete_item',
  'cancel_item',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'snooze_reminder',
  'set_preference'
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

export interface ToolOutcome {
  /** What goes back to the model. */
  result: Record<string, unknown>
  /** What the UI shows as ground truth, for write tools only. */
  applied?: AppliedChange
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
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Validate and execute one tool call. Throws on validation or execution failure.
 * Write tools must be called inside a transaction (the orchestrator does this).
 */
export function executeTool(name: string, rawArgs: unknown, sourceMsgId: string | null): ToolOutcome {
  if (!(name in toolSchemas)) throw new ToolValidationError(`Unknown tool "${name}"`)
  const schema = toolSchemas[name as ToolName]
  const parsed = schema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ToolValidationError(`Invalid arguments for ${name}: ${issues}`)
  }
  const a = parsed.data as never
  switch (name as ToolName) {
    case 'create_item': {
      const x = a as z.infer<typeof toolSchemas.create_item>
      const due = repo.resolveDue(x.due_date_local, x.due_at_local, x.due_looseness)
      const item = repo.insertItem({
        kind: x.kind,
        title: x.title,
        details: x.details ?? null,
        dueAtUtc: due.dueAtUtc,
        duePrecision: due.precision,
        importance: x.importance ?? null,
        waitingOn: x.waiting_on ?? null,
        isSuggestion: x.is_suggestion ?? false,
        confidence: x.is_suggestion ? (x.confidence ?? 0.5) : null,
        sourceMsgId
      })
      let reminder: Reminder | null = null
      let reminderNote = ''
      if (x.remind_at_local) {
        reminder = repo.insertReminder(item.id, repo.localToUtc(x.remind_at_local))
      } else if (x.remind_date_local) {
        const r = reminderFromDate(x.remind_date_local)
        reminder = repo.insertReminder(item.id, r.fireAtUtc)
        reminderNote = ` ${r.note}`
      }
      pushFocus(item.id, item.title, x.is_suggestion ? 'suggested' : 'created')
      const summary =
        `${x.is_suggestion ? 'Suggested' : 'Created'} ${item.kind} "${item.title}"` +
        (item.due_at_utc ? ` · due ${dueText(item)}` : '') +
        (reminder ? ` · reminder ${formatClock(reminder.fire_at_utc)}${reminderNote}` : '')
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
        applied: { tool: name, summary, itemId: item.id, reminderId: reminder?.id }
      }
    }
    case 'update_item': {
      const x = a as z.infer<typeof toolSchemas.update_item>
      const id = repo.resolveItemId(x.id)
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
      if (x.importance !== undefined) (patch.importance = x.importance), changed.push('importance')
      if (x.kind !== undefined) (patch.kind = x.kind), changed.push('kind')
      if (x.waiting_on !== undefined) (patch.waitingOn = x.waiting_on), changed.push('waiting on')
      if (x.confirm_suggestion) (patch.isSuggestion = false), changed.push('confirmed')
      const { item, movedReminders } = repo.updateItem(id, patch)
      pushFocus(item.id, item.title, 'updated')
      const summary =
        `Updated "${item.title}" (${changed.join(', ') || 'nothing'})` +
        (patch.dueAtUtc !== undefined ? ` · now due ${item.due_at_utc ? dueText(item) : 'no date'}` : '') +
        (movedReminders ? ` · moved ${plural(movedReminders, 'reminder')} with it` : '')
      return {
        result: { ok: true, item_id: shortId(item.id), due: item.due_at_utc ? dueText(item) : null, due_precision: item.due_precision, moved_reminders: movedReminders, summary },
        applied: { tool: name, summary, itemId: item.id }
      }
    }
    case 'complete_item': {
      const x = a as z.infer<typeof toolSchemas.complete_item>
      const id = repo.resolveItemId(x.id)
      const { cancelledReminders } = repo.completeItem(id)
      const item = repo.getItem(id)!
      pushFocus(item.id, item.title, 'completed')
      const summary = `Completed "${item.title}"` + (cancelledReminders ? ` · its ${plural(cancelledReminders, 'reminder')} stopped` : '')
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: id } }
    }
    case 'cancel_item': {
      const x = a as z.infer<typeof toolSchemas.cancel_item>
      const id = repo.resolveItemId(x.id)
      const { cancelledReminders } = repo.cancelItem(id)
      const item = repo.getItem(id)!
      pushFocus(item.id, item.title, 'cancelled')
      const summary = `Cancelled "${item.title}"` + (cancelledReminders ? ` · its ${plural(cancelledReminders, 'reminder')} stopped` : '') + ' · nothing else touched'
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: id } }
    }
    case 'create_reminder': {
      const x = a as z.infer<typeof toolSchemas.create_reminder>
      const itemId = repo.resolveItemId(x.item_id)
      let note = ''
      let fireAt: string
      if (x.fire_at_local) fireAt = repo.localToUtc(x.fire_at_local)
      else {
        const r = reminderFromDate(x.fire_date_local!)
        fireAt = r.fireAtUtc
        note = ` ${r.note}`
      }
      const r = repo.insertReminder(itemId, fireAt)
      const item = repo.getItem(itemId)!
      pushFocus(item.id, item.title, 'reminder added')
      const summary = `Reminder for "${item.title}" ${formatClock(r.fire_at_utc)}${note}`
      return { result: { ok: true, reminder_id: shortId(r.id), fires: formatClock(r.fire_at_utc) + note, summary }, applied: { tool: name, summary, itemId, reminderId: r.id } }
    }
    case 'update_reminder': {
      const x = a as z.infer<typeof toolSchemas.update_reminder>
      const id = repo.resolveReminderId(x.id)
      const r = repo.updateReminderTime(id, repo.localToUtc(x.fire_at_local))
      if (r.item_id) pushFocus(r.item_id, r.item_title ?? 'Reminder', 'reminder moved')
      const summary = `Moved reminder for "${r.item_title ?? 'Reminder'}" to ${formatClock(r.fire_at_utc)}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: r.item_id ?? undefined, reminderId: id } }
    }
    case 'cancel_reminder': {
      const x = a as z.infer<typeof toolSchemas.cancel_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      repo.cancelReminder(id)
      if (before.item_id) pushFocus(before.item_id, before.item_title ?? 'Reminder', 'reminder cancelled')
      const summary = `Cancelled the reminder for "${before.item_title ?? 'Reminder'}" · the item itself is unchanged`
      return { result: { ok: true, item_still_open: true, summary }, applied: { tool: name, summary, itemId: before.item_id ?? undefined, reminderId: id } }
    }
    case 'snooze_reminder': {
      const x = a as z.infer<typeof toolSchemas.snooze_reminder>
      const id = repo.resolveReminderId(x.id)
      const r = repo.snoozeReminder(id, x.minutes)
      if (r.item_id) pushFocus(r.item_id, r.item_title ?? 'Reminder', 'reminder snoozed')
      const summary = `Snoozed reminder for "${r.item_title ?? 'Reminder'}" until ${formatClock(r.fire_at_utc)}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: r.item_id ?? undefined, reminderId: id } }
    }
    case 'set_preference': {
      const x = a as z.infer<typeof toolSchemas.set_preference>
      if (x.key !== 'name' && !/^\d{1,2}:\d{2}$/.test(x.value)) throw new ToolValidationError(`${x.key} must be "HH:MM"`)
      repo.setPreference(x.key, x.value, 'stated')
      const summary = `Remembered ${x.key.replace(/_/g, ' ')} = ${x.value}`
      return { result: { ok: true, summary }, applied: { tool: name, summary } }
    }
    case 'get_item': {
      const x = a as z.infer<typeof toolSchemas.get_item>
      const item = repo.getItem(repo.resolveItemId(x.id))!
      const rs = repo.pendingRemindersForItems([item.id])
      return { result: { item: publicItem(item), reminders: rs.map(publicReminder) } }
    }
    case 'search_memory': {
      const x = a as z.infer<typeof toolSchemas.search_memory>
      return { result: { items: repo.searchItems(x.query).map(publicItem) } }
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

function publicItem(i: Item): Record<string, unknown> {
  return {
    id: shortId(i.id),
    kind: i.kind,
    title: i.title,
    details: i.details,
    status: i.status,
    due: i.due_at_utc ? dueText(i) : null,
    due_precision: i.due_precision,
    importance: i.importance,
    is_suggestion: !!i.is_suggestion,
    waiting_on: i.waiting_on
  }
}
function publicReminder(r: Reminder): Record<string, unknown> {
  return { id: shortId(r.id), state: r.state, fires: formatClock(r.fire_at_utc) }
}

/** Run `fn` inside one SQLite transaction; anything thrown rolls everything back. */
export function inTransaction<T>(fn: () => T): T {
  const tx = getDb().transaction(fn)
  try {
    return tx()
  } catch (e) {
    log('warn', 'tools.rolled_back', (e as Error).message)
    throw e
  }
}
