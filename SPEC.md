# Secretary App — Architecture & Build Plan

Working spec for a conversational personal secretary with a cozy companion, Windows desktop.
**This file is the single source of truth.** If another plan turns up with its own phase numbers, fold it into this file rather than running two schemes.

**Status:** V1, single user (the author), local-only, not distributed. Phase 0 complete. Phase 1 in progress.

---

## 0. Scope, invariants, and the standard

### The product

A conversational secretary that remembers what is happening in the user's life. Not a task manager with a chat box. The user talks; the assistant understands, retrieves, reasons, acts, persists, and confirms what actually happened.

The user should never have to think "what category is this", "should this be a project", "what priority". They talk. The system figures it out.

### Out of scope for V1

- Onboarding / first-run flow
- Monetization, feature gating, usage tracking, subscription state
- Multiple personality modes
- Installer, code signing, auto-update, distribution
- User accounts, authentication, cloud sync
- Email integration, external calendar sync (Google/Outlook)
- Attachments and document understanding
- People as full entities (schema leaves room; no UI)
- Export/backup UI (schema is portable; no UI)

### In scope and not to be compromised

- Reliable local persistence and restart recovery
- Reminders that fire with the app closed and after a Windows restart
- One conversational interface: create, edit, complete, cancel, replan
- Projects/Things, checklists, notes, activity history, waiting items, dependencies
- A full internal calendar, two-way with the assistant
- Availability constraints and conflict detection
- "What should I do now?" and "What am I forgetting?"
- Brain dump, by text or voice note
- Manual editing of everything (§7)
- A companion and room
- Living activities — real-world happenings that never become tasks
- Multi-day plans that generate sessions and know when they fall behind

### Invariants

Not features. These hold in every phase and are never deferred or simplified.

1. **`due_precision` is always honest.** "Tomorrow" is `day` precision. Never invent a clock time and store it as `exact`.
2. **Inferred is never stored as stated.** `is_suggestion = 1` for anything the assistant proposed. A suggestion is not an obligation until confirmed.
3. **Every model proposal is logged to `extractions`**, applied or not.
4. **Nothing is reported as done before the transaction commits.** "I couldn't save that — nothing changed" is always better than a false success.
5. **Task ≠ reminder ≠ deadline ≠ calendar event.** Cancelling one never silently destroys another.
6. **No dead-end information.** Anything displayed can be inspected and edited directly. See §7.
7. **One data model.** Manual edits and AI edits write to the same rows. Never two parallel systems.
8. **Actionability threshold.** "I need to get my life together" does not become a task called *Get life together*. See §4.
9. **Never convert an ordinary statement into an unwanted timer, task, reminder or interaction.** Saying what you are doing is not a request. The assistant may offer; it never imposes.
10. **Never silently rewrite the user's calendar.** A new plan may propose moving things; it never moves an existing commitment without approval.
11. **Nothing is duplicated.** One "IIM application" Thing, referenced everywhere, not re-created on each mention.

### The standard

Not "does it create tasks". The standard is: *does this feel like a competent secretary who understands what is happening in my life?* The user should be able to dump complexity in and get clarity back.

### Runtime AI key

The app needs its own API key. A Claude subscription powers Claude Code while you build; it does not power the app once it runs.

V1 uses **Google Gemini's free tier** — a key from Google AI Studio, no credit card, no Cloud project.

- **The per-minute limit is tight: 5 requests/minute on `gemini-3.8-flash`.** Flash-Lite is more generous. This is a functional constraint, not a nuisance — see §4.
- Honour the `retryDelay` value Google returns in the 429 body rather than guessing a backoff curve.
- Google may use free-tier inputs to improve their models. This app holds highly personal data. The provider abstraction exists so this is reversible; a paid key at single-user volume costs a couple of dollars a month.
- Never enable billing on the Gemini project — doing so removes the free tier entirely on that project.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Best-documented Windows tray, background process and toast path. |
| UI | React + TypeScript + Vite | TypeScript matters more than usual — the AI generates most of the code and types catch its mistakes. |
| Styling | Tailwind CSS | Fast iteration. |
| Database | SQLite via `better-sqlite3` | Synchronous, transactional, main process only. |
| Date parsing | `chrono-node` | Deterministic NL date parsing. Zero API cost. |
| Date handling | Luxon | Timezone-correct arithmetic. |
| Recurrence | `rrule` | RFC 5545, shared by reminders and calendar events. |
| AI | `@google/genai` behind a provider interface | Swapping providers must be config, never a rewrite. |
| Validation | Zod | Every tool call validated before it touches the database. |

---

## 2. Architecture

```
┌─────────────────────────────────────────┐
│  RENDERER (React)                       │
│  Conversation · Calendar · Today ·      │
│  Things · Companion                     │
│  No database access. No API keys.       │
└──────────────┬──────────────────────────┘
               │ IPC (typed channels only)
┌──────────────┴──────────────────────────┐
│  MAIN PROCESS                           │
│                                         │
│  Orchestrator ── Router (tier 0/1/2)    │
│       ├── Context Assembler             │
│       ├── Provider (Gemini)             │
│       ├── Tool Executor (Zod → txn)     │
│       └── Activity Recorder             │
│                                         │
│  Scheduler ── Notifier ── Tray          │
│                                         │
│  Repository layer                       │
│  SQLite                                 │
└─────────────────────────────────────────┘
```

Hard rules:

1. The renderer never touches SQLite and never sees the API key.
2. The model never writes SQL. It calls tools; tools are validated; validated calls run in a transaction.
3. **Manual UI edits go through the same tool layer as AI edits.** Same validation, same transactions, same activity records. This is the mechanism that enforces invariant 7 — not discipline, architecture.
4. AI failure, database failure, scheduler failure and notification failure are distinct and reported distinctly. An AI failure never corrupts local state.
5. With the AI unavailable, the app still works: view and edit everything, receive reminders, complete tasks, use the calendar.

