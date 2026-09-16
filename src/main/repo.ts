import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { getDb } from './db'
import type {
  Happening,
  Activity,
  Actor,
  ChatMessage,
  Constraint,
  DuePrecision,
  ExtractionEntry,
  Hardness,
  Item,
  ItemKind,
  ItemStatus,
  MessageRole,
  Note,
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
  // Every foreign key that can point at an item (see PRAGMA foreign_key_list): links cascade; activities.project_id and
  // events.project_id are NO ACTION and must be released first. History and events keep their rows.
  db.prepare(`UPDATE activities SET project_id = NULL WHERE project_id = ?`).run(id)
  db.prepare(`UPDATE events SET project_id = NULL WHERE project_id = ?`).run(id)
  db.prepare(`DELETE FROM links WHERE from_item = ? OR to_item = ?`).run(id, id)
  db.prepare(`DELETE FROM items WHERE id = ?`).run(id)
}

/** Everything a deletion detaches from an item, captured so undo can put it all back. */
export interface DeletionSnapshot {
  item: Item
  reminders: Omit<Reminder, 'item_title'>[]
  links: { from_item: string; to_item: string; type: string }[]
  activityIds: string[]
  eventIds: string[]
}

export function snapshotForDeletion(id: string): DeletionSnapshot {
  const db = getDb()
  const item = getItem(id)
  if (!item) throw new Error(`No item ${id}`)
  return {
    item,
    reminders: (db.prepare(`SELECT * FROM reminders WHERE target_type = 'item' AND target_id = ?`).all(id) as Reminder[]).map((r) => {
      const { item_title: _t, ...rest } = r
      return rest
    }),
    links: db.prepare(`SELECT from_item, to_item, type FROM links WHERE from_item = ? OR to_item = ?`).all(id, id) as never,
    activityIds: (db.prepare(`SELECT id FROM activities WHERE project_id = ?`).all(id) as { id: string }[]).map((r) => r.id),
    eventIds: (db.prepare(`SELECT id FROM events WHERE project_id = ?`).all(id) as { id: string }[]).map((r) => r.id)
  }
}

/** Reverse of deleteItemRow: the row, its alarms, its links and the pointers that were released. */
export function restoreFromSnapshot(s: DeletionSnapshot): void {
  const db = getDb()
  const cols = Object.keys(s.item) as (keyof Item)[]
  db.prepare(`INSERT OR REPLACE INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => s.item[c]))
  for (const r of s.reminders) restoreReminder(r as Reminder)
  for (const l of s.links) {
    if (getItem(l.from_item) && getItem(l.to_item)) addLink(l.from_item, l.to_item, l.type as 'part_of')
  }
  for (const aid of s.activityIds) db.prepare(`UPDATE activities SET project_id = ? WHERE id = ?`).run(s.item.id, aid)
  for (const eid of s.eventIds) db.prepare(`UPDATE events SET project_id = ? WHERE id = ?`).run(s.item.id, eid)
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

// ---------- Projects / Things and links (spec §8 Phase 3a) ----------

const LIVE = "status NOT IN ('done','cancelled','archived')"

export function openProjects(limit = 100): Item[] {
  return getDb().prepare(`SELECT * FROM items WHERE kind = 'project' AND ${LIVE} ORDER BY updated_at DESC LIMIT ?`).all(limit) as Item[]
}

/** Items attached to a project via part_of, in checklist order then creation order. */
export function projectParts(projectId: string, includeClosed = true): Item[] {
  return getDb()
    .prepare(
      `SELECT i.* FROM links l JOIN items i ON i.id = l.from_item
       WHERE l.to_item = ? AND l.type = 'part_of' ${includeClosed ? '' : `AND i.${LIVE}`}
       ORDER BY COALESCE(i.sort_order, 1000000), i.created_at`
    )
    .all(projectId) as Item[]
}

/** Checklist rows of a project, in order. */
export function checklistItems(projectId: string, includeClosed = true): Item[] {
  return projectParts(projectId, includeClosed).filter((i) => i.kind === 'checklist_item')
}

export function nextSortOrder(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT MAX(i.sort_order) m FROM links l JOIN items i ON i.id = l.from_item WHERE l.to_item = ? AND l.type = 'part_of'`)
    .get(projectId) as { m: number | null }
  return (row.m ?? 0) + 1
}

