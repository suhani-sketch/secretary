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

### Invariants

Not features. These hold in every phase and are never deferred or simplified.

1. **`due_precision` is always honest.** "Tomorrow" is `day` precision. Never invent a clock time and store it as `exact`.
2. **Inferred is never stored as stated.** `is_suggestion = 1` for anything the assistant proposed. A suggestion is not an obligation until confirmed.
3. **Every model proposal is logged to `extractions`**, applied or not.
4. **Nothing is reported as done before the transaction commits.** "I couldn't save that — nothing changed" is always better than a false success.
5. **Task ≠ reminder ≠ deadline ≠ calendar event.** Cancelling one never silently destroys another.
6. **No dead-end information.** Anything displayed can be inspected and edited directly. See §7.
7. **One data model.** Manual edits and AI edits write to the same rows. Never two parallel systems.
8. **Actionability threshold.** "I need to get my life together" does not become a task called *Get life together*. See §5.
9. **Nothing is duplicated.** One "IIM application" Thing, referenced everywhere, not re-created on each mention.

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
  hardness        TEXT,            -- hard|soft   (deadline vs target — see §5)
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
  kind          TEXT,          -- commitment|work_block
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

**Tier 1 — Flash-Lite.** Classification, single-item extraction, simple edits, reference resolution.

**Tier 2 — Flash.** Brain dumps, replanning, the two signature questions, cross-project reasoning.

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
set_preference
record_activity
search_memory, search_activity, get_today, get_upcoming, get_project, get_calendar,
  get_free_slots, check_conflicts, get_current_context
propose_plan
undo_last
```

`propose_plan` returns a plan for approval; replanning never happens silently.

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

Secondary views, reachable but not the home screen: **Calendar**, **Today**, **Things**, **Settings**. Later: Memory, Search.

**Today** answers "what actually matters today" — a few events, the live obligations, blockers, waiting items needing follow-up, and one suggested next action. Not a dashboard.

### Manual editing is mandatory

The app is conversational-*first*, not conversational-*only*. The user must never be forced to talk to the AI to perform basic operations, and **nothing displayed may be a dead end.**

Every reminder, task, project, checklist item, note and calendar event supports: open, edit every field, reschedule, complete, cancel, delete, and — where relevant — pause, resume, reorder, and change association. Recurrence is editable and the scheduler must pick up the new values immediately.

Inline quick actions where they save a click (✓ Done, ↻ Snooze, ⋯ More), a restrained contextual menu otherwise. Confirmation on destructive actions, matching the confidence tiers in §4.

**Manual changes record activities** exactly as AI changes do — "Reminder moved Tue 9am → Wed 5pm" — which is what makes undo and "what changed?" possible.

Visual direction stays as-is for now: warm cream `#FAF6F0`, cocoa `#3A2E28`, one muted accent, generous whitespace. **The aesthetic pass is deliberately late.** Do not spend time on illustration, animation or typography systems during the functional phases.

---

## 8. Build phases

Each phase has a hard completion test. Do not begin the next until the current one passes on a real machine. Ship each phase's manual controls *with* that phase — invariant 6 is not a later cleanup.

### Phase 0 — Infrastructure ✅ complete
Electron + React + SQLite. Tray. Migrations. Scheduler, notifier, startup sweep, debug panel. Reminders fire with the window closed; missed ones are recovered.
*Outstanding: the strict reboot test has not been observed.*

### Phase 1 — Conversation, tools, and the spine
Orchestrator, provider abstraction, Zod-validated tool layer, transactional execution, `extractions` log, `activities` recorder, focus stack, confidence tiers, actionability threshold. Create / edit / complete / cancel tasks and reminders conversationally **and manually**. Notification actions. Undo.

Split freely — 1a create and read with invariants enforced, 1b edit/cancel/complete and reference resolution, 1c manual editing surfaces. Reference resolution is the hardest part and deserves its own pass.

**Done when:** "remind me to call the bank Thursday at 3" then "actually make it 4" edits *one row*; "cancel the reminder" leaves the task; "tomorrow" stores as `day` precision; every visible item opens and edits; "undo that" reverses the last change; and one user message costs at most one API call.

### Phase 2 — Fast path, dates, recurrence
Tier 0 router. `chrono-node`. Timezone-correct storage. RRULE for reminders. Flash-Lite as default model.

