# Secretary App — Architecture & Build Plan

Working spec for a conversational personal secretary with a cozy companion, Windows desktop.
Written to be handed to Claude Code as the source of truth for the project.

**Status:** V1, single user (the author), local-only, not distributed.

---

## 0. Scope decisions

This V1 is being built for one person on one machine. That removes a large amount of the original brief. The following are **explicitly out of scope for V1** and should not be built, even partially:

- Onboarding / first-run flow
- Monetization, feature gating, usage tracking, subscription state
- Multiple personality modes
- Calendar view, projects dashboard, statistics
- Installer, code signing, auto-update, distribution
- User accounts, authentication, cloud sync
- Email or calendar integration
- Attachments, document understanding

These are **in scope and must not be compromised**:

- Reliable local persistence
- Reminders that fire when the app is closed and after a Windows restart
- One conversational interface that handles create / edit / complete / cancel in natural language
- Structured memory that distinguishes kinds of information
- Deadline components and dependencies
- Availability constraints and conflict detection
- "What should I do now?" and "What am I forgetting?"
- Brain dump, by text or voice note
- Conversational replanning
- A companion and room

Cutting the first list is what makes the second list achievable quickly.

### Invariants

These are not features and must never be dropped, deferred or simplified in any phase. They exist to prevent the assistant becoming confidently wrong over time, which is the main way this kind of product dies.

1. **`due_precision` is always set honestly.** "Tomorrow" is `day` precision. Do not invent a clock time and store it as `exact`. If a time is needed for scheduling, derive it at display time from preferences, and say so.
2. **Inferred is never stored as stated.** `is_suggestion = 1` for anything the assistant proposed. A suggestion is never counted as an obligation until the user confirms it.
3. **Every model proposal is logged to `extractions`**, applied or not.
4. **Nothing is reported as done before the transaction commits.**
5. **Task ≠ reminder ≠ deadline.** Cancelling one never silently destroys another.

**One thing to know before starting:** the app needs its own API key at runtime. A Claude Pro/Max subscription powers Claude Code while you build; it does not power the app once it runs.

V1 uses **Google Gemini's free tier** — a key from Google AI Studio, no credit card, no Cloud project. Flash models only (Pro moved behind billing in April 2026). **Measured September 2026: 5 requests/minute per model on the Flash models** — the 15 RPM figure that circulated earlier no longer holds. Flash-Lite is the default because its quota is looser; the Flash models sit behind it as fallbacks, and quotas are per model so siblings absorb bursts. Daily quotas are in the low hundreds per model and are revised without notice; check ai.dev/rate-limit rather than trusting a number written here. For one user typing at human pace this is still enough, provided **one message costs one model call** and the deterministic tier carries the bulk of traffic.

Two constraints that follow from this choice:

- Google may use free-tier inputs and outputs to improve their models. This app holds highly personal information, which is in direct tension with §27 of the original brief. The provider abstraction exists so this decision can be reversed cheaply once the app holds real data — a paid key on any provider costs a couple of dollars a month at single-user volume.
- Never enable billing on the Gemini project. Doing so removes the free tier entirely on that project and makes every call billable from the first token.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Best-documented Windows tray, background process and toast notification path. The two hardest requirements live here. |
| UI | React + TypeScript + Vite | Already familiar. TypeScript matters more than usual here because the AI will be generating most of the code and types catch its mistakes. |
| Styling | Tailwind CSS | Fast iteration on a look that needs a lot of iteration. |
| Database | SQLite via `better-sqlite3` | Synchronous API, no async complexity, transactional. Runs in the main process only. |
| Date parsing | `chrono-node` | Deterministic natural-language date parsing. This is the cheap fast path — no model call needed for "tomorrow at 5". |
| Date handling | Luxon | Timezone-correct arithmetic. |
| AI | `@google/genai` behind a provider interface | Free tier for V1. The interface is what matters — swapping providers must be a config change, never a rewrite. |
| Validation | Zod | Every AI tool call is validated against a schema before it touches the database. Non-negotiable. |