---

## 3. Database schema

One `items` table with a `kind` discriminator rather than ten near-identical tables. Kinds convert into each other constantly (a note becomes a task; a task becomes a waiting item) and share most fields.

```sql
CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,   -- task|deadline|project|waiting|note|commitment|idea|checklist_item
  title           TEXT NOT NULL,
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
                  -- open|in_progress|done|cancelled|blocked|waiting|archived
  due_at_utc      TEXT,
  due_tz          TEXT,
  due_precision   TEXT,            -- exact|day|week|vague
  hardness        TEXT,            -- hard|soft   (deadline vs target — see notes below)
  effort_minutes  INTEGER,
  importance      INTEGER DEFAULT 2,
  sort_order      INTEGER,         -- checklist ordering
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
  type       TEXT NOT NULL,   -- blocks|part_of|relates_to
  created_at TEXT NOT NULL,
  UNIQUE(from_item, to_item, type)
);

CREATE TABLE events (                      -- calendar
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  starts_at_utc TEXT NOT NULL,
  ends_at_utc   TEXT,
  all_day       INTEGER DEFAULT 0,
  tz            TEXT NOT NULL,
  rrule         TEXT,
  exdates       TEXT,          -- JSON array of excluded occurrence dates
  project_id    TEXT REFERENCES items(id),
  kind          TEXT,          -- commitment|work_block|session
  plan_id       TEXT REFERENCES plans(id),
  session_state TEXT,          -- planned|done|missed|moved  (sessions only)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE reminders (
  id              TEXT PRIMARY KEY,
  target_type     TEXT NOT NULL,   -- item|event
  target_id       TEXT NOT NULL,
  fire_at_utc     TEXT NOT NULL,
  rrule           TEXT,
  offset_minutes  INTEGER,         -- "30 min before" / "3 days before the deadline"
  condition_json  TEXT,            -- {"unless_resolved": "<item_id>"}
  state           TEXT NOT NULL,   -- pending|delivered|acknowledged|snoozed|cancelled|paused
  delivered_at    TEXT,
  surfaced_count  INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE plans (                       -- multi-day plans: study, training, preparation
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  project_id      TEXT REFERENCES items(id),
  target_minutes  INTEGER,          -- total intended effort, e.g. 30h
  starts_on       TEXT NOT NULL,
  ends_on         TEXT,
  rrule           TEXT,             -- preferred cadence, e.g. Mon/Wed/Fri
  session_minutes INTEGER,          -- preferred session length
  deadline_item   TEXT REFERENCES items(id),   -- the exam or submission it serves
  status          TEXT NOT NULL,    -- active|paused|done|abandoned
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE notes (                       -- attachable to anything
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,   -- item|event|reminder|date
  target_id   TEXT NOT NULL,   -- for target_type='date', an ISO date
  body        TEXT NOT NULL,
  source      TEXT NOT NULL,   -- user|assistant
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE activities (                  -- history and the basis for undo
  id           TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  project_id   TEXT REFERENCES items(id),  -- denormalised for fast project timelines
  verb         TEXT NOT NULL,   -- created|updated|completed|cancelled|rescheduled|
                                -- note_added|status_changed|reminder_fired|
                                -- reminder_missed|dismissed|snoozed|deleted
  actor        TEXT NOT NULL,   -- user|assistant|system
  summary      TEXT NOT NULL,   -- "Reminder moved Tue 9am → Wed 5pm"
  before_json  TEXT,            -- prior state, for undo
  after_json   TEXT,
  reversible   INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE happenings (                  -- ephemeral real-world activities (§8 Phase 5)
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,        -- "egg", "laundry", "focus session"
  metaphor     TEXT,                 -- egg|tea|laundry|plant|download|focus|null
  started_at   TEXT NOT NULL,
  ends_at      TEXT,                 -- null for open-ended ("I'm showering")
  state        TEXT NOT NULL,        -- running|done|abandoned
  project_id   TEXT REFERENCES items(id),   -- only if genuinely work-related
  created_at   TEXT NOT NULL
);

CREATE TABLE constraints (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,   -- unavailable|prefer|avoid
  label      TEXT NOT NULL,
  starts_at  TEXT,
  ends_at    TEXT,
  rrule      TEXT,
  source     TEXT NOT NULL,   -- stated|inferred
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tier       INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE extractions (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  tools_json TEXT NOT NULL,
  applied    INTEGER NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL,   -- stated|inferred
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

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Notes:

- **A Project/Thing is `items` with `kind='project'`.** Tasks, checklist items, deadlines and notes attach via `links` (`part_of`) or `project_id`. One TISS mailing, referenced everywhere.
- **Checklist items are items** (`kind='checklist_item'`, `part_of` a project, ordered by `sort_order`). They do not become standalone tasks unless the user promotes them.
- **`activities` is the memory of what happened**, and carries `before_json` so undo is a real operation rather than a guess. Never overwrite history.
- **Reminders and notes are polymorphic** (`target_type`/`target_id`) because both attach to items *and* calendar events.
- `hardness` separates "I absolutely must submit Monday at 5" from "I'd like to finish this weekend". Do not treat every mentioned date as binding.
- Prefer `status='cancelled'` over row deletion everywhere. Mistakes stay recoverable and the assistant can answer "what happened to X?".
- Text IDs (UUIDs) so cloud sync is possible later. All timestamps UTC ISO 8601; local time is a display concern.

---

## 4. AI architecture

### Routing — and why it is now a hard requirement

The free tier allows **5 requests/minute**. A design where every user message costs an API call is unusable. Routing is not an optimisation; without it the app does not work.

**Tier 0 — deterministic, no model call, instant.** `chrono-node` for dates, keyword matching for done / cancel / snooze / complete, all manual UI edits, all reads (Today, Coming Up, calendar, project views), all dependency and blocker computation. Target: the clear majority of interactions.

**Tier 1 — `gemini-3.5-flash-lite`.** Classification, single-item extraction, simple edits, reference resolution.

**Tier 2 — `gemini-3.6-flash`, escalating to `gemini-3.8-flash` only where reasoning depth genuinely earns the tighter quota.** Brain dumps, replanning, the two signature questions, cross-project reasoning.

**One user message must cost at most one API call.** If classification and extraction are separate calls, merge them. Count calls per message and assert it in a test.

**Compute, don't reason.** Dependency resolution, blocker identification, conflict detection, free-slot finding and "what's overdue" are computed in code from `links`, `events` and `constraints`. The model phrases the answer; it does not derive it. This is both the rate-limit fix and the accuracy fix — Flash-class models are good at extraction and mediocre at multi-step graph reasoning.

**Rate limits are normal.** Honour `retryDelay` from the 429 body. Queue the message, never lose it. The UI stays calm; the debug panel says exactly which failure it was.

### Tools

Validated with Zod, executed in a transaction, recorded in `activities`:

```
create_item, update_item, complete_item, cancel_item, delete_item
create_project, update_project, archive_project
add_checklist_item, complete_checklist_item, remove_checklist_item, reorder_checklist
create_reminder, update_reminder, cancel_reminder, snooze_reminder, pause_reminder
create_event, update_event, delete_event
add_note, update_note, delete_note
add_link, remove_link
add_constraint, remove_constraint
start_happening, finish_happening, offer_timer
set_context, resolve_commitment
create_plan, update_plan, pause_plan, mark_session, replan_sessions
set_preference
record_activity
search_memory, search_activity, get_today, get_upcoming, get_project, get_calendar,
  get_free_slots, check_conflicts, get_current_context, get_day, get_plan
