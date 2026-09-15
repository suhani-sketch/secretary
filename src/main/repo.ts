import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { getDb } from './db'
import type {
  Activity,
  Actor,
  ChatMessage,
  DuePrecision,
  ExtractionEntry,
  Hardness,
  Item,
  ItemKind,
  ItemStatus,
  MessageRole,
  Reminder
} from '../shared/types'

const nowIso = (): string => new Date().toISOString()

/** Converts a local wall-clock ISO string ("2026-09-17T15:00") to UTC ISO, or throws. */
export function localToUtc(local: string): string {
  const dt = DateTime.fromISO(local, { zone: DateTime.local().zoneName })
  if (!dt.isValid) throw new Error(`Could not understand the time "${local}"`)
  return dt.toUTC().toISO()!
}

/**
 * Honest due handling (spec invariant 1). A date-only value is stored as the start of that local day
 * with `day` precision (or looser if asked). A date-time is `exact`. No clock time is ever invented.
 */
export function resolveDue(
  dateOnly: string | undefined | null,
  dateTime: string | undefined | null,
  loose?: 'week' | 'vague' | null
): { dueAtUtc: string | null; precision: DuePrecision | null } {
  if (dateTime) return { dueAtUtc: localToUtc(dateTime), precision: 'exact' }
  if (dateOnly) {
    const dt = DateTime.fromISO(dateOnly, { zone: DateTime.local().zoneName }).startOf('day')
    if (!dt.isValid) throw new Error(`Could not understand the date "${dateOnly}"`)
    return { dueAtUtc: dt.toUTC().toISO()!, precision: loose ?? 'day' }
  }
  return { dueAtUtc: null, precision: null }
}

/** "HH:MM" preference with a default; used when a reminder is asked for on a day with no stated time. */
export function getPreference(key: string, fallback: string): { value: string; stated: boolean } {
  const row = getDb().prepare('SELECT value, source FROM preferences WHERE key = ?').get(key) as
    | { value: string; source: string }
    | undefined
  return row ? { value: row.value, stated: row.source === 'stated' } : { value: fallback, stated: false }
}

export function setPreference(key: string, value: string, source: 'stated' | 'inferred'): void {
  getDb()
    .prepare(`INSERT INTO preferences (key, value, source, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source`)
    .run(key, value, source, nowIso())
}

/** Combine a local date ("2026-09-16") with an "HH:MM" clock into a UTC instant. */
export function dateAtClockToUtc(dateOnly: string, clock: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim())
  if (!m) throw new Error(`Bad clock time "${clock}"`)
  const dt = DateTime.fromISO(dateOnly, { zone: DateTime.local().zoneName }).set({
    hour: Number(m[1]),
    minute: Number(m[2]),
    second: 0,
    millisecond: 0
  })
  if (!dt.isValid) throw new Error(`Could not understand the date "${dateOnly}"`)
  return dt.toUTC().toISO()!
}

// ---------- Items ----------

export function listItems(): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status != 'archived' ORDER BY created_at DESC LIMIT 200`)
    .all() as Item[]
}

export function getItem(id: string): Item | undefined {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined
}

/**
 * The model refers to items by an 8-character id prefix. Resolve to a full id;
 * throw if it matches nothing or more than one row.
 */
export function resolveItemId(ref: string): string {
  const rows = getDb().prepare('SELECT id FROM items WHERE id LIKE ?').all(`${ref.trim()}%`) as { id: string }[]
  if (rows.length === 1) return rows[0].id
  if (rows.length === 0) throw new Error(`No item with id "${ref}"`)
  throw new Error(`Ambiguous item id "${ref}"`)
}

export function resolveReminderId(ref: string): string {
  const rows = getDb().prepare('SELECT id FROM reminders WHERE id LIKE ?').all(`${ref.trim()}%`) as { id: string }[]
  if (rows.length === 1) return rows[0].id
  if (rows.length === 0) throw new Error(`No reminder with id "${ref}"`)
  throw new Error(`Ambiguous reminder id "${ref}"`)
}

export interface NewItem {
  kind: ItemKind
  title: string
  details?: string | null
  dueAtUtc?: string | null
  duePrecision?: DuePrecision | null
  hardness?: Hardness | null
  importance?: number | null
  waitingOn?: string | null
  isSuggestion?: boolean
  confidence?: number | null
  sourceMsgId?: string | null
}

/** Insert an item. Not wrapped in a transaction itself — callers compose transactions. */
export function insertItem(n: NewItem): Item {
  const db = getDb()
  const id = randomUUID()
  const ts = nowIso()
  const title = n.title.trim()
  if (!title) throw new Error('Title is required')
  db.prepare(
    `INSERT INTO items (id, kind, title, details, status, due_at_utc, due_tz, due_precision, hardness, importance, is_suggestion, confidence, waiting_on, source_msg_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    n.kind,
    title,
    n.details ?? null,
    n.dueAtUtc ?? null,
    n.dueAtUtc ? DateTime.local().zoneName : null,
    n.dueAtUtc ? (n.duePrecision ?? 'exact') : null,
    n.hardness ?? null,
    n.importance ?? 2,
    n.isSuggestion ? 1 : 0,
    n.confidence ?? null,
    n.waitingOn ?? null,
    n.sourceMsgId ?? null,
    ts,
    ts
  )
  return getItem(id)!
}

