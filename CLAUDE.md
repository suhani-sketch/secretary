# Secretary — working notes for Claude Code

Source of truth for the design is `SPEC.md`. This file tracks where the build actually is.
Update it at the end of every session (spec §11).

## Current phase: Phase 6 — Calendar and temporal planning. 6a built 2026-09-16 (testable); 6b–6f next. Phase 5 complete (§11F passed).

## Phase 6 — architecture decisions (2026-09-16)
- **Library: FullCalendar pinned to 6.1.21** (`@fullcalendar/core|react|daygrid|timegrid|list|interaction`, exact versions — they
  must match). Not v7 (shipped 2026-06/09, plugins re-packaged, too young). MIT; premium (resource/timeline) not used; keep the
  copyright headers in the bundle. The rrule plugin is NOT used: our own engine expands series.
- **Adapter:** `src/renderer/src/calendar/CalendarAdapter.tsx` is the ONLY file that imports `@fullcalendar/*`. It speaks
  `GridEntry`/`GridCallbacks` (our model), exposes `CalendarGrid` (month/week/day/list) and re-exports `ExternalDraggable`.
  A v7 upgrade or a swap touches this file alone. Theming via `--fc-*` CSS variables in `styles.css` (`.cal-grid`).
- **Platform-independent core:** `src/core/` (included in both tsconfigs; luxon + rrule only, no Electron, no SQLite, no repo).
  `core/recurrence.ts` (moved from main; `src/main/recurrence.ts` is a re-export shim), `core/calendar/occurrences.ts`
  (`expandEvents` — wall-clock rrule expansion with `exdates` exceptions, `scheduledMinutes`), `core/calendar/aggregate.ts`
  (`assembleDay(DayInputs) → DayBundle`, `dayStatus` light/normal/busy/overloaded, `unavailableMinutes`). A phone client could
  reuse all of it. `src/main/calendar.ts` is the SQLite glue (`buildDay`, `occurrencesBetween`); `planning.ts` (conflicts) still
  imports repo and moves to core when 6f touches it.
- **Migration 7:** `plans` table; `events.plan_id`, `events.session_state`; index on `events.starts_at_utc`.

## Phase 6a — redone against the full slice (2026-09-16, second pass)
- **Day View Model** (`src/core/calendar/aggregate.ts`, `assembleDay(DayInputs) → DayBundle`): four states — `scheduled`
  (occurrences with `span` single|starts|continues|ends), `unscheduled` (due, no time set aside), `overdue` (open, due before the
  viewed day AND already overdue now — carried into today and every future date; never a projection of things not yet due),
  `completed` (done or dropped that day; history, never load). `priorities: PriorityEntry[]` = item + score + reasons + overdue/
  blocked/scheduled flags (`scoreItem`: overdue +50 always in, commitment +30, hard deadline +25, critical +30 / high +15, due
  proximity, blocked −20, time-set-aside −10). Empty for past dates. `summary: DaySummary` = counts (priorities, due, scheduled,
  reminders, overdue, completed, hard_deadlines, high_importance, commitments), scheduled/due-effort/available minutes,
  conflicts (overlapping timed pairs), `status` (null for past dates). `notes: DayNote[]` = notes on the date + notes on items/
  events appearing that day, each saying what it is on. `projects` = Things the day's items belong to. `history` = the day's
  activities (past dates and today). `waiting` empty for past dates. `buildSummaries(from, days)` runs the same model per day
  for Month/Week (6d).
- **Migration 8:** `events.item_id` — a work block serves one obligation ("Thursday 6–8pm, case study" → work_block with item_id;
  the task is then `scheduled`, not `unscheduled`, and its priority score drops). `create_event.item_id`, `end_date_local`
  (multi-day all-day: ONE event, end exclusive), kind defaults to work_block when item_id is given.
- **Multi-day:** router "I'm in Delhi Monday to Wednesday" → one all-day event; `spanFor` marks starts/continues/ends per day;
  the day view lists spanning items under "All day" with the span word; grid titles carry "(continues)".
- **Past dates:** no priorities/status/waiting; Completed and "What happened" (activities) shown; `get_day` says "looking back"
  and reports reminder states. Router: "what did I do yesterday / what happened on monday" → get_day.
- **Week start:** setting `calendar.weekStart` (0–6, default 1 Monday) → adapter `firstDay`; control in the day header.
- Bugs fixed on the way: bare "note: thursday - …" now a DATE note (was attached to the focused item); "3:30" with no am/pm
  read as 03:30 (now afternoon like a bare "3"); "cancel the dentist" failed because the model never saw events (context now
  lists 14 days of occurrences with ids; tier-0 cancel-by-title added); the empty all-day "due" row in the day grid removed.