**Why not Tauri:** smaller binaries and a nicer security model, but it adds a Rust toolchain to a project where the builder isn't a developer. Spend the difficulty budget on the assistant, not the build system.

---

## 2. Architecture

```
┌─────────────────────────────────────────┐
│  RENDERER (React)                       │
│  Conversation · Room · Today rail       │
│  No database access. No API keys.       │
└──────────────┬──────────────────────────┘
               │ IPC (typed channels only)
┌──────────────┴──────────────────────────┐
│  MAIN PROCESS                           │
│                                         │
│  Orchestrator ── Router (tier 0/1/2)    │
│       │                                 │
│       ├── Context Assembler             │
│       ├── Provider (Gemini)              │
│       ├── Tool Executor (Zod → txn)     │
│       │                                 │
│  Scheduler ── Notifier ── Tray          │
│       │                                 │
│  Repository layer                       │
│       │                                 │
│  SQLite                                 │
└─────────────────────────────────────────┘
```

Hard rules:

1. The renderer never touches SQLite and never sees the API key.
2. The model never writes SQL. It calls tools; tools are validated; validated calls run inside a transaction.
3. The assistant does not tell the user something happened until the transaction has committed.
4. If the model fails, errors, or returns garbage, the database is unchanged and the user gets an honest message.

---

## 3. Database schema

The central design decision: **do not create ten separate tables for the ten entity kinds in the brief.** They share 80% of their fields and constantly convert into each other (a note becomes a task; a task becomes a waiting item). One `items` table with a `kind` discriminator is far easier to query, migrate and reason about.