export interface ItemPatch {
  title?: string
  details?: string | null
  dueAtUtc?: string | null
  duePrecision?: DuePrecision | null
  hardness?: Hardness | null
  importance?: number
  waitingOn?: string | null
  kind?: ItemKind
  status?: ItemStatus
  /** false = the user confirmed a suggestion; it becomes a real obligation. */
  isSuggestion?: boolean
}

/**
 * Update fields on an item. If the due time changes, pending reminders that were sitting on
 * the old due time move with it (so "make it 4 instead" moves the reminder too).
 */
export function updateItem(id: string, p: ItemPatch): { item: Item; movedReminders: number } {
  const db = getDb()
  const before = getItem(id)
  if (!before) throw new Error(`No item ${id}`)
  const sets: string[] = []
  const vals: unknown[] = []
  const set = (col: string, v: unknown): void => {
    sets.push(`${col} = ?`)
    vals.push(v)
  }
  if (p.title !== undefined) set('title', p.title.trim())
  if (p.details !== undefined) set('details', p.details)
  if (p.dueAtUtc !== undefined) {
    set('due_at_utc', p.dueAtUtc)
    set('due_tz', p.dueAtUtc ? DateTime.local().zoneName : null)
    // Precision must accompany a new due value; never silently inherit "exact" onto a date-only value.
    set('due_precision', p.dueAtUtc ? (p.duePrecision ?? 'exact') : null)
  } else if (p.duePrecision !== undefined) set('due_precision', p.duePrecision)
  if (p.hardness !== undefined) set('hardness', p.hardness)
  if (p.importance !== undefined) set('importance', p.importance)
  if (p.waitingOn !== undefined) set('waiting_on', p.waitingOn)
  if (p.kind !== undefined) set('kind', p.kind)
  if (p.isSuggestion !== undefined) {
    set('is_suggestion', p.isSuggestion ? 1 : 0)
    if (!p.isSuggestion) set('confidence', null)
  }
  if (p.status !== undefined) {
    set('status', p.status)
    set('completed_at', p.status === 'done' ? nowIso() : null)
  }
  if (sets.length === 0) return { item: before, movedReminders: 0 }
  set('updated_at', nowIso())
  vals.push(id)
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

  let moved = 0
  if (p.dueAtUtc !== undefined && p.dueAtUtc && before.due_at_utc && p.dueAtUtc !== before.due_at_utc) {
    moved = db
      .prepare(
        `UPDATE reminders SET fire_at_utc = ? WHERE target_type = 'item' AND target_id = ? AND state = 'pending' AND fire_at_utc = ?`
      )
      .run(p.dueAtUtc, id, before.due_at_utc).changes
  }
  return { item: getItem(id)!, movedReminders: moved }
}

/** Restore a full item row (used by undo). */
export function restoreItem(row: Item): void {
  const cols = Object.keys(row) as (keyof Item)[]
  const sets = cols.filter((c) => c !== 'id').map((c) => `${c} = ?`)
  getDb()
    .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`)
    .run(...cols.filter((c) => c !== 'id').map((c) => row[c]), row.id)
}

/** Hard delete (only for undoing a creation, or an explicit, confirmed delete). */
export function deleteItemRow(id: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM reminders WHERE target_type = 'item' AND target_id = ?`).run(id)
  db.prepare(`DELETE FROM items WHERE id = ?`).run(id)
}

/**
 * Creates an item and, optionally, one reminder for it — inside a single transaction.
 * remindAtLocal is a wall-clock string from <input type="datetime-local"> (e.g. "2026-09-15T17:30").
 */