export function setSortOrder(itemId: string, order: number): void {
  getDb().prepare(`UPDATE items SET sort_order = ?, updated_at = ? WHERE id = ?`).run(order, nowIso(), itemId)
}

/** All open checklist items across projects (for resolving "I sent the first email" without a named project). */
export function openChecklistItems(limit = 200): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE kind = 'checklist_item' AND ${LIVE} ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Item[]
}

export function parentProjectOf(itemId: string): Item | undefined {
  return getDb()
    .prepare(`SELECT p.* FROM links l JOIN items p ON p.id = l.to_item WHERE l.from_item = ? AND l.type = 'part_of' AND p.kind = 'project' LIMIT 1`)
    .get(itemId) as Item | undefined
}

export function addLink(fromItem: string, toItem: string, type: 'part_of' | 'blocks' | 'relates_to'): boolean {
  if (fromItem === toItem) throw new Error('An item cannot be linked to itself')
  const res = getDb()
    .prepare(`INSERT OR IGNORE INTO links (id, from_item, to_item, type, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), fromItem, toItem, type, nowIso())
  return res.changes === 1
}

export function removeLink(fromItem: string, toItem: string, type: string): boolean {
  return getDb().prepare(`DELETE FROM links WHERE from_item = ? AND to_item = ? AND type = ?`).run(fromItem, toItem, type).changes > 0
}

/** Move an item to a (different) project, or detach it when projectId is null. Returns the previous parent, if any. */
export function setParentProject(itemId: string, projectId: string | null): Item | undefined {
  const before = parentProjectOf(itemId)
  if (before) removeLink(itemId, before.id, 'part_of')
  if (projectId) addLink(itemId, projectId, 'part_of')
  return before
}

export function listLinks(): { from_item: string; to_item: string; type: string }[] {
  return getDb().prepare(`SELECT from_item, to_item, type FROM links`).all() as never
}

export function linksFor(itemId: string): { from_item: string; to_item: string; type: string }[] {
  return getDb().prepare(`SELECT from_item, to_item, type FROM links WHERE from_item = ? OR to_item = ?`).all(itemId, itemId) as never
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

/** Precision-aware: a day-only item is overdue only after that day has ended; week/vague after a week. */
export function openItemsOverdue(nowUtc: string, limit = 20): Item[] {
  const now = DateTime.fromISO(nowUtc, { zone: 'utc' })
  const dayCut = now.minus({ days: 1 }).toISO()!
  const weekCut = now.minus({ days: 7 }).toISO()!
  return getDb()
    .prepare(
      `SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') AND due_at_utc IS NOT NULL AND (
         (COALESCE(due_precision,'exact') = 'exact' AND due_at_utc < ?)
         OR (due_precision = 'day' AND due_at_utc <= ?)
         OR (due_precision IN ('week','vague') AND due_at_utc <= ?)
       ) ORDER BY due_at_utc ASC LIMIT ?`
    )
    .all(nowUtc, dayCut, weekCut, limit) as Item[]
}

export function openWaitingItems(): Item[] {
  return getDb()
    .prepare(`SELECT * FROM items WHERE status NOT IN ('done','cancelled','archived') AND (kind = 'waiting' OR status = 'waiting') ORDER BY created_at DESC`)
    .all() as Item[]
}

/** Open waiting items, optionally narrowed to a project (via part_of) or to who is being waited on. */
export function openWaitingFor(projectId?: string | null, who?: string | null): Item[] {
  let rows = openWaitingItems()
  if (projectId) {
    const partIds = new Set(projectParts(projectId, false).map((c) => c.id))
    rows = rows.filter((w) => partIds.has(w.id))
  }
  if (who) {
    const q = who.toLowerCase()
    rows = rows.filter((w) => (w.waiting_on ?? '').toLowerCase().includes(q) || q.includes((w.waiting_on ?? '').toLowerCase()))
  }
  return rows
}

/** Live conditional reminders whose condition points at this item. */
export function conditionalRemindersOn(itemId: string): Reminder[] {
  return getDb()
    .prepare(`${REMINDER_SELECT} WHERE r.state IN ('pending','snoozed','paused') AND r.condition_json LIKE ? ORDER BY r.fire_at_utc`)
    .all(`%${itemId}%`) as Reminder[]
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

/** Constraints still in force: standing (rrule) ones always; one-offs until their window has ended. */
export function activeConstraints(): Constraint[] {
  return getDb()
    .prepare(`SELECT * FROM constraints WHERE rrule IS NOT NULL OR ends_at IS NULL OR ends_at >= ? ORDER BY starts_at`)
    .all(nowIso()) as Constraint[]
}

export function insertConstraint(c: { kind: Constraint['kind']; label: string; startsAt: string | null; endsAt: string | null; rrule: string | null; source: Constraint['source'] }): Constraint {
  const id = randomUUID()
  getDb()
    .prepare(`INSERT INTO constraints (id, kind, label, starts_at, ends_at, rrule, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.kind, c.label.trim(), c.startsAt, c.endsAt, c.rrule, c.source, nowIso())
  return getConstraint(id)!
}