```sql
CREATE TABLE items (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,      -- task|deadline|project|waiting|note|commitment|idea
  title           TEXT NOT NULL,
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'open',  -- open|done|cancelled|archived
  due_at_utc      TEXT,               -- ISO 8601 UTC
  due_tz          TEXT,               -- IANA zone captured at creation
  due_precision   TEXT,               -- exact|day|week|vague
  effort_minutes  INTEGER,
  importance      INTEGER DEFAULT 2,  -- 1 low .. 4 critical
  is_suggestion   INTEGER DEFAULT 0,  -- assistant proposed it, user has not confirmed
  confidence      REAL,               -- extraction confidence 0..1
  waiting_on      TEXT,               -- person/thing, for kind='waiting'
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

CREATE TABLE constraints (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,   -- unavailable|prefer|avoid
  label        TEXT NOT NULL,   -- "travelling", "class", "no mornings"
  starts_at    TEXT,            -- UTC, null for recurring-only
  ends_at      TEXT,
  rrule        TEXT,            -- for standing constraints ("every Tue 2-5pm")
  source       TEXT NOT NULL,   -- stated|inferred
  created_at   TEXT NOT NULL
);

CREATE TABLE reminders (
  id              TEXT PRIMARY KEY,
  item_id         TEXT REFERENCES items(id) ON DELETE CASCADE,
  fire_at_utc     TEXT NOT NULL,
  rrule           TEXT,            -- RFC 5545 for recurrence
  condition_json  TEXT,            -- conditional: {"unless_resolved": "<item_id>"}
  state           TEXT NOT NULL,   -- pending|delivered|acknowledged|snoozed|cancelled
  delivered_at    TEXT,
  surfaced_count  INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL,    -- user|assistant|system
  content    TEXT NOT NULL,
  tier       INTEGER,          -- which routing tier handled it
  created_at TEXT NOT NULL
);

CREATE TABLE extractions (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES messages(id),
  tools_json  TEXT NOT NULL,   -- what the model proposed
  applied     INTEGER NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
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

Notes on specific columns:

- `is_suggestion` and `confidence` directly implement the brief's requirement that inferences must never silently become obligations. Suggestions render differently and are never counted as commitments until confirmed.
- `extractions` is an audit log of what the model proposed versus what was applied. This is the single most valuable table for debugging, and you will need it constantly.
- `due_precision` matters. "Sometime next week" is not the same as Monday 17:00 and must not be stored as though it were.
- `constraints` holds availability facts that are neither tasks nor preferences: "I'm travelling Friday", "class 2–5 on Tuesdays", "nothing before 11". Without this table, replanning will keep proposing times the user has already ruled out. `source` distinguishes what the user stated from what the assistant guessed.
- Text IDs (UUIDs) rather than integers so cloud sync is possible later without renumbering.
- Every timestamp is UTC ISO 8601. Local time is a display concern only.

---

## 4. AI architecture

### Routing

Not every message deserves a frontier model. Three tiers:

**Tier 0 — deterministic, no model call, instant.**
Handles: "done", "finished the CV", "cancel that", "snooze", "move that to 7", and any message where `chrono-node` finds a date and the verb is a simple create. Target: 50–60% of messages.

**Default model (September 2026): `gemini-3.5-flash-lite`** for every model-backed tier, with `gemini-3.6-flash` and `gemini-3.8-flash` as fallbacks when it is exhausted. Promote tier 2 to full Flash only if answer quality on §9 steps 7–9 demands it.

**One message, one call.** A successful write round must not cost a second model call to phrase the confirmation: the reply is composed in code from the committed results (which is also what guarantees hard rule 3). A second call is allowed only when the model asked a read-only tool a question and needs the answer to reply.

**Tier 1 — small model (Gemini Flash-Lite).**
Handles: classification, single-item extraction, simple edits, reference resolution.

**Tier 2 — strongest available (Gemini Flash).**
Handles: brain dumps, replanning, "what should I do now", "what am I forgetting", anything involving dependency reasoning.

The router decides tier before any call. Build tier 0 and tier 2 first; add tier 1 once you can see from the `messages.tier` column where the volume actually sits.

**Consequence of the free tier:** with Pro unavailable, tier 2 is a Flash-class model. Flash is strong at extraction and weaker at multi-step reasoning over a dependency graph than a frontier model. Two mitigations, both of which are good practice regardless:

- Push work into tier 0 wherever a deterministic answer exists. Dependency resolution, blocker identification and "what's overdue" should be **computed in code from the `links` table**, not reasoned about by the model. The model's job is to phrase the answer, not to derive it.
- Keep tool schemas small and flat. Reliability on structured output drops sharply with schema complexity. Prefer several narrow tools over one tool with many optional fields.

If §9's acceptance test steps 7–9 produce weak answers, the fix is usually more computation in code rather than a better model.

**Rate limits are normal, not bugs.** A 429 is expected behaviour at 5 RPM. The 429 body carries a `retryDelay`; honour it (fall back to 1s, 2s, 4s, 8s only when it is absent), treat 503 "high demand" the same way, and switch to a sibling model when the first is exhausted at the start of a turn. Surface a calm "one moment" in the UI rather than an error. Never lose the user's message because a call was throttled — queue it.

This is also the latency fix. "Got it" should appear instantly for the common cases, not after three seconds.

### Tools

Defined as JSON schema, validated with Zod, executed in a transaction:

```
create_item, update_item, complete_item, cancel_item
create_reminder, update_reminder, cancel_reminder, snooze_reminder
add_link, remove_link
add_constraint, remove_constraint, check_conflicts
set_preference
search_memory, get_today, get_upcoming, get_item, get_current_context
propose_plan
```

`propose_plan` returns a plan for the user to approve rather than applying it. Replanning must never happen silently.

### Destructive-operation semantics

The blast radius of a cancellation must match what the user actually said. Three levels:

| User says | Affects | Confirmation |
|---|---|---|
| "cancel the reminder" | the reminder only | none — just do it |
| "I'm not doing the case study" | that one item | none |
| "forget about the application" | a project and its components | **ask first**, naming what would go |

Never cascade a delete across linked items without confirmation. Prefer `status = 'cancelled'` over row deletion everywhere, so a mistaken cancel is recoverable and the assistant can honestly answer "what happened to X?".

### Priority is inferred, never asked

There is no priority selector anywhere in the UI. `importance` is derived from how the user talks — "I absolutely have to get this done tonight" is not "maybe I should read this sometime" — and from deadline proximity and downstream blocking. The user can override in conversation ("that's not actually important"), and an override is `stated` and sticks.

### Context assembly

Never send the whole database. Each request gets:

- Last 10 messages
- Items modified in the last 7 days
- Items due in the next 14 days
- All open `waiting` items
- All preferences
- Keyword-matched items when the message contains a specific noun

Cap it. If the context exceeds budget, drop oldest-modified items first.

### Reference resolution

"that", "it", "the earlier one" is the hardest natural-language problem here. Maintain a short focus stack in memory — the last 3–5 items touched, with what was done to them — and pass it explicitly in context. Do not expect the model to infer it from conversation history alone.

---

## 5. Reminder and notification architecture

This is the highest-risk subsystem and it gets built first.

**SQLite is the source of truth.** The scheduler is a loop over the table, holding no state of its own.

**Tick, don't sleep.** Use a 30-second interval that queries for `fire_at_utc <= now AND state = 'pending'`. Do not use long `setTimeout` calls — they do not survive laptop sleep or hibernation reliably, which is precisely the failure mode that makes reminder apps untrustworthy.

**Startup sweep.** On every launch, query for pending reminders whose fire time has passed. Deliver them marked as missed, with how late they are. This satisfies the restart-recovery requirement.

**Background survival.** The app runs in the tray and does not quit when the window is closed. `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` for restart survival.

**Windows toasts.** Electron's `Notification` API maps to Windows toast, but requires `app.setAppUserModelId()` to be set or toasts silently fail — this is a common and confusing first bug. In development, notifications may not appear until the app is properly identified.

**Notification actions.** Toasts carry buttons — **Done**, **Snooze**, **Reschedule** — so the common responses need no window at all. Windows toast supports this natively; Electron exposes it via the `actions` field, and the click handler routes back through the same tool layer as typed input, never through a separate code path. Snooze offers a couple of sensible intervals rather than a picker.

**Reminders are not tasks.** A reminder is an alarm attached to an item; the item is the obligation. Creating a task does not automatically create a reminder, and a due date without a reminder is a real and valid state. But if the user says "remind me", they get a row in `reminders`, not just a due date — and the Coming Up view must reflect exactly what exists.

**State machine.** `pending → delivered → acknowledged | snoozed | cancelled`. Write the state change to the database before reporting success anywhere.

**Follow-through.** Dismissing a notification acknowledges the *reminder*, never the underlying *item*. If the item is still open and important, the follow-up logic may resurface it — with intensity derived from `surfaced_count`, deadline proximity and importance. Escalation caps out; it never becomes nagging.

**Visible log.** Build a small debug panel that shows the scheduler's last 50 actions. You cannot debug a silent failure, and reminders fail silently by nature. Build this in Phase 0, not later.

---

## 6. UI structure

Single window. Three zones:

```
┌────────────────┬──────────────────────────┬──────────┐
│                │                          │          │
│   ROOM +       │      CONVERSATION        │  TODAY   │
│   COMPANION    │      (primary)           │  (thin)  │
│                │                          │          │
│                │  ┌────────────────────┐  │          │
│                │  │ type or dump here  │  │          │
└────────────────┴──┴────────────────────┴──┴──────────┘
```

- **Conversation is primary** and gets the most space. Input accepts a single line or a paragraph-long dump with no mode switch.
- **Today rail** is glanceable only — a handful of items, not a task manager. It exists so the user can see that the assistant actually recorded things.
- **Room** is ambient and mostly still.
- **Memory view** (a modal, reachable from the rail) lists what the assistant believes, grouped by kind, with inline edit and delete. The brief lists this as secondary; it should be treated as core, for reasons in §8.

Visual direction: warm cream `#FAF6F0` backgrounds, cocoa `#3A2E28` text, one muted accent, generous whitespace, rounded forms, soft shadows, subtle paper grain. No borders where whitespace will do.