export function createItemWithReminder(
  title: string,
  remindAtLocal: string | null
): { item: Item; reminder: Reminder | null } {
  const db = getDb()
  const fireAtUtc = remindAtLocal ? localToUtc(remindAtLocal) : null
  const tx = db.transaction(() => {
    const item = insertItem({ kind: 'task', title, dueAtUtc: fireAtUtc, duePrecision: 'exact' })
    const reminder = fireAtUtc ? insertReminder(item.id, fireAtUtc) : null
    return { item, reminder }
  })
  return tx()
}

/**
 * Completing an item also retires its own still-pending alarms (they are attached to it, not independent),
 * and reports how many so the user is told (spec invariant 5: nothing destroyed silently). Never touches other items.
 */
function stopLiveReminders(itemId: string): string[] {
  const db = getDb()
  const ids = (
    db
      .prepare(`SELECT id FROM reminders WHERE target_type = 'item' AND target_id = ? AND state IN ('pending','snoozed','paused')`)
      .all(itemId) as { id: string }[]
  ).map((r) => r.id)
  for (const rid of ids) db.prepare(`UPDATE reminders SET state = 'cancelled' WHERE id = ?`).run(rid)
  return ids
}

export function completeItem(id: string): { cancelledReminders: number; stoppedIds: string[] } {
  const db = getDb()
  const ts = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE items SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id)
    const stoppedIds = stopLiveReminders(id)
    return { cancelledReminders: stoppedIds.length, stoppedIds }
  })
  return tx()
}

/** Cancels exactly this one item (status, never deletion) plus its own pending alarms. Linked items are untouched. */
export function cancelItem(id: string): { cancelledReminders: number; stoppedIds: string[] } {
  const db = getDb()
  const ts = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE items SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(ts, id)
    const stoppedIds = stopLiveReminders(id)
    return { cancelledReminders: stoppedIds.length, stoppedIds }
  })
  return tx()
}

/** Undo helper: bring back exactly the alarms a complete/cancel stopped, and nothing else. */
export function reviveReminders(ids: string[]): void {
  for (const rid of ids) getDb().prepare(`UPDATE reminders SET state = 'pending' WHERE id = ? AND state = 'cancelled'`).run(rid)
}

/** Items linked to this one as parts (part_of → this). Used to size the blast radius of a cancel. */
export function childItems(id: string): Item[] {
  return getDb()
    .prepare(`SELECT i.* FROM links l JOIN items i ON i.id = l.from_item WHERE l.to_item = ? AND l.type = 'part_of' AND i.status NOT IN ('cancelled','archived')`)
    .all(id) as Item[]
}

// ---------- Context queries (spec §4 "Context assembly") ----------

export function itemsModifiedSince(utcIso: string, limit = 40): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
    .all(utcIso, limit) as Item[]
}

export function itemsDueBetween(fromUtc: string, toUtc: string, limit = 40): Item[] {
  return getDb()
    .prepare(
      `SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') AND due_at_utc IS NOT NULL AND due_at_utc >= ? AND due_at_utc <= ?
       ORDER BY due_at_utc ASC LIMIT ?`
    )
    .all(fromUtc, toUtc, limit) as Item[]
}

export function openItemsOverdue(nowUtc: string, limit = 20): Item[] {
  return getDb()
    .prepare(
      `SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') AND due_at_utc IS NOT NULL AND due_at_utc < ? ORDER BY due_at_utc ASC LIMIT ?`
    )
    .all(nowUtc, limit) as Item[]
}

export function openWaitingItems(): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') AND (kind = 'waiting' OR status = 'waiting') ORDER BY created_at DESC`)
    .all() as Item[]
}

export function openItems(limit = 50): Item[] {
  return getDb()
    .prepare(
      `SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') ORDER BY COALESCE(due_at_utc, '9999') ASC, importance DESC LIMIT ?`
    )
    .all(limit) as Item[]
}

export function searchItems(query: string, limit = 20): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
  if (words.length === 0) return []
  const where = words.map(() => `(LOWER(title) LIKE ? OR LOWER(details) LIKE ?)`).join(' OR ')
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`])
  return getDb()
    .prepare(`SELECT * FROM items WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, limit) as Item[]
}

export function listPreferences(): { key: string; value: string; source: string }[] {
  return getDb().prepare('SELECT key, value, source FROM preferences').all() as { key: string; value: string; source: string }[]
}

export function activeConstraints(): { kind: string; label: string; starts_at: string | null; ends_at: string | null; rrule: string | null; source: string }[] {
  return getDb()
    .prepare(`SELECT kind, label, starts_at, ends_at, rrule, source FROM constraints WHERE ends_at IS NULL OR ends_at >= ? ORDER BY starts_at`)
    .all(nowIso()) as never
}