export function getConstraint(id: string): Constraint | undefined {
  return getDb().prepare('SELECT * FROM constraints WHERE id = ?').get(id) as Constraint | undefined
}

export function resolveConstraintId(ref: string): string {
  const rows = getDb().prepare('SELECT id FROM constraints WHERE id LIKE ?').all(`${ref.trim()}%`) as { id: string }[]
  if (rows.length === 1) return rows[0].id
  if (rows.length === 0) throw new Error(`No constraint with id "${ref}"`)
  throw new Error(`Ambiguous constraint id "${ref}"`)
}

export function deleteConstraintRow(id: string): void {
  getDb().prepare('DELETE FROM constraints WHERE id = ?').run(id)
}

export function restoreConstraint(c: Constraint): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO constraints (id, kind, label, starts_at, ends_at, rrule, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, c.kind, c.label, c.starts_at, c.ends_at, c.rrule, c.source, c.created_at)
}

// ---------- Dependencies (spec §8 3f): blocks links, computed in code ----------

const LIVE_I = "i.status NOT IN ('done','cancelled','archived')"

/** Open items that block this one (from_item blocks to_item). */
export function blockersOf(itemId: string): Item[] {
  return getDb()
    .prepare(`SELECT i.* FROM links l JOIN items i ON i.id = l.from_item WHERE l.to_item = ? AND l.type = 'blocks' AND ${LIVE_I} ORDER BY i.created_at`)
    .all(itemId) as Item[]
}

/** Open items this one blocks. */
export function blockedByThis(itemId: string): Item[] {
  return getDb()
    .prepare(`SELECT i.* FROM links l JOIN items i ON i.id = l.to_item WHERE l.from_item = ? AND l.type = 'blocks' AND ${LIVE_I} ORDER BY i.created_at`)
    .all(itemId) as Item[]
}

/** Items that were blocked only by `itemId` and are now free because it is done — for "that unblocks X". */
export function newlyUnblockedBy(itemId: string): Item[] {
  return blockedByThis(itemId).filter((b) => blockersOf(b.id).length === 0)
}

export function hasLink(fromItem: string, toItem: string, type: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM links WHERE from_item = ? AND to_item = ? AND type = ?').get(fromItem, toItem, type)
}

export function eventsBetween(fromUtc: string, toUtc: string): { id: string; title: string; starts_at_utc: string; ends_at_utc: string | null; all_day: number }[] {
  return getDb()
    .prepare(`SELECT id, title, starts_at_utc, ends_at_utc, all_day FROM events WHERE starts_at_utc <= ? AND COALESCE(ends_at_utc, starts_at_utc) >= ? ORDER BY starts_at_utc`)
    .all(toUtc, fromUtc) as never
}

// ---------- Reminders ----------

const REMINDER_SELECT = `SELECT r.*, i.title AS item_title
  FROM reminders r LEFT JOIN items i ON r.target_type = 'item' AND i.id = r.target_id`

export interface ReminderSeriesOpts {
  rrule?: string | null
  offsetMinutes?: number | null
  /** Required with rrule: the local wall-clock anchor and zone the series is stated in. */
  seriesAnchorLocal?: string | null
  seriesTz?: string | null
  /** Conditional follow-up (spec 3c): JSON like {"unless_resolved": "<item id>"}, evaluated by the scheduler at fire time. */
  conditionJson?: string | null
}

