import { z } from 'zod'
import { DateTime } from 'luxon'
import { getDb } from '../db'
import { log } from '../log'
import * as repo from '../repo'
import { fmtLocal, pushFocus, shortId } from './context'
import type { ToolDefinition } from './provider'
import type { AppliedChange } from '../../shared/types'

/**
 * Tool layer (spec §4). Small, flat schemas. Every call is validated with Zod before it touches
 * the database; write tools run inside a transaction opened by the orchestrator.
 */

const LOCAL_TIME_DESC =
  'Local wall-clock time as "YYYY-MM-DDTHH:MM" in the user\'s timezone (e.g. "2026-09-17T15:00"). Never include a timezone suffix.'

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:MM').describe(LOCAL_TIME_DESC)
const idRef = z.string().min(6).max(36).describe('The 8-character id shown in square brackets, e.g. "a1b2c3d4".')
const kind = z.enum(['task', 'deadline', 'project', 'waiting', 'note', 'commitment', 'idea'])
const precision = z.enum(['exact', 'day', 'week', 'vague']).describe('How precise the due time is. "day" if only a date was given, "week"/"vague" for looser phrasing.')

export const toolSchemas = {
  create_item: z.object({
    kind: kind.describe('task = something to do; deadline = must be submitted/done by a time; waiting = waiting on someone; note/idea = information only; commitment = promised to someone.'),
    title: z.string().min(1).max(200).describe('Short imperative title, e.g. "Call the bank".'),
    details: z.string().max(2000).optional().describe('Extra context from the user, if any.'),
    due_at_local: localTime.optional().describe('When it is due, if the user gave a time or date. ' + LOCAL_TIME_DESC),
    due_precision: precision.optional(),
    importance: z.number().int().min(1).max(4).optional().describe('1 low, 2 normal (default), 3 high, 4 critical. Only set if the user signalled it.'),
    waiting_on: z.string().max(100).optional().describe('For kind=waiting: who or what is being waited on.'),
    remind_at_local: localTime.optional().describe('If the user asked to be reminded, when the reminder should fire. Usually equals due_at_local. ' + LOCAL_TIME_DESC)
  }),
  update_item: z.object({
    id: idRef,
    title: z.string().min(1).max(200).optional(),
    details: z.string().max(2000).nullable().optional(),
    due_at_local: localTime.nullable().optional().describe('New due time, or null to clear it. Pending reminders at the old due time move with it.'),
    due_precision: precision.optional(),
    importance: z.number().int().min(1).max(4).optional(),
    kind: kind.optional(),
    waiting_on: z.string().max(100).nullable().optional()
  }),
  complete_item: z.object({ id: idRef }),
  cancel_item: z.object({ id: idRef }).describe('Cancel an item the user no longer wants. Also cancels its reminders.'),
  create_reminder: z.object({
    item_id: idRef,
    fire_at_local: localTime
  }),
  update_reminder: z.object({
    id: idRef.describe('The reminder id (not the item id).'),
    fire_at_local: localTime
  }),
  cancel_reminder: z.object({ id: idRef.describe('The reminder id (not the item id). The item itself stays.') }),
  snooze_reminder: z.object({
    id: idRef.describe('The reminder id.'),
    minutes: z.number().int().min(1).max(60 * 24 * 14)
  }),
  get_item: z.object({ id: idRef }),
  search_memory: z.object({ query: z.string().min(1).max(200).describe('Words to look for in titles and details.') }),
  get_today: z.object({}),
  get_upcoming: z.object({ days: z.number().int().min(1).max(60).optional().describe('Default 7.') })
} as const

export type ToolName = keyof typeof toolSchemas