export function eventsBetween(fromUtc: string, toUtc: string): { id: string; title: string; starts_at_utc: string; ends_at_utc: string | null; all_day: number }[] {
  return getDb()
    .prepare(`SELECT id, title, starts_at_utc, ends_at_utc, all_day FROM events WHERE starts_at_utc <= ? AND COALESCE(ends_at_utc, starts_at_utc) >= ? ORDER BY starts_at_utc`)
    .all(toUtc, fromUtc) as never
}

// ---------- Reminders ----------

const REMINDER_SELECT = `SELECT r.*, i.title AS item_title
  FROM reminders r LEFT JOIN items i ON r.target_type = 'item' AND i.id = r.target_id`

export function insertReminder(itemId: string, fireAtUtc: string, opts: { rrule?: string | null; offsetMinutes?: number | null } = {}): Reminder {
  const rid = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO reminders (id, target_type, target_id, fire_at_utc, rrule, offset_minutes, state, surfaced_count, created_at)
       VALUES (?, 'item', ?, ?, ?, ?, 'pending', 0, ?)`
    )
    .run(rid, itemId, fireAtUtc, opts.rrule ?? null, opts.offsetMinutes ?? null, nowIso())
  return getReminder(rid)!
}

export function listReminders(): Reminder[] {
  return getDb().prepare(`${REMINDER_SELECT} ORDER BY r.fire_at_utc DESC LIMIT 200`).all() as Reminder[]
}

export function pendingRemindersForItems(itemIds: string[]): Reminder[] {
  if (itemIds.length === 0) return []
  const q = itemIds.map(() => '?').join(',')
  return getDb()
    .prepare(`${REMINDER_SELECT} WHERE r.state IN ('pending','snoozed','paused') AND r.target_type = 'item' AND r.target_id IN (${q}) ORDER BY r.fire_at_utc ASC`)
    .all(...itemIds) as Reminder[]
}

export function getReminder(id: string): Reminder | undefined {
  return getDb().prepare(`${REMINDER_SELECT} WHERE r.id = ?`).get(id) as Reminder | undefined
}

export interface ReminderPatch {
  fireAtUtc?: string
  rrule?: string | null
  state?: Reminder['state']
}

export function updateReminder(id: string, p: ReminderPatch): Reminder {
  const sets: string[] = []
  const vals: unknown[] = []
  if (p.fireAtUtc !== undefined) (sets.push('fire_at_utc = ?'), vals.push(p.fireAtUtc))
  if (p.rrule !== undefined) (sets.push('rrule = ?'), vals.push(p.rrule))
  if (p.state !== undefined) (sets.push('state = ?'), vals.push(p.state))
  if (!sets.length) return getReminder(id)!
  vals.push(id)
  getDb().prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getReminder(id)!
}

export function restoreReminder(row: Reminder): void {
  const { item_title: _t, ...r } = row
  const cols = Object.keys(r) as (keyof typeof r)[]
  getDb()
    .prepare(`INSERT OR REPLACE INTO reminders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => r[c]))
}

export function deleteReminderRow(id: string): void {
  getDb().prepare('DELETE FROM reminders WHERE id = ?').run(id)
}

export function updateReminderTime(id: string, fireAtUtc: string): Reminder {
  const res = getDb()
    .prepare(`UPDATE reminders SET fire_at_utc = ?, state = 'pending' WHERE id = ? AND state IN ('pending','snoozed','delivered','acknowledged','paused')`)
    .run(fireAtUtc, id)
  if (res.changes !== 1) throw new Error('Reminder is cancelled and cannot be moved')
  return getReminder(id)!
}

export function snoozeReminder(id: string, minutes: number): Reminder {
  const fireAt = DateTime.utc().plus({ minutes }).toISO()!
  const res = getDb()
    .prepare(`UPDATE reminders SET fire_at_utc = ?, state = 'snoozed' WHERE id = ? AND state IN ('pending','snoozed','delivered','acknowledged')`)
    .run(fireAt, id)
  if (res.changes !== 1) throw new Error('Reminder is cancelled and cannot be snoozed')
  return getReminder(id)!
}

/** Reminders that should have fired by `nowUtc` and have not been handled. */
export function duePendingReminders(nowUtc: string): Reminder[] {
  return getDb()
    .prepare(`${REMINDER_SELECT} WHERE r.state IN ('pending','snoozed') AND r.fire_at_utc <= ? ORDER BY r.fire_at_utc ASC`)
    .all(nowUtc) as Reminder[]
}

export function nextPendingReminder(): Reminder | undefined {
  return getDb()
    .prepare(`${REMINDER_SELECT} WHERE r.state IN ('pending','snoozed') ORDER BY r.fire_at_utc ASC LIMIT 1`)
    .get() as Reminder | undefined
}