export function insertReminder(itemId: string, fireAtUtc: string, opts: ReminderSeriesOpts = {}): Reminder {
  const rid = randomUUID()
  const rrule = opts.rrule ?? null
  // A recurring reminder always carries its anchor; default it to the first fire time in the local zone.
  const tz = rrule ? (opts.seriesTz ?? DateTime.local().zoneName) : null
  const anchor = rrule ? (opts.seriesAnchorLocal ?? DateTime.fromISO(fireAtUtc, { zone: 'utc' }).setZone(tz!).toFormat("yyyy-MM-dd'T'HH:mm")) : null
  getDb()
    .prepare(
      `INSERT INTO reminders (id, target_type, target_id, fire_at_utc, rrule, series_anchor_local, series_tz, offset_minutes, condition_json, state, surfaced_count, created_at)
       VALUES (?, 'item', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
    )
    .run(rid, itemId, fireAtUtc, rrule, anchor, tz, opts.offsetMinutes ?? null, opts.conditionJson ?? null, nowIso())
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

/**
 * Update a reminder. Changing the fire time of a recurring reminder, or making one recurring, re-anchors the
 * series to that wall-clock time; clearing the rule clears the anchor.
 */
export function updateReminder(id: string, p: ReminderPatch): Reminder {
  const before = getReminder(id)
  if (!before) throw new Error(`No reminder ${id}`)
  const sets: string[] = []
  const vals: unknown[] = []
  if (p.fireAtUtc !== undefined) (sets.push('fire_at_utc = ?'), vals.push(p.fireAtUtc))
  if (p.rrule !== undefined) (sets.push('rrule = ?'), vals.push(p.rrule))
  const rruleAfter = p.rrule !== undefined ? p.rrule : before.rrule
  if (rruleAfter) {
    if (p.fireAtUtc !== undefined || !before.series_anchor_local || p.rrule !== undefined) {
      const tz = before.series_tz ?? DateTime.local().zoneName
      const fire = p.fireAtUtc ?? before.fire_at_utc
      sets.push('series_anchor_local = ?', 'series_tz = ?')
      vals.push(DateTime.fromISO(fire, { zone: 'utc' }).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm"), tz)
    }
  } else if (p.rrule === null) {
    sets.push('series_anchor_local = NULL', 'series_tz = NULL')
  }
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

// ---------- Notes on anything (spec §8 3d) ----------

export function insertNote(targetType: Note['target_type'], targetId: string, body: string, source: Note['source']): Note {
  const id = randomUUID()
  const ts = nowIso()
  getDb()
    .prepare(`INSERT INTO notes (id, target_type, target_id, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, targetType, targetId, body.trim(), source, ts, ts)
  return getNote(id)!
}

export function getNote(id: string): Note | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | undefined
}

export function resolveNoteId(ref: string): string {
  const rows = getDb().prepare('SELECT id FROM notes WHERE id LIKE ?').all(`${ref.trim()}%`) as { id: string }[]
  if (rows.length === 1) return rows[0].id
  if (rows.length === 0) throw new Error(`No note with id "${ref}"`)
  throw new Error(`Ambiguous note id "${ref}"`)
}

export function updateNoteBody(id: string, body: string): Note {
  getDb().prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?').run(body.trim(), nowIso(), id)
  return getNote(id)!
}

export function deleteNoteRow(id: string): void {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
}

export function restoreNote(n: Note): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO notes (id, target_type, target_id, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(n.id, n.target_type, n.target_id, n.body, n.source, n.created_at, n.updated_at)
}

export function notesFor(targetType: Note['target_type'], targetId: string): Note[] {
  return getDb().prepare('SELECT * FROM notes WHERE target_type = ? AND target_id = ? ORDER BY created_at').all(targetType, targetId) as Note[]
}

/** Date notes between two ISO dates inclusive ("yyyy-MM-dd"). */
export function dateNotesBetween(fromDate: string, toDate: string): Note[] {
  return getDb()
    .prepare(`SELECT * FROM notes WHERE target_type = 'date' AND target_id >= ? AND target_id <= ? ORDER BY target_id, created_at`)
    .all(fromDate, toDate) as Note[]
}