propose_changes
undo_last
```

`propose_changes` returns a proposal for approval; replanning never happens silently, and existing commitments are never moved without it (invariant 10). Note it is deliberately not called `propose_plan` — `plans` are the multi-day objects in §3, a different thing entirely.

### Action confidence — enforced in the tool layer, not the prompt

| Level | Example | Behaviour |
|---|---|---|
| Confident | "remind me tomorrow at 5" | execute |
| Ambiguous | "move the application" with two applications open | ask which |
| Consequential | "forget about the application" (project + components) | confirm, naming what would go |

Blast radius must match what the user said. "Cancel the reminder" touches the reminder only. Never cascade across linked items without confirmation.

### Actionability threshold

The assistant must distinguish:

- "I need to email the professor" → obligation
- "I emailed the professor" → completed action + activity record, **not** a task called *emailed professor*
- "I emailed the professor but haven't heard back" → completed action + waiting item
- "I should probably email the professor" → idea, not a hard task
- "I'm exhausted today" → temporary context, stored nowhere permanent
- "I need to get my life together" → nothing

When the user says something about an existing Thing, **update that Thing**. Do not create a new task each time it is mentioned.

### Priority is inferred, never asked

No priority selector anywhere. `importance` derives from language, deadline proximity, and what the item blocks. The user overrides conversationally ("that's not actually important") and the override sticks as `stated`.

### Context assembly

Never send the whole database. Each request gets: last 10 messages; the focus stack; items modified in the last 7 days; items due in the next 14 days; today's and tomorrow's events; open waiting items; active constraints; preferences; and keyword-matched items when the message names something specific. Cap it; drop oldest-modified first.

### Reference resolution

"that", "it", "the TISS thing", "the earlier reminder" is the hardest problem here. Maintain a focus stack — the last 3–5 items touched and what was done to them — and pass it explicitly. Resolve against the focus stack first, then entity names, then recency. If multiple candidates are plausible **and the action is consequential, ask.** Never make a destructive change on low-confidence resolution.

---

## 5. Reminder and notification architecture

**SQLite is the source of truth.** The scheduler is a loop over the table with no state of its own.

**Tick, don't sleep.** A 30-second interval querying `fire_at_utc <= now AND state = 'pending'`. Long `setTimeout` calls do not survive sleep or hibernation.

**Startup sweep.** On every launch, deliver pending reminders whose time has passed, marked as missed with how late. "You missed your 9 AM reminder to work on the article. Want to do it now or move it?" The underlying item stays intact.

**Background survival.** Tray-resident, does not quit on window close. `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`.

**Windows toasts** require `app.setAppUserModelId()` or they silently fail.

**Notification actions.** Toasts carry **Done**, **Snooze**, **Reschedule** so common responses need no window. Actions route back through the same tool layer as typed input.

**Reminders are not tasks.** A due date without a reminder is a valid state — but decide deliberately whether creating a dated item should offer or auto-create a reminder. Silence on a known deadline is not secretarial. Whatever is decided, the UI must show exactly what exists.

**Completing an item cancels its now-irrelevant reminders.** Deleting a reminder never touches the item.

**Follow-through.** Dismissal acknowledges the *reminder*, never the *obligation*. If the item is still open and important, follow-up logic may resurface it — intensity from `surfaced_count`, deadline proximity, importance, preferences and quiet hours. Escalation caps out.

**Notification history** lives in `activities`: created, fired, dismissed, snoozed, rescheduled, missed, delivery failed.

**Visible log.** A debug panel showing the scheduler's last 50 actions and the last 20 AI calls with their outcome. You cannot debug a silent failure.

---

## 6. Calendar

A real internal calendar, as a secondary view. Conversation stays the home screen.

**Views:** month, week, day, agenda. Date navigation and a Today button.

**Events:** all-day and timed, recurring via RRULE with per-occurrence exceptions, notes, reminders, optional project association.

**Direct manipulation:** click to open, drag to move, resize to change duration, edit and delete. Every manual change writes through the same tool layer and lands in `activities` — the assistant must immediately know the event moved.

**Two-way, genuinely.** "Meeting with Professor X Thursday at 3" creates an event. "Move it to 4" updates it. Dragging it to 5 updates the same row. "What am I doing Thursday?" reads from it.

**Obligations shown alongside events, and visually distinct.** A deadline is not a meeting; a work block is not a commitment. Same underlying records as everywhere else — never duplicate copies.

**Conflict detection** and **free-slot finding** are deterministic functions over `events` plus `constraints`, exposed as tools. "Put the case study at 3 tomorrow" when a meeting exists at 3 returns a conflict and an alternative.

---

## 7. UI structure and manual editing

Primary window, conversation-first:

```
┌────────────────┬──────────────────────────┬──────────┐
│   ROOM +       │      CONVERSATION        │  TODAY   │
│   COMPANION    │      (primary)           │  (rail)  │
│                │  ┌────────────────────┐  │          │
│                │  │ type or dump here  │  │          │
└────────────────┴──┴────────────────────┴──┴──────────┘
```

Secondary views, reachable but not the home screen: **Calendar**, **Things**, **Settings**. Later: Memory, Search.

**There is no separate Today view.** An earlier draft had one, and it collided with both the rail and the calendar's day view. Three surfaces showing overlapping versions of today is how an app stops being trustworthy — the user can't tell which is authoritative. The resolution:

- **The rail** is the ambient glance beside the conversation: overdue, coming up, open, waiting, what's running right now. Enough to confirm the assistant recorded things. Never a dashboard.
- **The calendar's day view** is the full picture of a date, today included, built from the Day View Model in §8 Phase 6a.
- Both read the same records. Neither is a separate query.

### Manual editing is mandatory

The app is conversational-*first*, not conversational-*only*. The user must never be forced to talk to the AI to perform basic operations, and **nothing displayed may be a dead end.**

Every reminder, task, project, checklist item, note and calendar event supports: open, edit every field, reschedule, complete, cancel, delete, and — where relevant — pause, resume, reorder, and change association. Recurrence is editable and the scheduler must pick up the new values immediately.

Inline quick actions where they save a click (✓ Done, ↻ Snooze, ⋯ More), a restrained contextual menu otherwise. Confirmation on destructive actions, matching the confidence tiers in §4.

**Manual changes record activities** exactly as AI changes do — "Reminder moved Tue 9am → Wed 5pm" — which is what makes undo and "what changed?" possible.

Visual direction: warm cream `#FAF6F0`, cocoa `#3A2E28`, one muted accent, generous whitespace. The full language is in §8, Phase 4.

