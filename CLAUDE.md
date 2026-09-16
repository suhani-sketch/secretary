# Secretary — working notes for Claude Code

Source of truth for the design is `SPEC.md`. This file tracks where the build actually is.
Update it at the end of every session (spec §11).

## Current phase: Phase 1 — complete against the rewritten SPEC (third pass, 2026-09-15): spine, activities, undo, manual editing, confidence tiers, one-call rule. Phase 0's strict reboot test still not observed (user choice).

## What works (verified 2026-09-15)
- Electron 44 + React 19 + Vite 7 + Tailwind 4 + TypeScript, built with `electron-vite`.
- SQLite via `better-sqlite3` v13. **No native rebuild needed**: v13 ships N-API prebuilds
  (`node_modules/better-sqlite3/prebuilds/win32-x64.node`) that load under Electron as-is.
  There is no Visual Studio on this machine, so never add a `node-gyp rebuild` / `electron-rebuild` step.
- Migrations: numbered array in `src/main/db.ts`, recorded in `schema_migrations`. Full §3 schema is
  migration 1, plus a `scheduler_log` table (Phase 0 addition for the debug panel).
- Database file: `%APPDATA%\Secretary\secretary.db` (WAL mode, foreign keys on).
- Tray icon (`resources/tray.png`), window close hides to tray, app keeps running. Tray menu: Open / Start with Windows / Quit.
- Single-instance lock: a second launch focuses the existing window.
- Scheduler (`src/main/scheduler.ts`): 30 s `setInterval` tick over `reminders WHERE state='pending' AND fire_at_utc <= now`.
  State is written `pending → delivered` **before** the toast is shown. A tick also runs on `powerMonitor` resume.
- Startup sweep: overdue pending reminders are delivered at launch, marked missed, with lateness in the toast title.
- Windows toasts via `Notification` with `app.setAppUserModelId('com.suhani.secretary')`. Confirmed `notify.shown` fires.
- Start with Windows: `app.setLoginItemSettings` registers `electron.exe <projectDir> --hidden` in HKCU Run.
  Default ON on first launch; persisted in `settings.open_at_login`. `--hidden` starts in tray with no window.
- Renderer: crude input (title + datetime-local) writing to `items` (+ `reminders`), quick-test buttons
  (+1 min, +5 min, 10 min in the past, test toast), reminders/items lists, app info, scheduler log (last 50).
- IPC is typed via `src/shared/types.ts`; the renderer only sees `window.api` from the preload.

## Phase 1 (conversation) — what exists
- `src/main/ai/provider.ts` — provider interface (`complete(system, messages, tools)` → text + toolCalls). Swap vendors here.
- `src/main/ai/gemini.ts` — `@google/genai` implementation. Function calling via `parametersJsonSchema`; 429 backoff 1/2/4/8 s
  with an `onThrottle` callback for the UI. **Gemini 3.x requires echoing `thoughtSignature` on replayed functionCall parts**
  (400 otherwise) — carried on `ToolCall.signature`. Locally invented call ids (`local_…`) are never sent back.
- Model: `GEMINI_MODEL` env or default `gemini-3.6-flash`. `gemini-2.5-flash` is rejected for new keys ("no longer available").
  Available Flash models on this key (2026-09-15): 3.5/3.6/3.7/3.8-flash, 3.5-flash-lite, flash-latest. Tier 1 later: `gemini-3.5-flash-lite`.
- `src/main/ai/tools.ts` — Zod schemas → JSON schema via `z.toJSONSchema`. Tools: create/update/complete/cancel_item,
  create/update/cancel/snooze_reminder, get_item, search_memory, get_today, get_upcoming. Times are exchanged as local
  wall-clock "YYYY-MM-DDTHH:MM" and converted to UTC in code. Items/reminders are referenced by 8-char id prefixes.
  `update_item` with a new due time moves pending reminders that sat on the old due time.
- `src/main/ai/context.ts` — context assembly (§4 lists) + in-memory focus stack (last 5 touched items).
- `src/main/ai/orchestrator.ts` — one message at a time (queue), tier 2 only, up to 4 tool rounds. All write tools in a round
  run in ONE transaction; failure rolls back and the model is told. Text arriving alongside tool calls is discarded; the reply
  is only what the model says after seeing tool results. `extractions` row per write round. `AppliedChange[]` (ground truth)
  is returned to the UI and shown as ✓ lines under the reply.
- Renderer: three zones (room+companion placeholder SVG · conversation · today rail). "debug" toggle swaps the rail for the
  scheduler log, extractions log, reminders and test buttons.
