import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { getDb } from './db'
import type { Item, Reminder } from '../shared/types'

const nowIso = (): string => new Date().toISOString()

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
 * Creates an item and, optionally, one reminder for it — inside a single transaction.
 * remindAtLocal is a wall-clock string from <input type="datetime-local"> (e.g. "2026-09-15T17:30"),
 * interpreted in the machine's current zone and stored as UTC.
 */
export function createItemWithReminder(
  title: string,
  remindAtLocal: string | null
): { item: Item; reminder: Reminder | null } {
  const db = getDb()
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title is required')

  let fireAtUtc: string | null = null
  const zone = DateTime.local().zoneName
  if (remindAtLocal) {
    const dt = DateTime.fromISO(remindAtLocal, { zone })
    if (!dt.isValid) throw new Error(`Could not understand the time "${remindAtLocal}"`)
    fireAtUtc = dt.toUTC().toISO()!
  }

  const tx = db.transaction(() => {
    const itemId = randomUUID()
    const ts = nowIso()
    db.prepare(
      `INSERT INTO items (id, kind, title, status, due_at_utc, due_tz, due_precision, importance, is_suggestion, created_at, updated_at)
       VALUES (?, 'task', ?, 'open', ?, ?, ?, 2, 0, ?, ?)`
    ).run(itemId, trimmed, fireAtUtc, fireAtUtc ? zone : null, fireAtUtc ? 'exact' : null, ts, ts)

    let reminder: Reminder | null = null
    if (fireAtUtc) {
      const rid = randomUUID()
      db.prepare(
        `INSERT INTO reminders (id, item_id, fire_at_utc, state, surfaced_count, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      ).run(rid, itemId, fireAtUtc, ts)
      reminder = getReminder(rid)!
    }
    return { item: getItem(itemId)!, reminder }
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

// ---------- Reminders ----------

export function listReminders(): Reminder[] {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title
       FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       ORDER BY r.fire_at_utc DESC LIMIT 200`
    )
    .all() as Reminder[]
}

export function getReminder(id: string): Reminder | undefined {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title FROM reminders r LEFT JOIN items i ON i.id = r.item_id WHERE r.id = ?`
    )
    .get(id) as Reminder | undefined
}

/** Reminders that should have fired by `nowUtc` and have not been handled. */
export function duePendingReminders(nowUtc: string): Reminder[] {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title
       FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       WHERE r.state = 'pending' AND r.fire_at_utc <= ?
       ORDER BY r.fire_at_utc ASC`
    )
    .all(nowUtc) as Reminder[]
}

export function nextPendingReminder(): Reminder | undefined {
  return getDb()
    .prepare(
      `SELECT r.*, i.title AS item_title FROM reminders r LEFT JOIN items i ON i.id = r.item_id
       WHERE r.state = 'pending' ORDER BY r.fire_at_utc ASC LIMIT 1`
    )
    .get() as Reminder | undefined
}

/**
 * Atomically moves a reminder from pending → delivered. Returns false if another
 * path already handled it (so a reminder can never be delivered twice).
 */
export function markDelivered(id: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE reminders SET state = 'delivered', delivered_at = ?, surfaced_count = surfaced_count + 1
       WHERE id = ? AND state = 'pending'`
    )
    .run(nowIso(), id)
  return res.changes === 1
}

export function acknowledgeReminder(id: string): void {
  getDb().prepare(`UPDATE reminders SET state = 'acknowledged' WHERE id = ? AND state = 'delivered'`).run(id)
}

export function cancelReminder(id: string): void {
  getDb().prepare(`UPDATE reminders SET state = 'cancelled' WHERE id = ? AND state IN ('pending','snoozed','delivered')`).run(id)
}

/** Convenience for testing: an item + reminder N minutes from now (N may be negative for "in the past"). */
export function createTestReminder(minutesFromNow: number): Reminder {
  const fireAt = DateTime.utc().plus({ minutes: minutesFromNow })
  const label =
    minutesFromNow >= 0
      ? `Test reminder (${minutesFromNow} min ahead)`
      : `Test reminder (${Math.abs(minutesFromNow)} min in the past)`
  const db = getDb()
  const tx = db.transaction(() => {
    const itemId = randomUUID()
    const rid = randomUUID()
    const ts = nowIso()
    db.prepare(
      `INSERT INTO items (id, kind, title, status, due_at_utc, due_tz, due_precision, importance, is_suggestion, created_at, updated_at)
       VALUES (?, 'task', ?, 'open', ?, ?, 'exact', 2, 0, ?, ?)`
    ).run(itemId, label, fireAt.toISO(), DateTime.local().zoneName, ts, ts)
    db.prepare(
      `INSERT INTO reminders (id, item_id, fire_at_utc, state, surfaced_count, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`
    ).run(rid, itemId, fireAt.toISO(), ts)
    return getReminder(rid)!
  })
  return tx()
}