### Companion

A state machine over layered SVG, not video or sprite sheets:
`idle · thinking · working · reading · waiting · happy · concerned · sleepy · celebrating`

Transitions are slow and subtle. The companion animates on state change and otherwise mostly breathes. Anything more is distracting in a window the user leaves open all day.

---

## 7. Build phases

Each phase has a hard completion test. Do not begin the next phase until the current test passes on a real machine.

### Phase 0 — The risky part, first
Electron + React + SQLite skeleton. Tray. Migrations. A crude input box that writes to `items`. The scheduler, the notifier, the startup sweep, and the debug log panel.

**Done when:** you create a reminder for five minutes from now, quit the app entirely, restart Windows, don't open the app — and the notification still fires. Then set one for a time in the past while the app is closed, open the app, and confirm it's reported as missed.

*If this phase fails, nothing else matters. That's why it's first.*

### Phase 1 — Conversation with tools
Orchestrator, provider abstraction, the tool layer with Zod validation, transactional execution, the `extractions` audit log. Create, complete, edit, cancel tasks and reminders by talking. Reference resolution via the focus stack. Destructive-operation semantics. Notification actions on the toast. Static companion illustration as a placeholder.

**Pulled forward from Phase 2 (September 2026, because of the 5 RPM quota):** the Tier 0 deterministic router — `chrono-node` date parsing for simple creates, and keyword handling for done / cancel / snooze / move — with no model call at all, executing through the same tool layer and logged with `tier = 0`.