- Dev hook: `SECRETARY_CHAT="msg one||msg two"` runs a scripted conversation through the real orchestrator and quits.
- Verified (revised §7 list): "remind me to call the bank Thursday at 3" → task + reminder Thu 17 Sep 15:00; "actually make it 4"
  → same row, reminder moved to 16:00; "cancel the reminder for the bank" → reminder cancelled, task still open; "gotta finish the
  article tomorrow" → `day` precision, due_at_utc = local midnight, no clock time; "remind me to water the plants tomorrow" → day
  item + reminder at default 09:00 with the summary saying it's a default. Reply text only after commit.

## Spec third pass (2026-09-15) — what changed in code
- **Migration 3** (never edit 1/2): items +hardness +sort_order; `reminders` rebuilt as polymorphic (`target_type`/`target_id`,
  `offset_minutes`, state adds `paused`), old rows migrated with target_type='item'; new `events`, `notes`, `activities` tables.
- **Activities recorder**: every write tool records an `activities` row (verb, actor user|assistant|system, summary, before/after
  JSON). Scheduler records reminder_fired / reminder_missed / dismissed / delivery_failed / next-occurrence. `record_activity`
  tool stores completed actions ("I emailed the professor") as history, not tasks; `now_waiting_on` spawns a waiting item.
- **Undo** (`undo_last`, tier-0 "undo"/"undo that", header button): restores `before_json` of the last reversible user/assistant
  activity; created → row removed; deleted → row + its reminders restored; complete/cancel → item restored and ONLY the alarms
  that change stopped are revived (recorded as `before: {item, stopped:[ids]}`). Marks original irreversible, logs verb `undone`.
- **Confidence tiers in the tool layer**: `cancel_item` on a project or anything with `part_of` children, and `delete_item`
  always, return `confirm {question, wouldAffect}` and the round is rolled back; caller re-runs with `confirmed: true`.
  Orchestrator surfaces the question as the reply; UI uses window.confirm; model is told to relay it.
- **One call per message, asserted**: `MAX_MODEL_CALLS_PER_MESSAGE = 1`; read-only tool results are phrased in code
  (`phraseReadResults`), never a second call; `ai.call_budget_exceeded` error is logged if ever breached; the model is told it gets one response.
- **Manual editing** (`Editors.tsx`): ItemEditor (title, details, kind, status, due day/time with honest precision, hardness,
  reminders list + add, Done/Cancel/Delete…) and ReminderEditor (day, time, recurrence presets or custom RRULE, snooze when fired,
  pause/resume, cancel). Everything calls `window.api.runTool` → `applyExternalTools('manual','user')` — same tool layer.
  No importance control anywhere (spec: priority is inferred, never asked). Rail rows open editors; hover ✓ completes.
- **Reminder offer**: an exact-time item created without a reminder ends with "Want a reminder?"; a standing offer is kept
  in memory and a plain "yes" (tier 0) creates it. Any other write clears the offer.
- **Recurrence**: `rrule` validated on create/update_reminder; scheduler queues the next occurrence as a new pending row
  after delivery (DTSTART = the delivered fire time). RRULE across DST is untested (spec §9 risk).
- **Dedup in tier 0**: "remind me to X <date>" when an open item titled X exists → create_reminder on it, not a new item.
- Debug panel tabs: Scheduler · AI calls (last 20) · Activity · Extractions · Reminders.
- Dev hook `SECRETARY_CHAT` accepts `!tool_name {json}` lines for manual-tool steps with `$ITEM`/`$REMINDER` substitution.
- Acceptance A (spec §10) run 2026-09-15: steps 1–6 pass via the hook; step 7 (restart persistence) verified by relaunch.
  Toast buttons still only verified via simulated protocol URLs.

## Spec second pass (invariants) — how each is enforced
1. Honest precision: tools take `*_at_local` (clock stated → exact) OR `*_date_local` (day only → `day`/`week`/`vague`,
   stored as local midnight). `shared/format.ts#formatDue` never prints a clock for non-exact items. The system prompt forbids
   inventing times. Day-only reminders fire at preference `default_reminder_time` (default 09:00) and the summary says so.
2. `is_suggestion` + `confidence` on create_item; `confirm_suggestion` on update_item; rail shows "suggested" in italics and
   excludes suggestions from the Open count.
3. Every tool round (write or read-only) → one `extractions` row. Toast actions log under a `system` message tagged [toast].
4. Reply text is generated only after tool results (post-commit); text alongside tool calls is discarded.
5. cancel_reminder never touches the item; cancel_item/complete_item stop only that item's own alarms and report the count;
   status change, never deletion. Cascade across links (Phase 3) must ask first — prompt says so.
- Toast buttons (Done / Snooze 15 / Snooze 1 h / Reschedule): Windows `toastXml` with protocol activation `secretary://reminder/<id>/<action>`.
  Electron's `actions` option is macOS-only, hence XML. `app.setAsDefaultProtocolClient('secretary', electron.exe, [appDir])` in dev.
  The URL arrives via `second-instance` argv (or own argv on a cold start) → `handleProtocolUrl` → `applyExternalTools` → same
  tool layer. Reschedule opens the window and prefills the input. Falls back to a plain toast if the rich one fails.