- Verified on scratch DB c2: overdue-from-yesterday appears as the top priority today and on every future day; a task with a
  work block leaves Due today and shows as "time set aside"; Delhi Mon–Wed is one event, "continues" on Tuesday; yesterday shows
  no priorities and reads "looking back"; a completed item sits in Completed, not in load. §11C 23 and 24 exercised, 25 (week
  start) built and persisted.

## Phase 6a — first pass (2026-09-16)
- Types: `CalendarEvent`, `Plan`, `EventOccurrence` (series row + `occurrence_start_utc`/`occurrence_end_utc`), `DayBundle`
  (date, status, scheduled_minutes, priorities, due, schedule, reminders, waiting, happenings, notes, completed, constraints).
- Repo: `insertEvent/getEvent/updateEvent/deleteEventRow/restoreEvent/resolveEventId/eventsTouching/itemsForDay/
  remindersBetween/happeningsBetween`. IPC `events:list` (expanded occurrences) and `calendar:day`.
- Tools: `create_event {title, starts_at_local|date_local, ends_at_local|duration_minutes, rrule?, kind commitment|work_block,
  project_id?, override_conflicts?}` — hard clash → refused with an alternative + `conflict_override` Offer ("book it anyway"
  replays it); `update_event {id, …, occurrence_start_local?}` — a single occurrence of a series becomes an exdate + a standalone
  event, the series is never rewritten; `delete_event {id, occurrence_start_local?}`; `get_calendar`, `get_day` (read, phrased in
  code). Events take the focus stack (`FocusEntry.kind='event'`) so "move it to 4" / "cancel it" target the meeting just made.
- Router: "meeting/call/dentist/class… <day> at <time>" → create_event (kind commitment when people are involved); "move it to 4"
  on an event focus → update_event; "cancel the dentist" → delete_event by title among the next 60 days; "what am I doing
  thursday?" → get_day; "note for thursday: …" → date note. `parseWhen`: "3:30" with no am/pm is now afternoon like a bare "3".
- Context: "Calendar, next 14 days" lists expanded occurrences WITH ids (the model needs them for update/delete).
- UI: header "calendar" ↔ "chat" toggle swaps the centre pane. `calendar/DayView.tsx`: ‹ today › navigation, descriptive status
  pill, then Priorities → Due today → Reminders and follow-ups → Notes → Completed (collapsed) on the left and the Schedule time
  grid (06:00–24:00, no all-day row) on the right; unavailable constraints as hatched background bands, timed happenings dashed.
  Importance/hardness shown as glyph + word, never colour alone. Clicking an item opens the editor; clicking an event prefills
  "Move … to " in the chat (event editor arrives with 6b/6e). Dev hook `SECRETARY_VIEW=calendar[:YYYY-MM-DD]`.
- Verified on a scratch DB across two runs: meeting created → moved to 4 → task due Thursday appears under Due, not in the grid →
  reminder listed separately → date note under Notes → busy 12–14 shaded → dentist 15:30 refused as a hard clash with an
  alternative → "book it anyway" books it → cancel by title → persisted across the restart. §11C 1, 2, 4, 5, 6, 18, 22 exercised;
  3, 7–17, 19–21, 23 are later slices. Phase 4 companion + room built and committed.

## Phase 5a — happenings core (2026-09-16)
- **Migration 5**: `happenings` (spec §3) + a `kind` column (addition: lets micro-rituals remember a "no" per kind). Deliberately
  separate from `activities`: no happening ever calls `act()`; nothing about one is written to items/reminders/activities. Not undoable.
- `src/shared/happenings.ts`: metaphor system (egg/tea/laundry/plant/download/focus → stage words; last stage = finished; the first
  stage is only the opening 8 %; open-ended sits in stage two), `stageFor`, `formatRemaining`. Plain timer where no metaphor fits.