/** Upcoming alarms (for the Coming Up rail). */
export function upcomingReminders(untilUtc: string, limit = 20): Reminder[] {
  return getDb()
    .prepare(`${REMINDER_SELECT} WHERE r.state IN ('pending','snoozed') AND r.fire_at_utc <= ? ORDER BY r.fire_at_utc ASC LIMIT ?`)
    .all(untilUtc, limit) as Reminder[]
}

/**
 * Atomically moves a reminder from pending/snoozed → delivered. Returns false if another
 * path already handled it (so a reminder can never be delivered twice).
 */
export function markDelivered(id: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE reminders SET state = 'delivered', delivered_at = ?, surfaced_count = surfaced_count + 1
       WHERE id = ? AND state IN ('pending','snoozed')`
    )
    .run(nowIso(), id)
  return res.changes === 1
}

export function acknowledgeReminder(id: string): void {
  getDb().prepare(`UPDATE reminders SET state = 'acknowledged' WHERE id = ? AND state = 'delivered'`).run(id)
}

export function cancelReminder(id: string): void {
  getDb()
    .prepare(`UPDATE reminders SET state = 'cancelled' WHERE id = ? AND state IN ('pending','snoozed','delivered','paused')`)
    .run(id)
}

/** Convenience for testing: an item + reminder N minutes from now (N may be negative for "in the past"). */
export function createTestReminder(minutesFromNow: number): Reminder {
  const fireAt = DateTime.utc().plus({ minutes: minutesFromNow }).toISO()!
  const label =
    minutesFromNow >= 0
      ? `Test reminder (${minutesFromNow} min ahead)`
      : `Test reminder (${Math.abs(minutesFromNow)} min in the past)`
  const tx = getDb().transaction(() => {
    const item = insertItem({ kind: 'task', title: label, dueAtUtc: fireAt, duePrecision: 'exact' })
    return insertReminder(item.id, fireAt)
  })
  return tx()
}

// ---------- Activities (history; basis for undo) ----------

export interface NewActivity {
  targetType: string
  targetId: string
  projectId?: string | null
  verb: string
  actor: Actor
  summary: string
  before?: unknown
  after?: unknown
  reversible?: boolean
}

export function insertActivity(a: NewActivity): Activity {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO activities (id, target_type, target_id, project_id, verb, actor, summary, before_json, after_json, reversible, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      a.targetType,
      a.targetId,
      a.projectId ?? null,
      a.verb,
      a.actor,
      a.summary,
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
      a.reversible === false ? 0 : 1,
      nowIso()
    )
  return getDb().prepare('SELECT * FROM activities WHERE id = ?').get(id) as Activity
}

export function listActivities(limit = 50): Activity[] {
  return getDb().prepare('SELECT * FROM activities ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Activity[]
}

export function activitiesFor(targetType: string, targetId: string, limit = 50): Activity[] {
  return getDb()
    .prepare('SELECT * FROM activities WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(targetType, targetId, limit) as Activity[]
}

/** The most recent reversible activity performed by a person or the assistant (never system/scheduler noise). */
export function lastUndoableActivity(): Activity | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM activities WHERE reversible = 1 AND actor IN ('user','assistant') AND verb != 'undone'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get() as Activity | undefined
}

export function markActivityIrreversible(id: string): void {
  getDb().prepare('UPDATE activities SET reversible = 0 WHERE id = ?').run(id)
}

// ---------- Messages & extractions ----------

export function insertMessage(role: MessageRole, content: string, tier: number | null): ChatMessage {
  const id = randomUUID()
  const ts = nowIso()
  getDb().prepare(`INSERT INTO messages (id, role, content, tier, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, role, content, tier, ts)
  return { id, role, content, tier, created_at: ts }
}

export function updateMessageContent(id: string, content: string): void {
  getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id)
}

export function recentMessages(limit = 10): ChatMessage[] {
  const rows = getDb().prepare(`SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as ChatMessage[]
  return rows.reverse()
}

export function insertExtraction(messageId: string | null, toolsJson: string, applied: boolean, error: string | null): void {
  getDb()
    .prepare(`INSERT INTO extractions (id, message_id, tools_json, applied, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), messageId, toolsJson, applied ? 1 : 0, error, nowIso())
}

export function listExtractions(limit = 30): ExtractionEntry[] {
  return getDb().prepare(`SELECT * FROM extractions ORDER BY created_at DESC LIMIT ?`).all(limit) as ExtractionEntry[]
}