- Gemini free tier is **5 requests/min per model** (not 15). **One message = one model call** in the common case: after a
  write round the reply is composed in code from `AppliedChange.phrase` (set inside each tool in `tools.ts`); the model is
  told not to write confirmations. A second call happens only for read-only tool rounds. `chat.done` log line reports
  `tier, model calls, changes, ms` per message — use it to check.
- Provider takes a model chain (`GEMINI_MODEL="a,b,c"`, default **gemini-3.5-flash-lite** → 3.6-flash → 3.8-flash): at the
  start of a turn a throttled model is skipped; mid-turn it waits for Google's `retryDelay` (the 1/2/4/8 s ladder is only the
  fallback when the hint is absent; cap 65 s). 503 is retried like 429.
- **Tier 0 router** (`src/main/ai/router.ts`, no model call, `messages.tier = 0`): done / finished · cancel the reminder ·
  cancel/scrap/drop <item> (not projects) · snooze [N min] / remind me again in N · move/make it <time|date> ·
  "remind me to X <date>" · imperative-verb + date creates (no reminder). Uses chrono-node (`casual`, forwardDate); a bare
  1–6 with no am/pm is read as afternoon; "next week"/"sometime" → `week` looseness. Targets resolve via the focus stack
  ("it/that") or a unique title-word match; anything ambiguous returns null and goes to the model. Executes through the
  same `runToolRound` (transaction + extractions).
- Rail: **Overdue** section (amber) for open items past due — precision-aware via `shared/format.ts#isOverdue` (exact: time passed;
  day: whole day over; week/vague: a week over), same rule in `repo.openItemsOverdue`. **Coming Up** shows alarms (🔔) and
  alarm-less dated items (📅 "no reminder") for 7 days, excluding overdue ones — "reflects exactly what exists".
- Tier 0 expands chat shorthand before parsing: tom/tmrw/tmr → tomorrow (only at the end or before a time/part of day, so
  "email tom about…" keeps Tom), tod → today, mon/tue/… → weekday names (`router.ts#expandShorthand`).
- Migration 2 adds the `constraints` table (tools for it come in Phase 3).

## Known quirks
- npm 11.19 blocks package install scripts by default ("allowScripts"). After `npm install`, if
  `node_modules/electron/dist/electron.exe` is missing, run `node node_modules/electron/install.js`.
- `vite` must stay on ^7 and `@vitejs/plugin-react` on ^5 — `electron-vite` 5 does not accept Vite 8.
- Dev hook: `SECRETARY_SCREENSHOT=<path.png>` saves a window screenshot ~2.5 s after load and quits.
- Toasts appear attributed to "electron.app.Secretary"-style identity while unpackaged; that's expected in dev.

## Verified on the user's machine (2026-09-15)
- Missed-reminder path: reminder due 12 min earlier, app closed, launched → delivered as "Missed reminder (12 min late)", toast shown.
- Live tick: reminder 40 s ahead fired on the next 30 s tick, toast shown, closed → acknowledged.
- User test: clicked "+5 min", closed the window (hidden to tray), toast fired 5 min later from the tray copy.
- Start-with-Windows entry exists in HKCU Run as `com.suhani.secretary`.

## What's untested
- The strict §7 test (Quit the app, restart Windows, don't open it, reminder still fires) — user chose not to
  restart. Everything it depends on is in place (Run entry, --hidden start, sweep), but it has not been observed.
  Re-offer it before Phase 1 is declared finished, or whenever convenient.
- Laptop lid close / hibernate not yet tested by actually doing it (spec §8).

## Commands
- User opens the app by double-clicking `Start Secretary.cmd` (their terminal panel has no `npx` on PATH).
- `npm run build` then `npx electron .` — build and run. `npm start` does both.
- `npx electron . --hidden` — run in tray only (what Windows startup does).
- `npm run typecheck`

## Next
- Phase 2 (revised spec): widen Tier 0 using the `tier` column; timezone review; RRULE for reminders is in but needs the
  "every Sunday recurs and survives restart" test and a DST-boundary test.
- Flash-Lite sometimes creates a duplicate instead of updating an existing Thing (seen once). Phase 3 dedupe by name similarity.
- Not yet built from the tool list: project/checklist/note/event/link/constraint tools, get_free_slots, check_conflicts,
  propose_plan (Phases 3–6).
- Observed once: a Gemini round took ~80 s with no 429 logged. Watch `ai.response` timings; if it recurs, add a request timeout.
- Not yet built from the tool list: add_link/remove_link, add_constraint/remove_constraint/check_conflicts (Phase 3), propose_plan (Phase 5).
- Toast buttons were verified only by simulating the protocol URL; a real click on a Windows toast is still to be observed by the user.