- `src/main/happenings.ts`: deterministic recognition — `detectHappeningStart` ("I've put an egg on for 8 minutes", "started the
  washing machine", "making tea", "starting a 25 minute focus session", "charging my phone", "I'm taking a shower", "set a 10 minute
  timer") → {label, kind, metaphor, minutes|null}; refuses anything that reads as an obligation/alarm (need to, tomorrow, remind me).
  `detectHappeningEnd` ("laundry's done", "egg's ready", "I'm out of the shower", "never mind the tea") → fragment + done|abandoned.
  `parseDurationMinutes`, `kindForLabel`.
- Tools `start_happening {label, minutes?, metaphor?, project_id?}` / `finish_happening {id?|label?, outcome}` (write tools →
  transaction + extractions row, but NO activity). Duplicate label while running → "already on". Finishing something that already
  ended → friendly "already finished at HH:MM" (matching prefers the most recent on a tie).
- Router (before the availability rule, so "I'm out of the shower" is not a constraint): end phrases first (running match → finish;
  recently ended match → REPLY "Yes — finished at …"), then start phrases. Repo: `insertHappening`, `runningHappenings`,
  `dueHappenings`, `happeningsForWindow`, `finishHappening`, `recentlyEndedHappenings`, `matchHappening`.
- Scheduler: `endDueHappenings` in tick and startup sweep — marks done, one plain toast (metaphor doneLine or "<label> — time's up."),
  no buttons, "Finished at HH:MM, while I wasn't running" when noticed late. Log event `happening.ended`.
- Context: "Happening right now" section. Prompt: four-way table (task / happening / reminder / resolved).
- UI: `Happenings.tsx` `RightNow` card at the top of the rail — glyph, label, stage word, exact remaining/elapsed time ticking each
  second, ✓ / × on hover; finished ones faded for 15 min. IPC `happenings:list`. Never in Open.
- Verified on a scratch DB: egg 1 min → row, no item; "I need to do laundry tomorrow" → task; "started the washing machine" →
  happening; "remind me to move the laundry in 45 minutes" → task + reminder; laundry's done / never mind the tea / out of the
  shower → finished/dropped; egg expiry via startup sweep → toast; activities table has zero happening rows.
## Phase 5b — pictures and the room reacting (2026-09-16)
- `Happenings.tsx` `MetaphorIcon`: small SVG per metaphor whose picture follows the stage (egg yolk sets, tea darkens, drum spins
  then stops, plant grows, hourglass sand moves, candle burns down); plain stopwatch when there is no metaphor. Illustration only.
- `Signals.happening` ('focus' | 'cooking' | 'waiting' | null), derived in App.tsx from running happenings (focus wins, then
  egg/tea/cooking/plant, then laundry/charging/process). `resolveState` step 4: focus → working at the desk; cooking → idle, which
  the Room turns into the new `kitchen` pose; waiting → reading on the cushion. Ambient rotation resumes when nothing runs.
- Room: `Kitchen` (side table, ring, pot, steam) is drawn at the right only while something cooks; creature spot beside it, facing
  it (Companion `pose` override prop, 'kitchen' tilts/pupils to the right). Personal happenings (shower, break) change nothing.
- `METAPHORS[*].openEnded`: stage shown while open-ended (laundry "washing", others stage two).
## Phase 5c — micro-rituals and rationed personality (2026-09-16)
- **Micro-rituals**: `RITUALS` in tools.ts (tea 5 min, egg 7, focus 25, break 10 — only kinds with a sensible default). An
  open-ended `start_happening` of such a kind sets Offer `{kind:'ritual', happeningId, happeningKind, minutes, label}` and asks once
  ("Want a 5-minute steep timer?"), unless setting `ritual.declined.<kind>` = '1'. Tier 0: "yes" → `time_happening {id, minutes}`;
  "yes, 4 minutes" / "6 min" → that length; "no" / "no thanks" / "nah" / "I'm fine" → `decline_ritual {kind}` which writes the
  setting and says it won't offer again. Both are write tools with no activity row. A declined kind covers its whole kind
  (declining tea also silences coffee/chai). The model is told offers are the app's business.
- **Personality** (`src/main/personality.ts`, `personalityLine(applied, userText)` called once in the orchestrator after a clean
  change): pools per event (start:egg/tea/laundry/focus/cooking/charging/process/break, happening_done, item_done, step_done,
  project_done). Rule 1 never twice: used lines stored for good in setting `personality.used`; exhausted pool = silence. Rule 2
  occasionally: ≥90 min gap (`personality.last_at`) and ≤3 per day (`personality.count.<date>`). Rule 3 never when struggling:
  strain words in this or the last 4 user messages, ≥3 overdue items, or the finished item itself overdue → silence. Never after
  undo/cancel/delete/snooze or an error. A trailing question (timer offer, "Want a reminder?") stays last; the line slips in before it.
  `AppliedChange.tag` carries the happening kind / 'project' for the classifier.
- Finishing lines follow the label (`doneLineFor`): "Tea's ready." only for tea/chai, "Coffee — ready." otherwise; scheduler toasts too.
- Verified on scratch DBs: offer → yes → 5-min timer; no thanks → declined and never re-offered for that kind; "6 minutes" custom
  length; one line on the first change then silence for 90 min; "I'm exhausted today, everything is behind" → the next changes get
  no line at all; "tea's ready" with tea and coffee both running picks the tea (label outranks kind).
- Phase 5 done-when check: "I've put an egg on for 8 minutes" → visible egg that progresses and resolves, no task; "I need to do
  laundry tomorrow" → task; room reacts. "A week of use has produced no clutter in Open" is for the user to observe.

## Phase 5d — context and commitments (2026-09-16); spec invariant 9 (never convert a statement into an unwanted timer/task/reminder/interaction)
- **Bare statements create nothing.** `detectHappeningStart` now returns `bare` for tea/egg/cooking with no duration ("I'm making
  dinner", "I'm making tea", "cooking lunch"). Router: bare + a kind with a default timer (`RITUALS`, exported from tools.ts) and not
  declined → Offer `{kind:'ritual', happeningId:null, …}` + REPLY "Tea — want a 5-minute steep timer?" (no row); "yes"/"6 minutes" →
  `start_happening` with minutes; "no" → `decline_ritual`. Bare + no default or declined → a plain reply (`plainAcknowledgement`),
  nothing created. Things with their own clock (wash, charge, download, focus, shower) are still happenings. Compound "I'm making
  dinner, remind me to check it in 20 minutes" → `start_happening` + `create_item` with reminder, "it" → "the dinner".
- **Context** (today only, never memory): `note_context {kind energy|mood|location|availability|other, text}` → repo `addContext`
  stores under setting `context.<today>` (older keys deleted); `todayContext()` feeds the context assembler ("Today's context …
  NEVER store"), the personality guard (energy/mood → no lines) and `get_forgetting`'s closing line. No item/note/activity/preference.
  Tier 0: "I'm exhausted/tired/low/stressed… (today)" → note_context; "I'm at TISS until 5" → note_context + a same-day
  `add_constraint unavailable` so nothing is booked there (constraints expire when the window ends).
- **Commitments**: migration 6 `items.committed_to`. `create_item kind=commitment, committed_to`; `update_item.committed_to`;
  `publicItem.committed_to`; editor shows "Promised to" for commitments; rail badge "to Priya" (rose). Tier 0: "I told X I'd Y
  <when>" / "I promised X …" / "I said I'd Y to X" / "X is expecting me to Y" → commitment (him/her → X). Context lists "Open
  commitments" and marks items "COMMITMENT to X — they are expecting it". Phrase: "you told Priya you'd send the draft … I'll hold
  it as a promise, not just a task."
- **"What am I forgetting?"** → tier-0 `get_forgetting` (read tool, phrased in code): promises first (with who), then overdue,
  waiting, coming up (2 days); adds "you said you're exhausted today — for the record, not a push" when today's context says so.
- Prompt: the four-way separation extended with context and commitments; "saying what you are doing is not a request".
- **§11F run 2026-09-16 on a scratch DB with a real quit + relaunch between steps 5 and 6 — all six pass:** (1) "I'm making dinner." →
  no row, plain reply; (2) + "remind me to check it in 20 minutes" → dinner happening + "Check the dinner" task with reminder;
  (3) "I need to make dinner tomorrow." → task, day precision; (4) "I'm exhausted today." → context setting only, no item/note/
  preference/activity, and both "what am I forgetting?" and "what should I do right now?" reflected it; (5) "I told Priya I'd send
  the draft tonight." → commitment to Priya, listed before the equivalent plain task "Send the report"; (6) "I'm making tea." →
  offer only; "no" → remembered; second "I'm making tea." → "Enjoy the tea.", nothing created.
Phase 3 slices 3a–3f built. **§11B TISS run passed end to end 2026-09-16** (steps 1–6, real quit + relaunch, steps 7–10) on a
scratch database via `SECRETARY_USER_DATA` — one project, no duplicates, conditional follow-up Fri 14:00 with `unless_resolved`.
Fixes that came out of it: "I haven't sent it yet" is a tier-0 no-op reply (it used to become a waiting item, and step 6 then
falsely "resolved" it); `record_activity` now goes through `act()` so `activities.project_id` is filled (it was null, so "what have
I done for X" missed recorded progress — backfilled in the real DB too); "what is left / what have I done for X" are tier-0 →
`get_project` phrased in code (steps, waiting, "Done so far", history) instead of a from-memory model answer that skipped the wait.
**Phase 0 reboot test run 2026-09-16 20:20 — FAILED.** Reminder for 20:27, app quit, Windows restarted, nothing appeared. Evidence:
no `app.start` in `scheduler_log` after the reboot, no crash in the Windows Application log, and the Shell-Core operational log
(events 9705–9708) shows Explorer enumerating HKCU\...\Run at 20:21 and starting HP, BlueStacks and Proton Drive but NOT
`com.suhani.secretary` — the entry is present and correct, and the identical command works when run by hand (takes ~20 s to reach
4 processes on this machine). Cause of the skip unknown (no StartupApproved entry, no policy, no mark-of-the-web; electron.exe is
unsigned). Missed-reminder recovery DID work: launching the app at 20:31 showed "Missed reminder (4 min late)" and the user snoozed it.
Fix in place: the user registered a per-user Task Scheduler logon task `Secretary` (at log on, 20 s delay, `electron.exe <dir>
--hidden`, start-in <dir>, allowed on battery, no time limit) alongside the Run entry; the single-instance lock makes a double start
harmless. Diagnostic: `<userData>/startup.log` gets one line per launch before anything else.
**Restart test DEFERRED by the user (2026-09-16 21:00) — do not raise it again; they will say when.** When they do: quit, restart,
don't open the app, then read (1) `Get-ScheduledTaskInfo Secretary` LastRunTime/LastTaskResult, (2) startup.log, (3) the
Microsoft-Windows-Shell-Core/Operational log events 9705–9708. A test reminder "Check the reboot test three" (21:09) was left pending.

## Phase 4 — design decisions (see SPEC §8 Phase 4 "Design decisions")
- Dormouse-quokka, scarf only, unnamed, rare eye contact, a life of its own (pose changes every few minutes, never performs).
- Environments in this phase: trees, rain, coast, winter, library, fireplace; time of day layered over each (auto or pinned).
  Settings keys `scene.environment` / `scene.timeOfDay` in the `settings` table via `settings:get/set` IPC.
- Deferred: favourites/rotation, weather/season, room growth, naming moment.
- `happenings` (§3) is a Phase 5 table for ephemeral real-world activities; it is deliberately separate from `activities`
  (permanent history + undo). Nothing about a happening is ever written to `activities`.

## Phase 4 — what exists (built 2026-09-16, testable)
- `src/renderer/src/companionState.ts`: 12 states, `Gaze`, `Signals`, `resolveState` (process > momentary > attentive > ambient),
  `useCompanion` (700 ms min dwell, 1 s heartbeat). Ambient pose changes once per 4-min slot (deterministic hash), sleepy 22:00–06:00.
  Momentary durations: celebrating 2.6 s, greeting 2.4 s, happy 1.4 s, concerned 6 s. Eye contact only for greeting, celebrating,
  and happy/attentive within 15 s of being addressed directly.
- `src/renderer/src/Companion.tsx`: layered SVG 120×120, `poseFor(state)` → sit/desk/read/window/curl/stand/stretch; props (book,
  pencil), thinking dots, sparkles, "z"; CSS breathe/blink/tail only. `src/renderer/src/Room.tsx`: viewBox 260×900 bottom-anchored,
  window (or bookcase for library), shelf, desk with laptop that opens while working, mug steam in the morning, lamp glow evening/
  night, hearth for fireplace, rug + cushion; creature placed by pose. "scene" button → Window env chips + Light chips.
- `App.tsx` drives the signals from real activity: chat status, typing, last tool names, applied changes, celebration on completing
  a Thing / last checklist step / archive, greeting once per day (localStorage `companion.greeted`), concerned on errors or a rising
  overdue count, direct address by regex. Dev hook: `SECRETARY_VIEW="state:<state>,light:<band>,env:<env>"` (URL hash).
- Not done in this phase: favourites/rotation, weather/season, room growth, naming.

## Phase 3f — Dependencies and constraints (2026-09-16)
- Dependencies: `links` type `blocks` (from = blocker, to = blocked). **Blocked is computed, never stored**: `repo.blockersOf`
  (open blockers), `blockedByThis`, `newlyUnblockedBy`. Context marks "BLOCKED by [id] …"; `publicItem` carries `blocked_by`;
  the rail shows "⛔ blocked by …"; the item editor has a Blocked-by block (add via select / remove) through `add_link`/
  `remove_link`. Completing a blocker says "That unblocks X" (computed). Circular blocks are refused. Both undoable.
- Constraints: `constraints` table (migration 2). `add_constraint {kind unavailable|prefer|avoid, label, starts/ends_at_local |
  date_local, rrule?}`, `remove_constraint {id | label}`; undoable. `repo.activeConstraints` keeps standing (rrule) rules and
  one-offs until their window ends.
- `src/main/planning.ts` (deterministic): `constraintWindows` (expands rrule via recurrence.ts wall-clock), `conflictsFor(start,
  end)` over constraints + events, `blockingConflicts` (unavailable + events), `describeConflict`, `afterConflicts`,
  `bookingWindowForDue` (the hour ending at an exact due), `PART_OF_DAY` (morning 8–12, afternoon 12–18, evening 18–22).
- **Conflict gate in the tool layer** (`conflictGate` in tools.ts): create_item/update_item with an exact due inside a hard
  clash → the round is rolled back with a confirm question ("…clashes with "busy" Thu 12:00–18:00. Book it anyway, or would
  18:00 onwards suit?"); `override_conflicts=true` books it and says so; avoid/prefer clashes are booked with a note. Day-only
  dues are only gated by whole-day unavailability. `check_conflicts` read tool, phrased in code.
- Tier 0: "I'm busy/travelling/out/in class … <day> [morning|afternoon|evening|all day | 2-5 | every tuesday]" → add_constraint;
  "X blocks Y" / "Y depends on X" / "can't do Y until X is done" → add_link (both sides entity-resolved; else model).
- Rail: "Unavailable / preferences" section with × remove. Spec 3d's "travelling Friday" now lands as a constraint (unavailable
  all day), not a date note — the prompt says so; date notes remain for other information.

## Phase 3e — Activity history in the UI (2026-09-16)
- `ProjectView.tsx`: clicking a Thing row opens its view (Overview: steps with tick boxes, tasks, waiting-on with "replied ✓",
  alarms, notes; Timeline: `activities` for the project grouped by day, actor badges you/secretary/system, optional hide-system).
  `ItemHistory` (from the item editor's History button) shows one item's activities. Both read `activities` via IPC
  (`activitiesForProject`, `activitiesForItem`); the model is never involved.
- "What have I done for X?" is answered from `search_activity`/`get_project` results phrased in code (already true since 3a).
- Dev hook: `SECRETARY_VIEW=project|history` opens that view on load (hash), pairs with `SECRETARY_SCREENSHOT`.
- Editor: History/Timeline button; project rows open the view, other rows the editor.

## Phase 3d — Notes on anything (2026-09-16)
- `notes` table (migration 3): target_type item|event|reminder|date, target_id (ISO date for 'date'), body, source user|assistant.
  Repo: insert/get/update/delete/restore, `notesFor`, `dateNotesBetween`, `searchNotes`, `listNotes`. No FK on notes.
- Tools: `add_note {body, item_id | item_title | reminder_id | date_local}` (item_title resolved with entity.ts over projects
  then items), `update_note`, `delete_note`. Activities target_type `note` (verbs note_added/updated/deleted) with undo for all
  three. `get_item` and `search_memory` return notes; `phraseReadResults` speaks them.
- Context: item lines carry up to 3 notes; "Notes on upcoming days" section (yesterday..+14d) so day notes inform planning.
- Tier 0: "add a note to X that/saying Y" (X resolved by entity match or it/that), "note: Y" (→ focused item, else today's date).
- Window: 📝 day notes inside Coming Up (open → NoteEditor: edit/remove); ItemEditor has a Notes block (add/edit/remove).
- Day notes are information: never a task, no reminder. Feelings are not notes (prompt).

## Phase 3c — Waiting items and conditional follow-ups (2026-09-16)
- Waiting item = `items` kind `waiting`, `waiting_on` = who, `details` = about, expected reply as a SOFT due date (day
  precision), `part_of` the Thing in focus. `createWaiting` helper (tools.ts) reuses an open wait on the same person within
  the same project instead of duplicating; `record_activity.now_waiting_on` routes through it.
- Tools: `create_waiting`, `resolve_waiting {id | waiting_on, outcome replied|received|no_longer_needed, note}` (completes the
  item, stops its alarms AND cancels every reminder whose `condition_json` watches it), `create_reminder.unless_resolved`
  (→ `condition_json {"unless_resolved": "<item id>"}`; refused if the watched item is already resolved).
- **Deterministic evaluation** (spec 3c): `scheduler.conditionBlocks(r)` runs at fire time in both the tick and the startup
  sweep, reads the watched item's status from SQLite, and if resolved cancels the reminder with a system activity
  ("Follow-up … dropped — resolved") and no toast. No model is involved anywhere. An unparseable condition never silences a reminder.
- Conditional toasts read "Still waiting on X — No reply by <time>. Want to follow up?".
- Tier 0: "TISS replied" / "they got back to me" / "heard back from X" / "the transcript arrived" → `resolve_waiting` when the
  target is unambiguous (single open wait, a name match, or the one wait under the Thing in focus); otherwise the model asks.
- Window: "Waiting on" section (⏳, who · about, expected/overdue, project, follow-up time) with a "replied ✓" quick action;
  waiting items are excluded from Open. Reminder editor explains a conditional follow-up. "What is left?" separates
  waiting from steps.
- Verified: B7/B8 through the model; follow-up fires (as missed) when unresolved; dropped by the scheduler when the item was
  resolved directly in the DB; dropped immediately by tier-0 "TISS replied".

## Phase 3b — Checklists (2026-09-16)
- Checklist steps are `items` kind `checklist_item`, `part_of` a project, ordered by `sort_order` (`repo.nextSortOrder`,
  `setSortOrder`, `checklistItems`). They are excluded from the standalone Open list and count; the window nests them under
  their Thing with a tick box, ↑↓ reorder and × strike-off, all through `runTool`.
- Tools: `add_checklist_item {project_id, titles[]}` (skips exact duplicates; ONE activity for the batch, target_type
  `checklist`, so one undo removes all), `complete_checklist_item {id | title, project_id?}` (title resolved with
  `entity.ts`, whose tokens are now lightly stemmed so "sent the first email" → "Send first email"), `remove_checklist_item`
  (cancel), `reorder_checklist` (undoable), `promote_checklist_item` (→ task, keeps part_of). `get_project` excludes cancelled parts.
- Tier 0: "add a list (for …)" → a canned reply (router `REPLY` spec, no tool, no model) and a `checklist_target` offer;
  "add A, B and C" with a Thing in focus (offer → focus stack project → focused item's parent) → `add_checklist_item`, split on
  commas/and/;. "I sent the first email" goes to the model → complete_checklist_item by title (1 call).
- "What is left?" → model calls get_project; answer phrased in code: still to do / done / recent history.
- Verified B1, B4, B5, B6, B10 in one run + restart; reorder and its undo via the manual hook.
- Note: the user has real data now ("TISS mailing" with a task + due date) — never treat it as debris.
Phases 0–2 complete. Test A (§11A) re-run in full 2026-09-16 including steps 4/5/7: pass. Toast buttons confirmed working by
a real click (user snoozed "Call tom" on 2026-09-16). Phase 0's strict reboot test still not observed (user choice).

## Phase 3a — Projects/Things (2026-09-16)
- Projects are `items` with `kind='project'`; parts attach with `links` type `part_of` (child → project). No schema change.
- `src/main/entity.ts` (pure; `node tests/entity.test.ts`): `nameSimilarity` = max(word Dice, trigram Dice, containment×0.9);
  `resolveEntity(name, pool, recentIds)` → match (≥0.75) / maybe (≥0.45) / none; focus-stack ids get +0.1.
- Tools: `create_project` (resolves first: match → returns the existing project, no row; maybe → confirm question + a
  `project_match` Offer so tier-0 "yes"/"no, new project" answers it; none/force_new → create), `archive_project` (confirm,
  archives parts), `attach_to_project`, `detach_from_project`, `get_project`. `create_item` takes `project_id` or `project_title`
  (resolves or infers the project). `act()` fills `activities.project_id` (denormalised) for parts and projects;
  `repo.activitiesForProject` powers "what have I done for X" via `get_project`/`search_activity`, phrased in code.
- Context lists every open project with its parts and last activity; items show "part of [id]". Prompt has a Things section.
- Tier 0: "X is something I need to deal with" / "start tracking X" → create_project; Tier 0 titles keep the user's casing via
  `restoreCase` (matching is lower-cased). Window: "thing" badge with open-part count, "part of X" on children, "Part of"
  selector in the item editor (attach/detach through the tool layer).
- Verified: TISS opening lines (create → task attached → activity on project → typo'd rename resolves → due set) and
  "IIM app" matching "IIM application"; persists across restart; one project each, no duplicates.

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
- **Toast activation needs TWO registrations on Windows**: the `secretary://` protocol (HKCU\Software\Classes\secretary, written by
  `setAsDefaultProtocolClient(protocol, electron.exe, [appDir])`) AND a Start Menu shortcut carrying `System.AppUserModel.ID =
  com.suhani.secretary` (`shell.writeShortcutLink` → `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Secretary.lnk`, written at
  every start). Without the shortcut the toast shows but button/body clicks fail with "Get an app to open this 'secretary' link",
  even though `Start-Process secretary://…` and `Launcher.LaunchUriAsync` both work (verified 2026-09-16). Look for
  `toast.received action=… ` in the log when testing buttons; `notify.clicked` is only the body click.
- Toast buttons (Done / Snooze 15 / Snooze 1 h / Reschedule) use **Electron's native `actions` — supported on Windows in
  Electron 44** (my earlier "macOS-only" note was wrong for this version). Live toast → `Notification 'action'` event with
  `actionIndex` → `dispatchToastAction` → `performReminderAction` → `applyExternalTools('toast','user')`. After a restart /
  GC → `Notification.handleActivation` (win32) with `ActivationArguments`; the notification `id` is `reminder:<uuid>` and is
  parsed out of `details.arguments`. **Protocol activation (`toastXml` + `secretary://`) failed on this machine** with "Get an
  app to open this 'secretary' link" even though the registry, ACLs, `Start-Process` and `Launcher.LaunchUriAsync` were all fine —
  kept only as a diagnostic path (`handleProtocolUrl` → same `performReminderAction`). Reschedule opens the window and prefills the input.
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

## Phase 2 (2026-09-16) — recurrence
- `src/main/recurrence.ts` (pure, no app imports; unit tests in `tests/recurrence.test.ts`, run with `node tests/recurrence.test.ts`):
  `nextOccurrenceUtc(series, afterUtc)`, `firstOccurrence(rrule, clock, tz, nowUtc)`, `parseRecurrencePhrase(text)`, `describeRRule`.
  All arithmetic in the user's wall-clock zone via "fake UTC" dates through the rrule library, so a 09:00 daily alarm stays
  09:00 across DST (tested London autumn + New York spring). The rrule package's CommonJS bundle has no detectable named
  exports under Node ESM, hence the `import * as rrulePkg` shim.
- Migration 4: `reminders.series_anchor_local` ("yyyy-MM-ddTHH:mm") + `series_tz`. Set whenever rrule is set; re-anchored when
  the fire time changes; cleared when the rule is removed. The scheduler computes the next occurrence from the anchor after
  max(now, this firing's slot) — so a snoozed firing does not drift the series — and inserts it as a new pending row.
- `create_item.remind_rrule` (+ `remind_at_local` = first occurrence); `create_reminder.rrule`. Tier 0: "remind me to X every
  sunday at 5 / every morning / daily / every weekday / on mondays and thursdays / every other week / every 3 days";
  clock comes from an explicit time, else a part-of-day hint, else `default_reminder_time`.
- **Tooling gotcha that cost an hour:** the Bash tool un-escapes `\\` before the shell sees it, so a Python heredoc containing
  `"\\b"` writes a literal BACKSPACE (0x08) into the file — the regex silently never matches. Never patch regexes through
  Python/heredocs here; use the Edit/Write tools. Scan with `grep -rnP "[\x01-\x08\x0B\x0C\x0E-\x1F]" src` if a regex "can't" fail.

## Dev hooks
- `SECRETARY_USER_DATA=<dir>` runs against a scratch database in that folder (own single-instance lock, so it runs beside the real
  app) and skips the login item, Start Menu shortcut and protocol registration. Use it for acceptance runs; never test on the real DB.
- `SECRETARY_CHAT`, `SECRETARY_SCREENSHOT`, `SECRETARY_VIEW` as described elsewhere in this file.

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
- Phase 3c — waiting items (kind=waiting, waiting_on, visually distinct) + conditional follow-ups: "if they haven't replied by
  Friday afternoon, remind me" → reminder with `condition_json {"unless_resolved": "<item_id>"}` evaluated deterministically in
  the scheduler at fire time. Then 3d notes, 3e project timeline view, 3f blocks/constraints. §11B steps 7–9 remain.
- Undo does not yet cover attach/detach/archive (recorded as irreversible).

## Deletion and undo — audited 2026-09-16
- Item rows are deleted in exactly one place, `repo.deleteItemRow` (callers: confirmed `delete_item`, undo of a `created`
  activity). It releases every FK that can point at an item: `links` (cascade + explicit), `activities.project_id`,
  `events.project_id` — the full list is `PRAGMA foreign_key_list` per table; re-audit it whenever a migration adds a FK.
- `delete_item` records a `DeletionSnapshot` (item, alarms, links, activity ids, event ids) as `before_json`; undo of a deletion
  uses `restoreFromSnapshot` so parts re-attach and history/event pointers come back. Verified: project with part + alarm +
  history + event → delete → undo → identical, `PRAGMA foreign_key_check` clean.
- The one observed "FOREIGN KEY constraint failed" on undo was the pre-fix build; the transaction rolled back and the reply said
  nothing changed, which is the intended failure behaviour (invariant 4).
- Phase 2 leftovers, not blocking: recurring alarms can't yet be described with an end ("until December") or count; the
  `tier` column shows ~40% tier 0 so far — keep widening Tier 0 as real phrasing accumulates; tomorrow/yesterday edge cases
  around midnight untested.
- Flash-Lite sometimes creates a duplicate instead of updating an existing Thing (seen once). Phase 3 dedupe by name similarity.
- Not yet built from the tool list: project/checklist/note/event/link/constraint tools, get_free_slots, check_conflicts,
  propose_plan (Phases 3–6).
- Observed once: a Gemini round took ~80 s with no 429 logged. Watch `ai.response` timings; if it recurs, add a request timeout.
- Not yet built from the tool list: add_link/remove_link, add_constraint/remove_constraint/check_conflicts (Phase 3), propose_plan (Phase 5).
- Toast buttons were verified only by simulating the protocol URL; a real click on a Windows toast is still to be observed by the user.