Split this into 1a and 1b if it fights back. 1a: create and read, with the invariants enforced. 1b: edit, cancel, complete, and reference resolution. Reference resolution is the hardest part of the phase and deserves its own pass.

**Done when:** "remind me to call the bank Thursday at 3" creates a real row; "actually make it 4" edits *that same row* rather than making a second one; "cancel the reminder" leaves the task standing; "tomorrow" is stored as `day` precision with no invented clock time; and the app only says it's done after the commit.

### Phase 2 — Dates, hardening the fast path
`chrono-node` and the Tier 0 router landed in Phase 1. This phase widens Tier 0 coverage using the `messages.tier` column as evidence, reviews timezone-correct storage, and adds recurrence via RRULE.

**Done when:** simple messages respond in under 300ms with no API call, "every Sunday" recurs correctly, and "in two hours" lands on the right timestamp.

### Phase 3 — Structure
Kinds beyond task. Projects with components, inferred from conversation rather than created by hand. `links` and dependency resolution. Waiting items. Availability constraints and conflict detection. The memory view with editing.

**Done when:** the first five steps of the acceptance test in §9 pass, and "I'm busy tomorrow afternoon" followed by "put the case study tomorrow afternoon" produces a conflict warning rather than a silent booking.

### Phase 4 — The signature features
Brain dump extraction. Voice notes. "What should I do now?" "What am I forgetting?" The explicit/possible distinction in output.

**Voice belongs here, not in a phase of its own.** Gemini accepts audio directly, so no separate transcription service is needed: record in the renderer, send the audio to the same key with the same tool schema, get structured calls back. It is a record button plus an audio branch in the provider, not a subsystem. And it belongs with brain dump because that is what voice is *for* — a chaotic ninety-second ramble is the natural voice input, and a microphone that can only create one flat task is not worth having.

Keep the audio local. Store the recording alongside the message if it's useful for debugging; do not build a transcription archive.

**Done when:** a messy five-clause paragraph — typed or spoken — produces a sensible set of items and asks at most one clarifying question; and the two questions give useful answers rather than list dumps.

### Phase 5 — Follow-through and replanning
`propose_plan`. Escalation logic. Quiet hours. Intensity settings. The overwhelm response.

**Done when:** the full acceptance test passes end to end.

### Phase 6 — The room and the companion
Real illustration. State machine. Time-of-day lighting. Daily briefing.

**Done when:** you want to leave it open on your desktop.

### Phase 7 — Living with it
Use it daily for two weeks and fix what actually annoys you. Resist adding features during this phase.

The companion is late deliberately — it's the emotional payoff but it's also purely additive, and it's the thing most likely to absorb unlimited time. The placeholder in Phase 1 keeps the project from feeling soulless in the meantime.

---

## 8. Risks

**Native module rebuild.** `better-sqlite3` must be compiled against Electron's Node version. This will be your first real blocker. `electron-rebuild` fixes it; expect to lose an hour.