**The companion and room are Phase 4** — they are a feature, not polish, and are built before the calendar. **The broader visual pass is Phase 9**, deliberately after the calendar so it covers the month/week/day/agenda surfaces rather than being redone once they land.

---

## 8. Build phases

Each phase has a hard completion test. Do not begin the next until the current one passes on a real machine. Ship each phase's manual controls *with* that phase — invariant 6 is not a later cleanup.

### Phase 0 — Infrastructure ✅ complete
Electron + React + SQLite. Tray. Migrations. Scheduler, notifier, startup sweep, debug panel. Reminders fire with the window closed; missed ones are recovered.
*Outstanding: the strict reboot test has not been observed.*

### Phase 1 — Conversation, tools, and the spine ✅ complete
Orchestrator, provider abstraction, Zod-validated tool layer, transactional execution, `extractions` log, `activities` recorder, focus stack, confidence tiers, actionability threshold. Create / edit / complete / cancel tasks and reminders conversationally **and manually**. Notification actions. Undo.

Split freely — 1a create and read with invariants enforced, 1b edit/cancel/complete and reference resolution, 1c manual editing surfaces. Reference resolution is the hardest part and deserves its own pass.

**Done when:** "remind me to call the bank Thursday at 3" then "actually make it 4" edits *one row*; "cancel the reminder" leaves the task; "tomorrow" stores as `day` precision; every visible item opens and edits; "undo that" reverses the last change; and one user message costs at most one API call. Test A in §11 is the full check.

### Phase 2 — Fast path, dates, recurrence ✅ complete
Tier 0 router. `chrono-node`. Timezone-correct storage. RRULE for reminders. `gemini-3.5-flash-lite` as default model.

**Done when:** simple messages respond instantly with no API call; "every Sunday" recurs and survives restart; "in two hours" lands correctly; and normal testing no longer trips the rate limit.

### Phase 3 — The life model ✅ complete
The largest phase. Build it in slices, each independently testable, in this order:

**3a — Projects/Things.** `items` with `kind='project'`. Inferred from conversation, never created by hand. Tasks and deadlines attach via `links` (`part_of`).

**3b — Checklists.** `kind='checklist_item'`, ordered by `sort_order`, part_of a project. "Add send first email, follow up, and attach the document" creates three. Checklist items do not become standalone tasks unless promoted.

**3c — Waiting items.** `kind='waiting'` with `waiting_on`. Visually distinct from open tasks. Conditional follow-ups ("if they haven't replied by Friday, remind me") create a reminder with `condition_json`, evaluated deterministically against item state — never by asking the model whether the condition is met.

**3d — Notes on anything.** The `notes` table, attachable to items, events, reminders and bare dates. "Add a note to the application that the transcript must be a PDF" attaches without navigating to a form. Date-attached notes ("I'll be travelling Friday") inform planning without becoming journaling.

**3e — Activity history in the UI.** A project view showing its timeline, and answers to "what have I done for X?" read from `activities` rather than from the model's memory.

