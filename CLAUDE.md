# Secretary — working notes for Claude Code

Source of truth for the design is `SPEC.md`. This file tracks where the build actually is.
Update it at the end of every session (spec §11).

## Current phase: Phase 1 — built; §7 Phase 1 test passes (2026-09-15). Phase 0's strict restart test still skipped by user choice.

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
- Verified: "remind me to call the bank Thursday at 3" → task + reminder Thu 17 Sep 15:00; "actually make it 4" → same row
  updated, reminder moved to 16:00; reply text produced only after commit.

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
- Phase 2: chrono-node fast path (tier 0 router), timezone-correct storage review, RRULE recurrence.
- Observed once: a Gemini round took ~80 s with no 429 logged. Watch `ai.response` timings; if it recurs, add a request timeout.
- Not yet built from the tool list: add_link/remove_link (Phase 3), set_preference, propose_plan (Phase 5).