**Silent notification failure.** Missing `AppUserModelId`, Windows focus assist, or notification permissions all cause toasts to vanish without error. The debug log in Phase 0 is the defence.

**Sleep and hibernation.** Tested by actually closing the laptop lid, not by assuming.

**Memory drift.** The real long-term killer. Over months the model accumulates duplicate items, stale dependencies and tasks it never marked complete, and becomes confidently wrong about your life. Mitigations: the editable memory view, a periodic pass that flags items untouched for 30 days, and an assistant that asks rather than guessing when confidence is low. Treat this as a first-class feature, not cleanup.

**Reference resolution.** "Move that" will misfire sometimes. When the focus stack is ambiguous, ask — one short clarifying question beats a wrong edit.

**Free-tier tradeoffs.** Cost is near zero on Gemini's free tier, so the real risks shift: free-tier inputs may be used for training, daily quotas can be revised without notice, and Flash-class reasoning is the ceiling. Watch the `tier` column to see where volume actually sits, and treat the provider swap as a decision to revisit once the app holds real data rather than a permanent choice.

**Scope creep.** The original brief is a three-year product. This plan is a six-to-ten week one. Every "while we're here" addition pushes the date out.

---

## 9. Acceptance test

Run this in full at the end of Phase 5 and after every significant change thereafter.

1. "I need to submit my application Monday at 5." → deadline created
2. "It needs my CV, transcript and case study." → three components linked to it
3. "CV is done." → that component completes, not the whole thing
4. "I emailed my professor about the transcript." → waiting item created
5. "I don't want to do the case study tonight." → no guilt, a reasonable alternative offered
6. "Move it to tomorrow afternoon." → replanned
7. "What should I do right now?" → one concrete recommendation with reasoning
8. "What am I forgetting?" → unresolved components surfaced, explicit separated from possible
9. "Actually move the application to Tuesday." → deadline updates, dependent planning adjusts
10. "Cancel the reminder." → reminder cancelled, obligation retained
11. Close app. Restart Windows. Reminders still fire. Missed ones recovered.

At no point may the assistant claim something happened that did not.

---

## 10. Changes from the original brief

**Cut from V1:** onboarding, monetization architecture, personality modes, calendar view, distribution, attachments, email and calendar integration. Listed in §0.

**Moved into V1:** voice notes (Phase 4). Gemini accepts audio directly, which collapses this from a subsystem into a record button — the reason it was originally cut no longer holds.

**Merged in (second pass):** notification actions on the toast, availability constraints as a first-class table, destructive-operation semantics, conflict detection, and the explicit statement that priority is inferred rather than selected. These came from a later review and fill real gaps.

**Elevated:** the memory inspection view moves from secondary to core, because memory drift is the main long-term failure mode and the user needs to be able to repair it.

**Added:** the `extractions` audit table, the scheduler debug log, the focus stack for reference resolution, `is_suggestion` / `confidence` on items, and the invariants in §0.

**Restructured:** the brief's 18 V1 priorities are re-sequenced so the riskiest infrastructure is proven in week one rather than discovered in month three.

**Provider:** Gemini free tier for V1, behind an abstraction. Chosen for zero cost during the phase where most calls are test noise. Revisit once the app holds real personal data — see §0.

**Deferred:** monetization architecture. Building feature gating before knowing which features people would pay for is guessing in code. The provider abstraction and the clean separation between orchestrator and database are what actually keep those options open, and both are in this plan.

---

## 11. Working with Claude Code on this

- Keep this file as `SPEC.md` in the project root. **It is the only phase numbering that exists.** If another plan turns up with its own Phase 1, fold it into this file rather than running two schemes — a session that guesses which numbering you meant will build the wrong thing.
- Keep a `CLAUDE.md` alongside it with: the current phase, what works, what's broken, and what's next. Update it at the end of each session. This is what survives between sessions.
- Work one phase at a time. Say "build Phase 2 from SPEC.md" rather than "build the app".
- Commit to git every time something works. That's your undo.
- Report bugs as: what I did / what I expected / what happened. Paste the actual error text.
- When a fix breaks something else twice in a row, the slice is too big. Back up and split it.