**3f — Dependencies and constraints.** `links` of type `blocks`. Availability constraints. Blocker computation in code.

**Entity resolution is the thing most likely to break this phase.** "TISS mailing" mentioned across three conversations must resolve to one project. Before creating any project, match against existing ones by name similarity and recent focus; on a near-match, use the existing one; when genuinely unsure and the action is consequential, ask. A second orphaned "TISS mailing" is the failure that makes the whole life model worthless.

**Natural-language updates must update, not create.** "I worked on the TISS mailing today" is an activity on an existing project. "I sent it" completes a checklist item. "They haven't replied" is a waiting state. None of these create a task named after the sentence.

**Done when:** the TISS acceptance test in §11B passes end to end, across an app restart, with one project and no duplicates.

### Phase 4 — Companion and room ✅ complete

The companion is not decoration and not a mascot. It is the physical embodiment of the secretary. It is being built here, before the calendar, because it is self-contained, it does not touch the data model, and it is the thing that makes this product different from a very good organiser.

**The creature.** Original. Emotionally in the territory of products like Finch, but never copying Finch's character, art, terminology, progression or interface. It should read as: cute, calm, competent, slightly playful, emotionally expressive. Not childish, not hyperactive, not overly enthusiastic. A little creature quietly keeping your life together.

**Decided, and settled.** These are not open questions — they were chosen and built.

- **The creature is a dormouse-quokka.** Soft, slightly unusual, observant, sleepy, companion-like. Deliberately not a fox (too mascot) and not a tortoise (too slow-coded).
- **One scarf, and nothing else.** Its signature accessory. No wardrobe, no accessories to collect — that would make it a dress-up game.
- **Eye contact is rare and meaningful.** On greeting, on genuine happiness, when directly addressed, and occasionally where it's emotionally right. It does not stare at the user. Most of the time it is doing its own thing.
- **It stays unnamed.** Nobody should be made to name their companion during onboarding. Later, the creature itself may say something like "I think I should have a name", and then the user names it. Deferred, but the reason it has no name is deliberate.
- **The creature is constant; the world changes.** Window scenes are chosen by the user: trees and sky, fireplace, rainy window, sunset, night, bright morning, library, coastal, winter. Light band follows the clock by default and can be set by hand. Both persist.
- **It has a life of its own.** Reading, sleeping, sitting by the fire, working at the desk, looking out of the window, simply existing. It does not perform for the user.

**Deferred to Phase 9:** favourite scenes and rotation, weather-driven scenes, the naming moment, and objects accumulating in the room so it gradually becomes theirs.

**States.** `idle · attentive · thinking · working · reading · writing · waiting · happy · concerned · sleepy · celebrating · greeting`

Driven by what the app is actually doing, not by a timer:
- processing a brain dump → at the desk, reading or writing
- model call in flight → thinking, subtly
- something important completed → a small celebration
- late at night → sleepy
- an open waiting item → reading or waiting
- first open of the day → greeting

**Subtlety is the whole discipline.** The creature animates on state change and otherwise mostly breathes. This window is open all day; anything more is a distraction, and constant motion is what makes companions feel cheap.

**The room.** A persistent cozy environment — a place, not a decorative background. Desk, laptop, notebook, mug, books, plant, lamp, window, small storage, stationery. Time of day drives lighting, the view through the window, ambient detail and the creature's default state. Not a game map. No collectibles, no clutter, no childish gamification.

**No gamification, ever.** No streaks, points, coins, rewards, energy, punishments or artificial scarcity. The companion never depends on the user completing tasks to stay well — its state reflects the work, never judges the user. The emotional relationship is the point, and the product must work perfectly without any of it. Optional customization can come much later.

**Emotional UX.** Supportive without being infantilizing. Never "You failed", "You broke your streak", "You should have done this". Instead: "This didn't get done today. We still have time — let's figure out where it fits." Tone is cute but competent: observant, concise, calm, slightly playful, practical, reassuring without being saccharine. Not OMG-bestie. Not productivity guru. Not corporate coach.

**Visual language** (also the standing direction for §8): warm cream backgrounds, muted pastel accents, dark cocoa/charcoal text, rounded forms, soft shadows, subtle paper or illustration texture, restrained borders, generous whitespace. Warm, cozy, soft, premium, illustrated, minimal, calm. Avoid corporate SaaS, Notion clones, generic AI chat interfaces, neon AI aesthetics, heavy glassmorphism, dark futuristic dashboards, and childish cartoon clutter.

**Done when:** the creature's state reflects what the app is really doing, the room changes convincingly between morning, afternoon, evening and night, nothing animates distractingly during ordinary use, and the window is one you would leave open on your desktop because you like looking at it.

### Phase 5 — Living activities ✅ complete

The layer that makes this a secretary you live with rather than one that manages your deadlines. Built with the companion because it depends on the creature being expressive.

**Not everything said is a task.** The system must separate four things:

| The user says | What it is |
|---|---|
| "I need to do laundry tomorrow" | task |
| "I've started the washing machine" | happening |
| "remind me to move the laundry in 45 minutes" | reminder |
| "laundry's done" | happening resolved, into history |

A happening never enters `items`, never appears in Open, and never becomes an obligation. It expires on its own.

**Recognised happenings.** Cooking (boiling, baking, soaking, steeping, defrosting), household (washing machine, drying, charging, chilling), personal (shower, getting ready, leaving, short break), work (focus session, reading, waiting on a download or process).

**Metaphorical progress, used selectively.** Where a physical metaphor exists, progress shows as the thing itself rather than a bar: egg raw → warming → soft → medium → hard; tea dry → steeping → ready; laundry washing → rinsing → spinning → done; plant seed → sprout → growing; focus starting → focused → complete. The timer underneath stays exact. Build it as a general metaphor system, not one hard-coded egg. Where no natural metaphor exists, a plain timer is correct — do not invent one.