export function searchNotes(query: string, limit = 20): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
  if (!words.length) return []
  const where = words.map(() => 'LOWER(body) LIKE ?').join(' OR ')
  return getDb().prepare(`SELECT * FROM notes WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(...words.map((w) => `%${w}%`), limit) as Note[]
}

export function listNotes(limit = 500): Note[] {
  return getDb().prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').all(limit) as Note[]
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

/** Everything that happened on a project or any of its parts (denormalised project_id, plus the project row itself). */
export function activitiesForProject(projectId: string, limit = 50): Activity[] {
  return getDb()
    .prepare(
      `SELECT * FROM activities WHERE project_id = ? OR (target_type = 'item' AND target_id = ?)
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(projectId, projectId, limit) as Activity[]
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

// ---- Living activities (spec §8 Phase 5) --------------------------------------------------------------------------
// Ephemeral by design. Nothing in here writes to `activities`, `items` or `reminders`, and nothing here is undoable.

export function insertHappening(h: { label: string; kind: string | null; metaphor: Happening['metaphor']; startedAt: string; endsAt: string | null; projectId: string | null }): Happening {
  const id = randomUUID()
  getDb()
    .prepare(`INSERT INTO happenings (id, label, kind, metaphor, started_at, ends_at, state, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, h.label.trim(), h.kind, h.metaphor, h.startedAt, h.endsAt, h.projectId, nowIso())
  return getHappening(id)!
}

export function getHappening(id: string): Happening | undefined {
  return getDb().prepare('SELECT * FROM happenings WHERE id = ?').get(id) as Happening | undefined
}

export function runningHappenings(): Happening[] {
  return getDb().prepare(`SELECT * FROM happenings WHERE state = 'running' ORDER BY started_at`).all() as Happening[]
}

/** Timed happenings whose time is up and that are still running — the scheduler ends these. */
export function dueHappenings(nowUtcIso: string): Happening[] {
  return getDb().prepare(`SELECT * FROM happenings WHERE state = 'running' AND ends_at IS NOT NULL AND ends_at <= ? ORDER BY ends_at`).all(nowUtcIso) as Happening[]
}

/** Running ones plus anything that ended after `sinceUtcIso`, newest first — what the window shows. */
export function happeningsForWindow(sinceUtcIso: string): Happening[] {
  return getDb()
    .prepare(`SELECT * FROM happenings WHERE state = 'running' OR (ends_at IS NOT NULL AND ends_at >= ?) ORDER BY (state = 'running') DESC, started_at DESC LIMIT 12`)
    .all(sinceUtcIso) as Happening[]
}

/** End a happening now. When it finishes early (or was open-ended), ends_at becomes the moment it ended. */
export function finishHappening(id: string, state: 'done' | 'abandoned'): Happening | undefined {
  const h = getHappening(id)
  if (!h || h.state !== 'running') return h
  const now = nowIso()
  const endsAt = h.ends_at && h.ends_at <= now ? h.ends_at : now
  getDb().prepare(`UPDATE happenings SET state = ?, ends_at = ? WHERE id = ?`).run(state, endsAt, id)
  return getHappening(id)
}

/** Happenings that ended (done or dropped) after `sinceUtcIso`, newest first. */
export function recentlyEndedHappenings(sinceUtcIso: string): Happening[] {
  return getDb().prepare(`SELECT * FROM happenings WHERE state != 'running' AND ends_at >= ? ORDER BY ends_at DESC`).all(sinceUtcIso) as Happening[]
}

/** Find a running happening by id prefix, else by words in its label ("egg" → "eggs", "the wash" → "washing machine"). */
export function resolveRunningHappening(ref: string): Happening | null {
  return matchHappening(runningHappenings(), ref)
}

/** The same matching over any list: id prefix, else label/kind/metaphor word overlap; null when nothing or a tie. */
export function matchHappening(running: Happening[], ref: string, preferFirstOnTie = false): Happening | null {
  const r = ref.trim().toLowerCase()
  if (!r) return running.length === 1 ? running[0] : null
  const byId = running.filter((h) => h.id.startsWith(r))
  if (byId.length === 1) return byId[0]
  const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, '')
  const refWords = r.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'timer'].includes(w)).map(stem)
  if (!refWords.length) return running.length === 1 ? running[0] : null
  const scored = running
    .map((h) => {
      const hw = `${h.label} ${h.kind ?? ''} ${h.metaphor ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem)
      const hits = refWords.filter((w) => hw.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length
      return { h, hits }
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits)) return scored[0].h
  if (scored.length > 1 && preferFirstOnTie) return scored[0].h
  return null
}