const descriptions: Record<ToolName, string> = {
  create_item: 'Record a new item the user mentioned (task, deadline, waiting-on, note, idea, commitment). Optionally with a due time and a reminder.',
  update_item: 'Change fields on an existing item: title, details, due time, importance, kind. Use for "move it to 4", "actually make it Tuesday", renames.',
  complete_item: 'Mark an item done ("done", "finished the CV").',
  cancel_item: 'Cancel an item entirely because the user no longer needs it.',
  create_reminder: 'Add a reminder to an existing item at a specific time.',
  update_reminder: 'Move an existing reminder to a new time.',
  cancel_reminder: 'Cancel a reminder while keeping the underlying item.',
  snooze_reminder: 'Push a reminder forward by a number of minutes from now.',
  get_item: 'Fetch full details for one item by id.',
  search_memory: 'Search saved items by keyword when the context above does not already include what you need.',
  get_today: 'List what is due or overdue today and what fires today.',
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
  'snooze_reminder'
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
      const dueUtc = x.due_at_local ? repo.localToUtc(x.due_at_local) : null
      const item = repo.insertItem({
        kind: x.kind,
        title: x.title,
        details: x.details ?? null,
        dueAtUtc: dueUtc,
        duePrecision: x.due_precision ?? (dueUtc ? 'exact' : null),
        importance: x.importance ?? null,
        waitingOn: x.waiting_on ?? null,
        sourceMsgId: sourceMsgId
      })
      const reminder = x.remind_at_local ? repo.insertReminder(item.id, repo.localToUtc(x.remind_at_local)) : null
      pushFocus(item.id, item.title, 'created')
      const summary =
        `Created ${item.kind} "${item.title}"` +
        (item.due_at_utc ? ` · due ${fmtLocal(item.due_at_utc)}` : '') +
        (reminder ? ` · reminder ${fmtLocal(reminder.fire_at_utc)}` : '')
      return {
        result: { ok: true, item_id: shortId(item.id), reminder_id: reminder ? shortId(reminder.id) : null, summary },
        applied: { tool: name, summary, itemId: item.id, reminderId: reminder?.id }
      }
    }
    case 'update_item': {
      const x = a as z.infer<typeof toolSchemas.update_item>
      const id = repo.resolveItemId(x.id)
      const patch: repo.ItemPatch = {}
      if (x.title !== undefined) patch.title = x.title
      if (x.details !== undefined) patch.details = x.details
      if (x.due_at_local !== undefined) patch.dueAtUtc = x.due_at_local ? repo.localToUtc(x.due_at_local) : null
      if (x.due_precision !== undefined) patch.duePrecision = x.due_precision
      if (x.importance !== undefined) patch.importance = x.importance
      if (x.kind !== undefined) patch.kind = x.kind
      if (x.waiting_on !== undefined) patch.waitingOn = x.waiting_on
      const { item, movedReminders } = repo.updateItem(id, patch)
      pushFocus(item.id, item.title, 'updated')
      const words: Record<string, string> = {
        title: 'title',
        details: 'details',
        dueAtUtc: 'due time',
        duePrecision: 'precision',
        importance: 'importance',
        kind: 'kind',
        waitingOn: 'waiting on'
      }
      const changed = Object.keys(patch)
        .map((k) => words[k] ?? k)
        .join(', ')
      const summary =
        `Updated "${item.title}" (${changed})` +
        (patch.dueAtUtc !== undefined ? ` · now due ${item.due_at_utc ? fmtLocal(item.due_at_utc) : 'no time'}` : '') +
        (movedReminders ? ` · moved ${movedReminders} reminder${movedReminders === 1 ? '' : 's'}` : '')
      return { result: { ok: true, item_id: shortId(item.id), summary }, applied: { tool: name, summary, itemId: item.id } }
    }
    case 'complete_item': {
      const x = a as z.infer<typeof toolSchemas.complete_item>
      const id = repo.resolveItemId(x.id)
      repo.completeItem(id)
      const item = repo.getItem(id)!
      pushFocus(item.id, item.title, 'completed')
      const summary = `Completed "${item.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: id } }
    }
    case 'cancel_item': {
      const x = a as z.infer<typeof toolSchemas.cancel_item>
      const id = repo.resolveItemId(x.id)
      repo.cancelItem(id)
      const item = repo.getItem(id)!
      pushFocus(item.id, item.title, 'cancelled')
      const summary = `Cancelled "${item.title}"`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: id } }
    }
    case 'create_reminder': {
      const x = a as z.infer<typeof toolSchemas.create_reminder>
      const itemId = repo.resolveItemId(x.item_id)
      const r = repo.insertReminder(itemId, repo.localToUtc(x.fire_at_local))
      const item = repo.getItem(itemId)!
      pushFocus(item.id, item.title, 'reminder added')
      const summary = `Reminder for "${item.title}" at ${fmtLocal(r.fire_at_utc)}`
      return { result: { ok: true, reminder_id: shortId(r.id), summary }, applied: { tool: name, summary, itemId, reminderId: r.id } }
    }
    case 'update_reminder': {
      const x = a as z.infer<typeof toolSchemas.update_reminder>
      const id = repo.resolveReminderId(x.id)
      const r = repo.updateReminderTime(id, repo.localToUtc(x.fire_at_local))
      if (r.item_id) pushFocus(r.item_id, r.item_title ?? 'Reminder', 'reminder moved')
      const summary = `Moved reminder for "${r.item_title ?? 'Reminder'}" to ${fmtLocal(r.fire_at_utc)}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: r.item_id ?? undefined, reminderId: id } }
    }
    case 'cancel_reminder': {
      const x = a as z.infer<typeof toolSchemas.cancel_reminder>
      const id = repo.resolveReminderId(x.id)
      const before = repo.getReminder(id)!
      repo.cancelReminder(id)
      if (before.item_id) pushFocus(before.item_id, before.item_title ?? 'Reminder', 'reminder cancelled')
      const summary = `Cancelled reminder for "${before.item_title ?? 'Reminder'}" (item kept)`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: before.item_id ?? undefined, reminderId: id } }
    }
    case 'snooze_reminder': {
      const x = a as z.infer<typeof toolSchemas.snooze_reminder>
      const id = repo.resolveReminderId(x.id)
      const r = repo.snoozeReminder(id, x.minutes)
      if (r.item_id) pushFocus(r.item_id, r.item_title ?? 'Reminder', 'reminder snoozed')
      const summary = `Snoozed reminder for "${r.item_title ?? 'Reminder'}" until ${fmtLocal(r.fire_at_utc)}`
      return { result: { ok: true, summary }, applied: { tool: name, summary, itemId: r.item_id ?? undefined, reminderId: id } }
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

function publicItem(i: repo.NewItem extends never ? never : import('../../shared/types').Item): Record<string, unknown> {
  return {
    id: shortId(i.id),
    kind: i.kind,
    title: i.title,
    details: i.details,
    status: i.status,
    due: i.due_at_utc ? fmtLocal(i.due_at_utc) : null,
    due_precision: i.due_precision,
    importance: i.importance,
    waiting_on: i.waiting_on
  }
}
function publicReminder(r: import('../../shared/types').Reminder): Record<string, unknown> {
  return { id: shortId(r.id), state: r.state, fires: fmtLocal(r.fire_at_utc) }
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