**Micro-rituals.** The assistant offers, never imposes. "I'm making tea" → "Want a 5-minute steep timer?" One offer, and a no is remembered for that kind of happening.

**The room reflects it.** Focus session → the creature works at the desk. Cooking timer → it waits beside a small kitchen object. Waiting → it reads. Nothing happening → it simply exists in the room.

**Personality, tightly rationed.** Small observations are allowed — "Egg watch has begun", "That's one thing out of your head" — under three rules: never the same line twice, never more than occasionally, and never on anything the user is struggling with. The register is quietly observant, not performative. A line that would read as smug if you were having a bad day does not ship.

**No gamification here either.** Happenings earn nothing, track no streak, and their metaphors are illustration, not score.

**Done when:** "I've put an egg on for 8 minutes" starts a visible egg that progresses and resolves without creating a task; "I need to do laundry tomorrow" still creates a task; the room reacts; and a week of use has produced no clutter in Open.

**5d — Context and commitments.** The fourth thing the system must tell apart.

| The user says | What it is | Lifespan |
|---|---|---|
| "I need to finish the application" | obligation | until done |
| "I've put the egg on" | happening | minutes |
| "I'm exhausted today" / "I'm at TISS until 5" | **context** | today |
| "I told Professor X I'd email him tonight" | **commitment** | until honoured |

**Context** influences current reasoning — what to recommend, what to schedule — and never becomes permanent memory or a task. It expires on its own. A durable pattern stated as such ("I work better on analytical writing in the afternoon") is a preference, not context, and that one persists.

**Commitments** are obligations with another person's expectation attached. "I should email Professor X" is an intention. "I told Professor X I'd email him tonight" is a commitment. The difference is not urgency, it is that someone else is now waiting. Commitments weigh more heavily in "what am I forgetting?" and in follow-through, and are surfaced with who they were made to.

**Not in scope here:** People as full entities. The schema holds `people` and it stays unused in the UI until after V1.

**Done when:** the ambiguity test in §11F passes.

### Phase 6 — Calendar and temporal planning

**The principle:** the calendar shows not merely what has been scheduled, but everything the secretary understands about the user's time. It is an aggregation layer over the existing data model — it never creates duplicate copies of anything.

Build in slices.

**6a — Aggregation and the day view.** For any date, assemble a complete temporal representation from existing records: timed events, all-day events, tasks and deadlines due, checklist items due, reminders firing, work blocks, commitments, waiting items needing attention, relevant happenings, **notes attached to the date itself** as well as notes on the things appearing that day, completed items, relevant project context, and **unresolved overdue items carried in from earlier days**. Never create duplicate calendar records.

**One Day View Model, consumed by every view.** This is the most important instruction in the phase. Build a single function returning the complete state of a date. Day renders it directly; Week takes seven; Month takes summary versions; Agenda takes them chronologically. Four bespoke queries would drift apart and make every later addition a fourfold change.

**Nothing is converted into a calendar event to make it appear.** "Finish case study Thursday" is a task. "Thursday 6–8pm, case study" is a work block. "Remind me Thursday at 5" is a reminder. "Application due Thursday 5pm" is a deadline. They sit together in the day view and stay four different objects in four different shapes — invariant 5, restated here because this is the slice where it would be easiest to break.

**Four states, not one list.** The model returns items grouped as `scheduled`, `unscheduled` (date-bound, no allocated time), `overdue`, `completed`. This is what makes 6e's unscheduled area and drag-to-schedule straightforward rather than a retrofit.

**Tasks can appear on a day without occupying time.** A task due Thursday shows on Thursday; it is never assigned an arbitrary slot to make it visible. Time-bound and date-bound are different. The day view needs a **Due today** area distinct from **Schedule**, or dateless obligations get lost.

**Computation happens here, deterministically, with no model call.** The Day View Model calculates: priority ordering (from importance, deadline proximity, `hardness`, overdue status, blocker state, whether it is a commitment, whether it is already scheduled), scheduled minutes, estimated due effort, counts of hard deadlines and high-importance obligations, available capacity, conflicts, and a day load status. 6c and 6d only *display* these. **Anything overdue and unresolved is pressing by definition** and must appear in priorities.

**The model exposes a day summary**, not just a list: counts of priorities, due items, scheduled items, reminders and overdue items, plus the load status. Month view is built from exactly these numbers, which is why they are computed once here rather than derived separately per view.

**Completed items are history, never workload.** Shown in a collapsed section, never counted as open obligations or toward the day's load.

Day structure: *Priorities → Due today → Schedule → Reminders and follow-ups → Notes → Completed (collapsed)*.

**Do not expand the UI beyond what 6a requires.** Build the aggregation cleanly; 6b–6f build the surfaces on top of it. Polishing the current layout instead of building the model is the failure mode for this slice.

**Done when:** selecting any date produces a complete deterministic representation of everything due, scheduled, relevant or unresolved on it; date-bound tasks occupy no arbitrary slot; overdue items surface as priorities; completed items remain as history without counting as load; priorities and workload compute with no AI call; and the same Day View Model can serve Month, Week, Day and Agenda.

**Also in 6a, easily missed:**

- **Multi-day things.** "I'm in Delhi Monday to Wednesday" is one event spanning three days, not three events. It appears on each day it covers, marked as continuing rather than starting, and renders as a continuous band across month and week cells. The Day View Model must report whether a spanning item starts, continues or ends on the date being viewed.
- **Past dates are first-class.** Navigating backwards shows what actually happened: completed items, fired reminders, resolved waiting items, finished happenings, and the day's activity history. The calendar is a record, not only a plan. Priorities and workload are not computed for past dates — there is nothing to prioritise.
- **Week starts on Monday**, with a setting to change it. Do not hard-code Sunday.