**Done when:** simple messages respond instantly with no API call; "every Sunday" recurs and survives restart; "in two hours" lands correctly; and normal testing no longer trips the rate limit.

### Phase 3 — The life model
Projects/Things, inferred from conversation rather than created by hand. Checklists. Notes on anything. Activity history surfaced. Waiting items. Dependencies. Constraints. Natural-language project updates ("I worked on the TISS mailing today", "I sent it", "they haven't replied").

**Done when:** the TISS acceptance test in §10 passes end to end, across an app restart.

### Phase 4 — Calendar
Month / week / day / agenda. Events, recurrence, exceptions. Drag, resize, edit, delete. Two-way with the assistant. Obligations displayed alongside events. Conflict detection and free-slot finding.

**Done when:** the calendar acceptance test in §10 passes, including manual drag updating what the assistant knows.

### Phase 5 — Intelligence
Brain dump. Voice notes. Deadline intelligence and component bottlenecks. "What should I do right now?" "What am I forgetting?" Time estimates. Smart scheduling.

*Voice belongs here because Gemini accepts audio directly — record in the renderer, send to the same key with the same tool schema. It is a record button plus an audio branch, not a subsystem. And a chaotic ramble is exactly what voice is for; a microphone that only creates one flat task is not worth having.*

**Done when:** a messy multi-clause dump — typed or spoken — produces sensible structure with at most one clarifying question, and the two signature questions give real answers rather than list dumps.

### Phase 6 — Proactivity
Daily briefing. Deadline preparation. Missed-task and waiting-item follow-up. Adaptive intensity, quiet hours. Conversational replanning.

**Done when:** the application acceptance test in §10 passes end to end.

### Phase 7 — Aesthetic pass
Companion redesign and state machine. Room and time-of-day lighting. Typography, visual hierarchy, calendar and project aesthetics, notification personality.

**Done when:** you want to leave it open on your desktop.

### Phase 8 — Living with it
Use it daily for two weeks. Fix what actually annoys you. Add nothing.

---

## 9. Risks

**Scope.** This is the largest risk by a distance. The spec has grown substantially in three revisions while Phase 1 is half-built. Phases 3 through 6 are each multi-week. The calendar alone is three to four weeks and now sits ahead of the intelligence features. Freeze scope until Phase 1 passes.

**Rate limits.** 5 RPM makes the tier-0 path load-bearing rather than optional. Watch the `tier` column.

**Memory drift.** Over months the model accumulates duplicates, stale dependencies and items it never closed, and becomes confidently wrong about your life. Defences: the editable views, activity history, a pass flagging items untouched for 30 days, and asking rather than guessing at low confidence.

**Duplicate entities.** "TISS mailing" mentioned in three conversations must resolve to one project. Match on name similarity before creating, and ask when unsure.

**Reference resolution.** Will misfire. Ask when ambiguous and consequential.

**Native module rebuild.** `better-sqlite3` against Electron's Node — `electron-rebuild`.

**Silent notification failure.** Missing `AppUserModelId`, focus assist, permissions. The debug panel is the defence.

**Recurrence correctness.** RRULE with exceptions across DST is a classic source of off-by-one-hour bugs. Test across a DST boundary explicitly.

---

## 10. Acceptance tests

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

### C. Calendar (Phase 4)
1. "I have a meeting with Professor X Thursday at 3." → event
2. "Move it to 4." → same event updated
3. Drag it manually to 5. → same row; assistant now knows it is at 5
4. "When can I work on the case study?" → a real free slot
5. "Schedule it." → work block created, not overlapping anything

### D. The application (Phase 6)
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

## 11. Working with Claude Code on this

- This file is the only phase numbering that exists. Fold new plans in; never run two schemes.
- Keep `CLAUDE.md` beside it: current phase, what works, what's broken, what's next. Update every session.
- One phase at a time. "Build Phase 3 from SPEC.md", never "build the app".
- Commit whenever something works. That is the undo.
- Bugs as: what I did / what I expected / what happened, with the actual error text.
- If a fix breaks something else twice, the slice is too big. Split it.
- After each subsystem: run it, test it, test persistence, test the failure path, check nothing regressed. Compiling is not working.
