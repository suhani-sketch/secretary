import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { getDb } from './db'
import type {
  ChatMessage,
  DuePrecision,
  ExtractionEntry,
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
    `INSERT INTO items (id, kind, title, details, status, due_at_utc, due_tz, due_precision, importance, is_suggestion, confidence, waiting_on, source_msg_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    n.kind,
    title,
    n.details ?? null,
    n.dueAtUtc ?? null,
    n.dueAtUtc ? DateTime.local().zoneName : null,
    n.dueAtUtc ? (n.duePrecision ?? 'exact') : null,
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
  importance?: number
  waitingOn?: string | null
  kind?: ItemKind
  status?: ItemStatus
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
    set('due_precision', p.dueAtUtc ? (p.duePrecision ?? before.due_precision ?? 'exact') : null)
  } else if (p.duePrecision !== undefined) set('due_precision', p.duePrecision)
  if (p.importance !== undefined) set('importance', p.importance)
  if (p.waitingOn !== undefined) set('waiting_on', p.waitingOn)
  if (p.kind !== undefined) set('kind', p.kind)
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
      .prepare(`UPDATE reminders SET fire_at_utc = ? WHERE item_id = ? AND state = 'pending' AND fire_at_utc = ?`)
      .run(p.dueAtUtc, id, before.due_at_utc).changes
  }
  return { item: getItem(id)!, movedReminders: moved }
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

export function completeItem(id: string): void {
  const db = getDb()
  const ts = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE items SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id)
    // Completing an item cancels its still-pending reminders.
    db.prepare(`UPDATE reminders SET state = 'cancelled' WHERE item_id = ? AND state IN ('pending','snoozed')`).run(id)
  })
  tx()
}

export function cancelItem(id: string): void {
  const db = getDb()
  const ts = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE items SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(ts, id)
    db.prepare(`UPDATE reminders SET state = 'cancelled' WHERE item_id = ? AND state IN ('pending','snoozed')`).run(id)
  })
  tx()
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
      `SELECT * FROM items WHERE status = 'open' AND due_at_utc IS NOT NULL AND due_at_utc >= ? AND due_at_utc <= ?
       ORDER BY due_at_utc ASC LIMIT ?`
    )
    .all(fromUtc, toUtc, limit) as Item[]
}

export function openItemsOverdue(nowUtc: string, limit = 20): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status = 'open' AND due_at_utc IS NOT NULL AND due_at_utc < ? ORDER BY due_at_utc ASC LIMIT ?`)
    .all(nowUtc, limit) as Item[]
}

export function openWaitingItems(): Item[] {
  return getDb().prepare(`SELECT * FROM items WHERE status = 'open' AND kind = 'waiting' ORDER BY created_at DESC`).all() as Item[]
}

export function openItems(limit = 50): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status = 'open' ORDER BY COALESCE(due_at_utc, '9999') ASC, importance DESC LIMIT ?`)
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

// ---------- Reminders ----------

export function insertReminder(itemId: string, fireAtUtc: string): Reminder {
  const rid = randomUUID()
  getDb()
    .prepare(`INSERT INTO reminders (id, item_id, fire_at_utc, state, surfaced_count, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`)
    .run(rid, itemId, fireAtUtc, nowIso())
  return getReminder(rid)!
}

export function listReminders(): Reminder[] {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title
       FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       ORDER BY r.fire_at_utc DESC LIMIT 200`
    )
    .all() as Reminder[]
}

export function pendingRemindersForItems(itemIds: string[]): Reminder[] {
  if (itemIds.length === 0) return []
  const q = itemIds.map(() => '?').join(',')
  return getDb()
    .prepare(`SELECT * FROM reminders WHERE state IN ('pending','snoozed') AND item_id IN (${q}) ORDER BY fire_at_utc ASC`)
    .all(...itemIds) as Reminder[]
}

export function getReminder(id: string): Reminder | undefined {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title FROM reminders r LEFT JOIN items i ON i.id = r.item_id WHERE r.id = ?`
    )
    .get(id) as Reminder | undefined
}

export function updateReminderTime(id: string, fireAtUtc: string): Reminder {
  const res = getDb()
    .prepare(`UPDATE reminders SET fire_at_utc = ?, state = 'pending' WHERE id = ? AND state IN ('pending','snoozed','delivered','acknowledged')`)
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
    .prepare(
      `SELECT r.*, i.title AS item_title
       FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       WHERE r.state IN ('pending','snoozed') AND r.fire_at_utc <= ?
       ORDER BY r.fire_at_utc ASC`
    )
    .all(nowUtc) as Reminder[]
}

export function nextPendingReminder(): Reminder | undefined {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       WHERE r.state IN ('pending','snoozed') ORDER BY r.fire_at_utc ASC LIMIT 1`
    )
    .get() as Reminder | undefined
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
    .prepare(`UPDATE reminders SET state = 'cancelled' WHERE id = ? AND state IN ('pending','snoozed','delivered')`)
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

// ---------- Messages & extractions (Phase 1) ----------

export function insertMessage(role: MessageRole, content: string, tier: number | null): ChatMessage {
  const id = randomUUID()
  const ts = nowIso()
  getDb().prepare(`INSERT INTO messages (id, role, content, tier, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, role, content, tier, ts)
  return { id, role, content, tier, created_at: ts }
}

export function recentMessages(limit = 10): ChatMessage[] {
  const rows = getDb().prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).all(limit) as ChatMessage[]
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
