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
  },
  {
    // Spec rewrite (third pass): items gain hardness/sort_order; reminders become polymorphic
    // (target_type/target_id, offset_minutes); new events, notes and activities tables.
    version: 3,
    sql: `
      ALTER TABLE items ADD COLUMN hardness TEXT;
      ALTER TABLE items ADD COLUMN sort_order INTEGER;

      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        starts_at_utc TEXT NOT NULL,
        ends_at_utc   TEXT,
        all_day       INTEGER DEFAULT 0,
        tz            TEXT NOT NULL,
        rrule         TEXT,
        exdates       TEXT,
        project_id    TEXT REFERENCES items(id),
        kind          TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Rebuild reminders with the polymorphic target. Existing rows all pointed at items.
      CREATE TABLE reminders_v3 (
        id              TEXT PRIMARY KEY,
        target_type     TEXT NOT NULL,
        target_id       TEXT NOT NULL,
        fire_at_utc     TEXT NOT NULL,
        rrule           TEXT,
        offset_minutes  INTEGER,
        condition_json  TEXT,
        state           TEXT NOT NULL,
        delivered_at    TEXT,
        surfaced_count  INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      INSERT INTO reminders_v3 (id, target_type, target_id, fire_at_utc, rrule, offset_minutes, condition_json, state, delivered_at, surfaced_count, created_at)
        SELECT id, 'item', item_id, fire_at_utc, rrule, NULL, condition_json, state, delivered_at, surfaced_count, created_at
        FROM reminders WHERE item_id IS NOT NULL;
      DROP INDEX IF EXISTS idx_reminders_pending;
      DROP TABLE reminders;
      ALTER TABLE reminders_v3 RENAME TO reminders;
      CREATE INDEX idx_reminders_pending ON reminders(state, fire_at_utc);
      CREATE INDEX idx_reminders_target ON reminders(target_type, target_id);

      CREATE TABLE notes (
        id          TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        body        TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE activities (
        id           TEXT PRIMARY KEY,
        target_type  TEXT NOT NULL,
        target_id    TEXT NOT NULL,
        project_id   TEXT REFERENCES items(id),
        verb         TEXT NOT NULL,
        actor        TEXT NOT NULL,
        summary      TEXT NOT NULL,
        before_json  TEXT,
        after_json   TEXT,
        reversible   INTEGER DEFAULT 1,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_activities_target ON activities(target_type, target_id);
      CREATE INDEX idx_activities_created ON activities(created_at);
    `
  },
  {
    // Phase 2: recurring reminders are anchored to a local wall-clock time + zone so occurrences stay at the same
    // local time across daylight-saving changes and do not drift after a snooze.
    version: 4,
    sql: `
      ALTER TABLE reminders ADD COLUMN series_anchor_local TEXT;
      ALTER TABLE reminders ADD COLUMN series_tz TEXT;
    `
  },
  {
    // Phase 5: living activities. Deliberately separate from `activities` (the permanent history log): a happening is
    // ephemeral, never an obligation, never in Open, never undoable history. `kind` is an addition to the spec's columns
    // so micro-rituals can remember a "no" per kind of happening.
    version: 5,
    sql: `
      CREATE TABLE happenings (
        id           TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        kind         TEXT,
        metaphor     TEXT,
        started_at   TEXT NOT NULL,
        ends_at      TEXT,
        state        TEXT NOT NULL DEFAULT 'running',
        project_id   TEXT REFERENCES items(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_happenings_state ON happenings(state, ends_at);
    `
  },
  {
    // Phase 5d: a commitment is an obligation with another person's expectation attached — who it was made to.
    // People stay a plain text here; the `people` table is unused until after V1 (spec).
    version: 6,
    sql: `ALTER TABLE items ADD COLUMN committed_to TEXT;`
  },
  {
    // Phase 6: multi-day plans generate sessions; sessions are events with kind='session' and a plan_id (spec §3).
    version: 7,
    sql: `
      CREATE TABLE plans (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        project_id      TEXT REFERENCES items(id) ON DELETE SET NULL,
        target_minutes  INTEGER,
        starts_on       TEXT NOT NULL,
        ends_on         TEXT,
        rrule           TEXT,
        session_minutes INTEGER,
        deadline_item   TEXT REFERENCES items(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      ALTER TABLE events ADD COLUMN plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL;
      ALTER TABLE events ADD COLUMN session_state TEXT;
      CREATE INDEX idx_events_start ON events(starts_at_utc);
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