**6b — Day detail panel.** Clicking a day, event or task opens a side panel with the complete context for that date, directly editable. Complete, reschedule, cancel, snooze, add a note, change importance — all from here, all through the same tool layer. This is functional architecture, not decoration, which is why it is here rather than in Phase 9.

**6c — Visual grammar and priorities.** Every day carries a compact priority summary visible *before* the panel is opened, so the calendar answers "what actually matters on this day?" at a glance.

Importance is encoded by colour — critical, high, normal, low — but **never by colour alone**: colour plus icon, label or weight, always. Importance and `hardness` are different axes and both are shown: a hard deadline of normal importance is not a high-importance soft target.

Types are visually distinct so the calendar is not a pile of identical rectangles: event as a solid block, work block lighter, deadline as a strong marker, due task in the Due area, reminder as a bell, commitment with its own marker, happening as ephemeral.

**6d — Views with distinct jobs.** Month is overview. Week is planning. Day is execution. Agenda is a chronological list. If all four become the same thing rendered differently, the phase has failed.

Month shows **workload, not just appointments** — where deadlines fall, where load clusters, where the gaps are. Day status is descriptive (light, normal, busy, overloaded), derived deterministically from scheduled hours, due obligations and constraints. Never a productivity score.

**6e — Manipulation.** Drag to move, resize to change duration, edit and delete. An **unscheduled area** holds obligations that have a deadline but no allocated time; dragging one onto the calendar creates a work block. Recurring series are expressed in natural language, never RRULE — and a single occurrence can be changed or skipped without destroying the series, via `exdates`. Every manual change lands in `activities`, so the day panel can show what changed and when.

**6f — Plans.** A plan generates sessions; sessions are `events` with `kind='session'` and a `plan_id`. Plans track target effort against completed effort, know which sessions were missed, and expose the remaining shortfall. Progress shows as hours done against target — planning information, never a streak or a score.

Conflict detection gains **levels** rather than being binary: *hard conflict* (genuine overlap), *tight* (technically fits, no buffer), *poor fit* (works but violates a stated constraint or preference). Transition buffers — "thirty minutes to get home from TISS", "nothing straight after class" — use the existing `constraints` table.

**What stays in Phase 7:** reasoning over all this. Replanning a fallen-behind plan, "what can I fit here?", feasibility checks on an over-ambitious plan, and natural-language scheduling across a week. Phase 6 makes the structures capable of being reasoned over; Phase 7 does the reasoning.

**Done when:** the calendar acceptance test in §11C passes.

### Phase 7 — Intelligence
Brain dump. Voice notes. Deadline intelligence and component bottlenecks. "What should I do right now?" "What am I forgetting?" Time estimates. Smart scheduling.

*Voice belongs here because Gemini accepts audio directly — record in the renderer, send to the same key with the same tool schema. It is a record button plus an audio branch, not a subsystem. And a chaotic ramble is exactly what voice is for; a microphone that only creates one flat task is not worth having.*

**Done when:** a messy multi-clause dump — typed or spoken — produces sensible structure with at most one clarifying question, and the two signature questions give real answers rather than list dumps.

### Phase 8 — Proactivity
Daily briefing. Deadline preparation. Missed-task and waiting-item follow-up. Adaptive intensity, quiet hours. Conversational replanning.

**Done when:** the application acceptance test in §11D passes end to end.

### Phase 9 — Visual pass
Typography, visual hierarchy, calendar and project aesthetics, notification personality. Deliberately after the calendar, so the pass covers the month/week/day/agenda surfaces rather than being redone once they land.

**Done when:** you want to leave it open on your desktop.

### Phase 10 — Living with it
Use it daily for two weeks. Fix what actually annoys you. Add nothing.

---

## 9. Known gaps

Carried forward deliberately. Not bugs — decisions deferred or work not yet done.

- **Recurring reminders cannot end.** No "until December", no "five times". RRULE supports `UNTIL` and `COUNT`; the editor and parser do not yet. Add when it bites.
- **Windows does not auto-start the app, and the fix is unverified.** The reboot test was run and failed: Windows skipped the Run-key entry at sign-in (shell log confirms it started other entries and not this one). Recovery works — once launched, missed reminders are delivered correctly. A per-user Task Scheduler logon task has been registered as a second mechanism but has **never been observed working**. Best guess for the original failure is the unsigned Electron binary running from the Downloads folder; packaging (electron-builder) may fix it properly. Until a reboot is watched, "starts with Windows" is a claim, not a fact. Deferred at the user's request.
- **The project lives in `Downloads`.** Suspected contributor to the startup failure, and a poor home for months of work. Moving it needs absolute paths updated, including the scheduled task.
- **Not packaged.** Runs in dev mode via Electron from `node_modules`, launched by `Start Secretary.cmd`. Packaging is Phase 10 work unless it turns out to fix startup, in which case it moves earlier.
- **Due date without a reminder is still the default.** §5 says decide this deliberately. It has not been decided. A dated item currently notifies nobody.
- **Wrong-year guard is narrow.** Past times are refused and obvious year slips corrected. Other date misreadings are not caught.

## 10. Risks

**Scope.** This is the largest risk by a distance. The spec has grown substantially in three revisions while Phase 1 is half-built. Phases 3 through 6 are each multi-week. The calendar alone is three to four weeks and now sits ahead of the intelligence features. Freeze scope until Phase 1 passes.

**Rate limits.** 5 RPM makes the tier-0 path load-bearing rather than optional. Watch the `tier` column.

**Memory drift.** Over months the model accumulates duplicates, stale dependencies and items it never closed, and becomes confidently wrong about your life. Defences: the editable views, activity history, a pass flagging items untouched for 30 days, and asking rather than guessing at low confidence.

