import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

export type DB = Database.Database

let db: DB | null = null

/** Schema migrations, applied in order and recorded in schema_migrations. Never edit an applied one — add a new version. */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE items (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        title           TEXT NOT NULL,
        details         TEXT,
        status          TEXT NOT NULL DEFAULT 'open',
        due_at_utc      TEXT,
        due_tz          TEXT,
        due_precision   TEXT,
        effort_minutes  INTEGER,
        importance      INTEGER DEFAULT 2,
        is_suggestion   INTEGER DEFAULT 0,
        confidence      REAL,
        waiting_on      TEXT,
        source_msg_id   TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        completed_at    TEXT
      );

      CREATE TABLE links (
        id         TEXT PRIMARY KEY,
        from_item  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        to_item    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_item, to_item, type)
      );

      CREATE TABLE reminders (
        id              TEXT PRIMARY KEY,
        item_id         TEXT REFERENCES items(id) ON DELETE CASCADE,
        fire_at_utc     TEXT NOT NULL,
        rrule           TEXT,
        condition_json  TEXT,
        state           TEXT NOT NULL,
        delivered_at    TEXT,
        surfaced_count  INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_reminders_pending ON reminders(state, fire_at_utc);

      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        tier       INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE extractions (
        id          TEXT PRIMARY KEY,
        message_id  TEXT REFERENCES messages(id),
        tools_json  TEXT NOT NULL,
        applied     INTEGER NOT NULL,
        error       TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE preferences (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE people (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Phase 0 addition: persistent scheduler debug log (spec §5 "Visible log").
      -- Persisted so that actions taken while the window was closed can be inspected later.
      CREATE TABLE scheduler_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at_utc      TEXT NOT NULL,
        level       TEXT NOT NULL,
        event       TEXT NOT NULL,
        detail      TEXT,
        reminder_id TEXT
      );
    `
  },
  {
    // Spec §3 (second pass): availability constraints — neither tasks nor preferences.
    version: 2,
    sql: `
      CREATE TABLE constraints (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        label        TEXT NOT NULL,
        starts_at    TEXT,
        ends_at      TEXT,
        rrule        TEXT,
        source       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `
  }
]

export function dbPath(): string {
  return join(app.getPath('userData'), 'secretary.db')
}

export function openDatabase(): DB {
  if (db) return db
  mkdirSync(app.getPath('userData'), { recursive: true })
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

export function getDb(): DB {
  if (!db) throw new Error('Database not opened yet')
  return db
}

function runMigrations(d: DB): { applied: number[] } {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const done = new Set(
    (d.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
  )
  const applied: number[] = []
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue
    const tx = d.transaction(() => {
      d.exec(m.sql)
      d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString()
      )
    })
    tx()
    applied.push(m.version)
  }
  return { applied }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