**Duplicate entities.** "TISS mailing" mentioned in three conversations must resolve to one project. Match on name similarity before creating, and ask when unsure.

**Reference resolution.** Will misfire. Ask when ambiguous and consequential.

**Native module rebuild.** `better-sqlite3` against Electron's Node — `electron-rebuild`.

**Silent notification failure.** Missing `AppUserModelId`, focus assist, permissions. The debug panel is the defence.

**Recurrence correctness.** RRULE with exceptions across DST is a classic source of off-by-one-hour bugs. Test across a DST boundary explicitly.

---

## 11. Acceptance tests

Each must pass **across an app restart**, and at no point may the assistant claim something happened that did not.

### A. Reminders and manual editing (Phase 1)
1. Create a reminder through conversation.
2. Open it manually; change time, date, recurrence; save.
3. Verify the scheduler uses the new values.
4. Delete only the reminder — the task survives.
5. Recreate it, then complete the task — the reminder is cancelled as irrelevant.
6. "Undo that" reverses the last change.
7. Restart. Everything persists.

### B. TISS mailing (Phase 3)
1. "TISS mailing is something I need to deal with." → one Thing created
2. "Today I drafted the first email." → activity recorded, no task called *drafted first email*
3. "I haven't sent it yet." → sending remains outstanding
4. "Add a list for the things I need to do." → checklist on that Thing
5. "Add send first email, follow up, and attach the document." → three items
6. "I sent the first email." → item complete, activity recorded
7. "They said they'll get back to me Friday." → waiting item
8. "If they haven't replied by Friday afternoon, remind me." → conditional follow-up
9. "What have I done for TISS mailing?" → the history
10. "What is left?" → outstanding items and waiting states

### C. Calendar (Phase 6)
Run across a restart.

**Aggregation and display**
1. "Meeting with Professor X Thursday at 3" → event.
2. "Move it to 4" → same event updated.
3. Drag it manually to 5 → same row; the assistant knows it is at 5.
4. Create a task due Thursday with no time → appears under Due today, **not** occupying a slot in Schedule.
5. Create a reminder Thursday → appears separately from the task.
6. Attach a note to Thursday → appears under Notes, never becomes a task.
7. Thursday's priority summary is visible without opening the panel.
8. Importance is distinguishable without relying on colour alone.

**Panel and manipulation**
9. Click Thursday → the full day panel: priorities, due, schedule, reminders, notes, completed.
10. Complete a task from the panel → gone from Open, still in history.
11. Drag an item from the unscheduled area onto a slot → becomes a work block.
12. Change one occurrence of a recurring series → only that occurrence changes.
13. Cancel an event → the assistant knows it was cancelled.

**Plans**
14. "Study econometrics two hours every Monday, Wednesday and Friday until October 15" → one plan, with sessions on the calendar.
15. Skip a session → the plan records it missed and remains active; the shortfall is visible.
16. Move one session → only that session moves; the plan is intact.
17. Progress shows hours done against target, with no streak or score.

**Conflicts and load**
18. Book over an existing commitment → hard conflict, refused with an alternative.
19. Book with no gap after something → flagged tight, not refused.
20. Add "thirty minutes to get home from TISS" → later scheduling respects it.
21. A heavy day reads as busy or overloaded in month view, descriptively.
22. Nothing existing was moved at any point without approval.

**Spanning, past and week start**
23. "I'm in Delhi Monday to Wednesday" → one event, shown on all three days, marked as continuing on Tuesday and Wednesday, rendered as a band in week and month.
24. Navigate to a past date → completed items, fired reminders and that day's history are visible; no priorities are computed for it.
25. The week starts on Monday, and the setting changes it.

**Persistence**
26. Restart. The whole calendar, plan and session states persist.

### D. The application (Phase 8)
1. "I need to submit my IIM application Monday at 5." → project + hard deadline
2. "It needs my CV, transcript and case study." → three components
3. "CV is done." → that component only
4. "I emailed my professor about the transcript." → completed action + waiting item
5. "I don't want to do the case study tonight." → no guilt, an alternative offered
6. "Move it to tomorrow afternoon." → replanned
7. "What should I do right now?" → one concrete recommendation with reasoning
8. "What am I forgetting?" → unresolved components, explicit separated from possible
9. "Actually move the application to Tuesday." → deadline moves, planning adjusts
10. "Cancel the reminder." → reminder only

### E. Infrastructure (standing)
Close the app. Restart Windows. Reminders still fire. Missed ones recovered. Nothing lost.

---

### F. Ambiguous real-world statements (Phase 5)
Proves understanding rather than cooking-equals-timer pattern matching.

1. "I'm making dinner." → **nothing is created.** Not a task, not a happening, not a timer. A normal reply.
2. "I'm making dinner, remind me to check it in 20 minutes." → happening + reminder.
3. "I need to make dinner tomorrow." → task.
4. "I'm exhausted today." → context. Nothing in Open, nothing in permanent memory, and it informs what gets recommended today.
5. "I told Priya I'd send the draft tonight." → commitment, with Priya attached. It appears in "what am I forgetting?" ahead of an equivalent plain task.
6. "I'm making tea." → at most an offer. A "no" is remembered for tea.


## 12. Working with Claude Code on this

- This file is the only phase numbering that exists. Fold new plans in; never run two schemes.
- Keep `CLAUDE.md` beside it: current phase, what works, what's broken, what's next. Update every session.
- One phase at a time. "Build Phase 3 from SPEC.md", never "build the app".
- Commit whenever something works. That is the undo.
- Bugs as: what I did / what I expected / what happened, with the actual error text.
- If a fix breaks something else twice, the slice is too big. Split it.
- After each subsystem: run it, test it, test persistence, test the failure path, check nothing regressed. Compiling is not working.