# Secretary — working notes for Claude Code

Source of truth for the design is `SPEC.md`. This file tracks where the build actually is.
Update it at the end of every session (spec §11).

## Current phase: Phase 8 — Proactivity is COMPLETE. 8a (morning briefing), 8b (approaching-deadline alerts), 8c
(missed-task and waiting-item follow-up), 8d (adaptive intensity, quiet hours) built and tested; SPEC.md's own Phase 8 line
has no lettered slices at all (8a–8d were this session's own organisational split, not spec text) — "conversational
replanning" is PARTIALLY covered by 7f (full preview, nothing moves without approval, a proactive nudge) but NOT by a
7g-style multi-turn refined-proposal loop for `replan_sessions`; a real, known gap, confirmed live, not built (see §11D
section below). **§11D application acceptance run 2026-09-18 on a fresh scratch DB across a real restart: 7 of 10 steps
passed outright; 3 genuine bugs found (a forward-looking reluctance statement mechanically logged an avoid constraint
instead of empathy+alternative; "move it"/"cancel the reminder" reused the last-focused item's id as the wrong entity type
and threw instead of rerouting/answering gracefully; a bare-day move on an exact-time item silently dropped the time) — all
three FIXED and re-verified live + via direct DB read on a fresh scratch DB (see their own section below).** **Phase 7 —
Intelligence is
COMPLETE** (7a brain dump typed+voice, 7b deadline intelligence, 7c what-should-I-do-now, 7d what-am-I-forgetting, 7e smart
scheduling, 7f replanning, 7g conversational planning; unit tests cover 7b/7c/7e/7f/7g core logic). Governing rule for Phase 7
carries forward into 8: compute in code, the model only phrases — every answer costs at most ONE model call (§11G 14; 8a costs
ZERO). **§11G re-run 2026-09-18 on fresh scratch DBs (after both fixes
below): 13 of 14 steps pass; step 2 (the same brain dump spoken) could not complete — genuine Gemini free-tier DAILY quota
exhaustion specifically on the stronger models voice requires (`preferStrong` skips the cheap model entirely), confirmed by a
plain "hello" still succeeding instantly on the healthy model while voice sat in the retry ladder 15+ min before being killed.
Not a code defect — the voice pipeline itself is unaffected by either fix below and was already verified working (this same
session, and the original Phase 7 "Voice" build).** Two real bugs found INCIDENTALLY while testing §11G the first time (not part
of what §11G checks) were spawned as separate follow-up sessions and are now FIXED (see their own sections below): a
stated-duration phrase ("it'll take 15 minutes") starting with an imperative verb was misread as a due time by the tier-0
imperative-create rule, and `add_link` threw and rolled back the whole turn when the dependency's blocked side didn't exist as
an item yet ("I can't sign the lease until X" said before "sign the lease" was ever mentioned). Phase 6: 6a–6f built. **§11C run 2026-09-17 on scratch DB c7 across
several real quit + relaunch cycles: 24 of 27 steps pass outright; 4 and 12 pass on the tool path the drag calls but the mouse gesture itself
was not performed; 25 passes against planted history (see below).** Phase 5 complete (§11F passed).
**Restart (Phase 0 reboot) test is DEFERRED at the user's request — do not raise it.** The user registered a Task Scheduler logon task
`Secretary` (20 s delay) after Explorer's Shell-Core log showed the HKCU Run entry being skipped; `<userData>/startup.log` logs each launch.

## §11D application acceptance run + three fixes, and the "8e" question (2026-09-18)
- **SPEC.md's Phase 8 has no lettered slices** — one line: "Daily briefing. Deadline preparation. Missed-task and
  waiting-item follow-up. Adaptive intensity, quiet hours. Conversational replanning." 8a–8e were this session's own
  organisational split, not spec text. Checked live whether "conversational replanning" is already covered by 7f: opened
  a real replan preview, then refined mid-preview ("actually keep Wednesdays free too") — it did NOT update the open
  proposal the way 7g's `refine_week_plan` does for `plan_week`; it created an unrelated new constraint and required
  re-asking "replan the sessions" from scratch. So: the core safety guarantee (full preview, nothing moves without
  approval) and a proactive nudge ARE delivered by 7f; the specific 7g-style "one evolving proposal, refined across
  turns" ergonomics were never extended to `replan_sessions` — a real, known gap, not built here.
- **§11D run, all 10 steps, on a fresh scratch DB across a real restart** (three separate `electron .` launches against
  the same DB): 7 passed outright (1–4 project/checklist/complete/waiting-item setup; 7–8 recommend-now and
  what-am-I-forgetting phrased correctly, step 7's reasoning was thin only because the dataset gave it little signal to
  work with, not a defect). **3 failed — all three genuine, all three now fixed below and re-verified.**
- **Step 5 FAILED, now fixed.** "I don't want to do the case study tonight" created an `avoid` constraint and replied
  with zero warmth — spec explicitly wants "no guilt, an alternative offered". Root cause: nothing anywhere told the
  model (or gave tier 0 a rule) that a forward-looking reluctance statement is a FEELING, not a request to block time
  off — the same invariant-9 gap that a bare "I'm making tea" used to have (5d), just never closed for this phrasing.
  Fixed with a new tier-0 rule (`router.ts`, scoped to phrasing that names WHEN — "tonight"/"today"/"right now"/etc, so
  it never swallows an unrelated "I don't want to…" aside): resolves the named item, computes a REAL alternative time
  the same deterministic way `propose_slot` already does (`schedule.ts#proposeSlot`/`describeProposal`), sets the SAME
  `slot_proposal` offer `propose_slot` itself uses (a following "yes"/"book it" just works — no new mechanism), and
  replies "That's okay — no guilt about it. …" — zero model calls. Looser phrasing that reaches the model gets the same
  instruction in the system prompt: never `add_constraint` from a reluctance statement, call `propose_slot` instead.
- **Steps 6 and 10 FAILED, now fixed — same root cause.** "Move it to tomorrow afternoon" → `"I couldn't do that: No
  event with id "0adda90a""` (the deadline item's own id, reused as if it were an event's); "Cancel the reminder" →
  the identical bogus-id pattern, this time as if it were a reminder's, against a dataset with NO reminder at all.
  Both were caught safely by the tool layer (nothing corrupted, "nothing was changed"), but the user got a raw tool
  error either way instead of the right outcome. Root cause: nothing in the tool layer checked that an id was the
  right KIND of row for what the tool needed, and the model reused the last-focused item's id regardless. Fixed in
  `tools.ts`: `update_event` now tries the id as an event first, and if it isn't one, tries it as an ITEM id — if that
  resolves, it REROUTES to `update_item`'s own due-date reschedule (so "move it" naming a task/deadline now actually
  reschedules it, not just fails more politely); `cancel_reminder`/`update_reminder`/`snooze_reminder` share a new
  `resolveReminderOrItsItem` helper — an id that isn't a reminder's but IS an item's resolves to that item's one
  unambiguous pending reminder when it has exactly one, or otherwise returns a plain, honest "There's no reminder on
  'X' to cancel/move/snooze — nothing to do." instead of a thrown error. The system prompt's Reference resolution
  section now says explicitly to check entity type before calling a tool with an id.
- **Step 9 "worked" but silently dropped precision — now fixed.** "Actually move the application to Tuesday" (an item
  that had an EXACT due time, 17:00) correctly moved the day but silently downgraded to day-only precision, since the
  user only stated a day. Defensible under the honest-precision rule taken alone, but a real information loss: "move X
  to Tuesday" is a day change, not a request to remove the time. Fixed in `tools.ts#update_item`: a bare `due_date_local`
  on an item that already has an EXACT due time now carries that time-of-day forward onto the new date (via
  `repo.dateAtClockToUtc`) and keeps precision `exact`, rather than falling back to day-only — an explicit `due_at_local`
  (a real new time) or an explicit `due_looseness` (week/vague) always wins outright and is never overridden by this.
- **Re-verified after the fix**, on a fresh scratch DB, via direct manual tool calls exercising the exact failure shapes
  plus one live NL turn for step 5 (router tier 0, zero model calls): the reluctance statement now computes a genuine
  alternative slot and creates NO constraint (`constraints` table empty, confirmed by direct query); `update_event` and
  `cancel_reminder` called with an item's id (not that entity's own) now reroute/answer gracefully instead of throwing
  (confirmed both by the tool's own reply text and directly against the `reminders` table, which stayed empty); a
  bare-day move on an exact-time item now reads "now due Tue, 22 Sept at 20:00" — the time carried forward, not dropped
  (confirmed against `items.due_at_utc`/`due_precision` directly).
- **Not built here**: the 7g-style multi-turn replanning ergonomics gap noted above is a separate, known limitation of
  `replan_sessions`, out of Phase 8's own scope — not part of what this fix touched.

## Fixed: "light" next to an overdue item read as the app not noticing (2026-09-18)
- User feedback on the 8a briefing: `"Today looks light"` sat right next to `"Pay the electricity bill" (overdue)`
  in the same sentence — technically defensible by raw time-load math (a couple of small unscheduled items against
  a 12 h day genuinely is a low ratio), but "light" as a WORD promises nothing needs attention, which is false the
  moment something is overdue. Root cause: `core/calendar/aggregate.ts#dayStatus` (spec 6d, shared by EVERY
  calendar surface — Month/Week/Day/Agenda, not just the briefing) weighed hard deadlines lightly (+45 min) and
  didn't weigh overdue items or high-importance items AT ALL — `highImportance` was already computed in the
  summary but never actually passed into the function.
- Fixed at the source, not just in the briefing's own phrasing, since Month/Week would have shown the exact same
  mismatched "light" for the identical day otherwise: `dayStatus` gained two new weighted terms (`overdueCount *
  45`, `highImportanceCount * 20`, alongside the existing `hardDeadlines * 45`) AND a floor rule — "light" is now
  a promise, not just a ratio: any real urgency signal (overdue, hard deadline, or high importance) floors the
  result at "normal" even when the raw time estimate is tiny (a five-minute overdue task is still overdue), while
  the ratio stays free to escalate further to busy/overloaded when the load is genuinely heavy, not merely present.
  A single call site (`assembleDay`), both new params default to 0 so nothing else could have silently broken.
- `tests/dayStatus.test.ts` (9 checks, new — this function had no test coverage before): the exact real-world case
  (one overdue + one hard deadline + one high-importance item, otherwise-empty calendar) is no longer "light";
  a genuinely empty day still is; the floor never SUPPRESSES real escalation to busy/overloaded, only raises the
  minimum. Verified live too: the exact scenario from the 8a bug report now reads "Today looks normal" in both the
  morning briefing and `get_day`'s own independent phrasing (same underlying `summary.status` field, confirming
  the fix is consistent across every surface that reads it, not just the one that was complained about); a
  genuinely empty day still correctly reads "Nothing pressing today."

## Phase 8d — adaptive intensity and quiet hours (2026-09-18)
- **Cross-cutting, not a new surface of its own.** `src/core/quietHours.ts` (`isWithinQuietHours(nowMinutes, {start,
  end})`, pure — handles a same-day window and one spanning midnight identically, start inclusive/end exclusive,
  opt-in: an unset boundary is never inferred or defaulted) + `src/main/notifyPrefs.ts` (settings glue: `isQuietNow`,
  `getIntensity`/`setIntensity`, `intensityEffects()`) are read by EVERY existing proactive surface rather than each
  one growing its own notion of "pushy" — spec §5's "Follow-through" line named quiet hours and preferences as
  inputs to follow-up intensity back in the original Phase 1 spec, before any of 8a–8c existed, so this slice is
  the belated fulfilment of that, not a new concept.
- **Quiet hours hold TOASTS, never conversational messages.** Reminder delivery (`scheduler.ts#deliver`, both
  `tick()` and `startupSweep()`) and 8b's `sweepDeadlineRisk` are skipped entirely while `isQuietNow()` — a due
  reminder stays `'pending'` (never marked delivered), so the FIRST tick after quiet hours end picks it up through
  the ordinary due-reminders query with no special casing, and — since real time has passed while it sat held —
  correctly shows as "Missed reminder (N late)" through the SAME missed-reminder recovery path that already exists
  for "the app wasn't running." Nothing new was built for this; quiet hours just withhold the trigger. A happening
  ending (`endDueHappenings`) still ends and updates its own state on schedule either way — only its toast is
  withheld. Deliberately does NOT touch 8a's morning briefing or 8c's follow-up: both only ever appear when the
  user opens the app themselves, so there is nothing to "disturb" — quiet hours are about interruption, not content.
- **"Less pushy" has three concrete, uniform effects, defined once in `notifyPrefs.ts#intensityEffects` so nothing
  drifts between the surfaces that read it:** (1) every toast (reminders AND 8b's deadline alerts) stops demanding
  acknowledgement — `persistent: false` instead of `true`. (2) 8b's deadline alerts only fire on `infeasible` — the
  one verdict that is unarguable — not `tight`, which is a real signal but a softer, more debatable one; "less
  pushy" should stop interrupting for the debatable case while still surfacing the unarguable one. (3) 8c's daily
  follow-up cap drops from 3 named items to 1 (still says how many more are waiting, honestly — the "+N more,
  sitting quietly" phrasing is untouched). Deliberately did NOT touch: 8a's briefing content (it is not really
  "pushy", it only shows when the user opens the app); the morning briefing's day-status wording; anything about
  WHAT gets tracked — intensity only ever changes how loudly something already-computed gets surfaced.
- **Conversational, deterministic where the phrasing is common, model fallback for looser wording.** Two new write
  tools, `set_notification_intensity {level}` and `set_quiet_hours {start_local?, end_local?, clear?}` (both go
  through the usual confirm/apply path, `applied.phrase` states the concrete effect in plain words so the user
  knows exactly what changed, e.g. "Toasts won't demand a response, deadline alerts only fire when things
  genuinely won't fit…"). Tier-0 router rules cover the exact phrasings from the spec ("be less pushy about
  reminders", "ease up", "stop nagging me" → low; "back to normal" → normal; "don't disturb me after 10" / "…
  before 8" / "quiet hours from 10pm to 8am" / "turn off quiet hours" → set_quiet_hours, `parseQuietClock`
  disambiguating a bare hour by DIRECTION rather than by an existing item's own time the way `parseClock` does
  elsewhere — "after 10" defaults to evening, "before 8" stays morning, since that is how people actually say
  this) — all zero model calls. A prompt section (orchestrator.ts, right after the Reminders section) covers
  looser phrasing the router does not match; verified live with "can you dial down how much you notify me" →
  correctly called `set_notification_intensity {level:'low'}` via the model, 1 call.
- **A missing settings primitive, added along the way:** `repo.deleteSettingValue(key)` — "turn off quiet hours"
  genuinely needs to REMOVE both boundary settings (an empty string would leave them "set" and confuse `isQuietNow`
  into thinking a zero-width, always-false window was deliberately configured, which is a different state from
  "not configured at all"), and no delete existed before this (only `getSettingValue`/`setSettingValue`, an upsert).
- **A stating-only-one-side default, so "don't disturb me after 10" alone is immediately usable:** if the user
  gives a start with no end configured yet (or vice versa), the missing side defaults to 08:00 (end) / 22:00
  (start) rather than leaving a half-configured, silently-inert window — `core/quietHours.ts` treats either side
  unset as "never quiet", so without this default the user's very own example phrase would have done nothing
  until they also stated an end. Saying BOTH sides later overrides the default normally.
- **Verified live** on scratch DBs via `SECRETARY_CHAT`/`SECRETARY_USER_DATA`: both of the spec's own example
  phrases work standalone, tier 0, confirmed in the `settings` table (`notify.intensity=low`,
  `notify.quiet_start=22:00`, `notify.quiet_end=08:00` from "don't disturb me after 10" alone, via the one-sided
  default above). Full quiet-hours lifecycle: a reminder due inside a window bracketing the current real time →
  `sweep.quiet_hold`, stays `'pending'`, confirmed directly in the database, no toast; "turn off quiet hours" then
  a relaunch → delivers immediately as "Missed reminder (2 min late)". 8b under low intensity: a `tight` deadline
  → correctly silent; the SAME scratch DB's `infeasible` deadline → still alerts (the threshold genuinely moved,
  not a blanket suppression). 8c under low intensity: 3 new overdue tasks → only 1 named, "2 more … not
  forgotten." "back to normal" → intensity setting reset, confirmed. 12 unit checks in `tests/quietHours.test.ts`
  covering the pure time-window arithmetic: opt-in unset boundaries, same-day vs. midnight-spanning windows, the
  inclusive-start/exclusive-end boundary edges precisely, and a zero-width window.
- **Not built here**: 8e (conversational replanning — the last Phase 8 slice). No per-surface quiet-hours override
  (e.g. "let deadline alerts through even when quiet" is not offered) — quiet hours are all-or-nothing across every
  toast, matching the spec's own single example ("don't disturb me after 10") rather than inventing finer controls
  nobody asked for. No numeric/graduated intensity scale beyond normal/low — the spec's own example ("be less
  pushy") is a single downward adjustment, not a request for a dial.

## Phase 8c — missed-task and waiting-item follow-up (2026-09-18)
- **"Surfaces once, caps out, never nags" — three separate mechanisms, one each.** `src/main/followUp.ts#
  maybeSendFollowUp`: (1) *surfaces once* — every item that gets named is recorded PERMANENTLY in a
  `followup.surfaced_ids` setting and never named again, regardless of how long it stays overdue/unresolved.
  Deliberately different from 8b's deadline-risk tracking (which clears and can re-arm as feasibility genuinely
  changes): a missed task does not become "un-missed" on its own the way a deadline's feasibility fluctuates, so
  there is nothing to re-arm — once told, told for good. (2) *caps out* — at most 3 NEW items are named in any one
  day's message (`CAP`); a backlog beyond that waits quietly for a LATER day's sweep rather than flooding one
  message, and the message says so honestly ("2 more are sitting quietly for another day, not forgotten") rather
  than silently dropping them. (3) *never nags* — at most ONE message per local calendar day (gated the identical
  way to 8a's briefing: the flag is written only after success, so a transient failure retries next window-show
  rather than skipping the day), and a wait that already has an active EXPLICIT conditional reminder (Phase 3c's
  "remind me if they haven't replied by Friday") is excluded from this sweep entirely — the user already asked to
  be told about that one specifically; naming it again here would be exactly the nagging this slice exists to
  prevent.
- **Reuses existing queries, invents no new overdue/staleness detection.** Missed tasks: `repo.openItemsOverdue`
  (the SAME precision-aware honesty already used by the rail's own Overdue section — exact: time passed; day: a
  full day over; week/vague: a week over), filtered to kind task/deadline/commitment (never checklist steps,
  projects, or waits — those are a different category or live elsewhere). Stale waits: `repo.openWaitingItems`
  filtered to `due_at_utc` (the expected-reply date) already passed. Both filtered against the permanent surfaced
  set and, for waits, against `repo.pendingRemindersForItems` for an existing `condition_json`.
- **Phrasing lives in `core/followup.ts#describeFollowUp`** (platform-independent, no model), following the app's
  own Emotional UX rule verbatim (spec §8 Phase 4: never "you failed", never a guilt line): "X didn't get done ·
  Still no word from Y on Z · We still have time — say what to do with these." Missed tasks and stale waits combine
  into ONE message when both are present, missed named first. `tests/followup.test.ts` (11 checks): singular vs
  plural grammar for both categories; the two categories combine coherently; the tone genuinely never contains
  blame language (asserted directly, not just eyeballed); overflow is stated honestly with correct singular/plural
  grammar; zero entries produces `null` (never an empty or manufactured line).
- **A real, non-obvious phrasing bug caught by actually reading the live output, not just the unit tests:** a
  wait's own `title` is already the auto-generated "Waiting on Priya — the transcript" (`createWaiting`'s display
  title) — phrasing `Still no word from Priya on "${title}"` around that repeated "Priya" and "Waiting on"
  awkwardly. Fixed by using the wait's `details` field (just the "about" part, "the transcript") instead of its
  full title, falling back to the title only if `details` is empty. The unit tests never would have caught this on
  their own since they use clean, already-short fixture titles — this only showed up against a wait created the
  normal way, through the real `create_waiting` tool.
- **Delivered exactly like 8a**: a real `role:'assistant', tier:0` message, pushed to the renderer over the SAME
  `onMessageAdded` channel 8a already built (no new plumbing), from its own independent `try/catch` inside the
  SAME `win.on('show', …)` handler — one feature's failure can never take the other's message down with it, and
  both a briefing and a follow-up can land from the same window-show without either swallowing the other (verified
  live: both `briefing.sent` and `followup.sent` log lines fire from one relaunch when both have something to say).
  Also an `activities` row per named item (`verb:'followup_surfaced'`), same as every other proactive system event
  in this app.
- **Verified live** through the full lifecycle on scratch DBs via `SECRETARY_CHAT`/`SECRETARY_USER_DATA` (window
  `show` only fires meaningfully on a SECOND launch, same dev-hook quirk as 8a/8b, since the sweep needs the items
  to already exist): one overdue task + one stale wait → one combined message naming both; a second relaunch the
  SAME day → correctly silent; 5 new stale items (4 tasks + 1 wait) → exactly 3 named (oldest-due-first), "2 more
  … not forgotten"; a SIMULATED next day (backdating `followup.lastDate`) → the 2 held-back items surface, the 3
  already-named ones correctly never repeat; a wait with an active conditional reminder → correctly excluded,
  no double-mention.
- **Not built here**: 8d (adaptive intensity/quiet hours — like 8b, this has no quiet-hours awareness yet and the
  message could in principle appear the moment the window shows regardless of hour), 8e (conversational
  replanning). No unit test for `main/followUp.ts` itself, matching the established convention (only `core/*.ts`
  gets plain-Node unit tests; DB/Electron-coupled glue is verified live) — `core/followup.ts`, the part that
  actually decides the wording, is fully covered.

## Phase 8b — approaching-deadline alerts (2026-09-18)
- **"Only fires when the evidence is clear, never speculatively" — enforced by reusing 7b's own arithmetic verbatim,
  not a new heuristic.** `src/main/deadlineAlerts.ts#sweepDeadlineRisk` calls the exact same `upcomingDeadlineTargets`
  + `assessTarget` that `assess_deadline` ("is X on track?") and `get_forgetting`'s "Deadlines to watch" already use
  — no second, looser scoring system invented for this slice. It alerts on exactly TWO of the seven `Feasibility`
  values, both genuine arithmetic rather than a judgement call: `infeasible` (needed time exceeds remaining
  capacity) and `tight` (the needed/capacity ratio is past the threshold). Deliberately EXCLUDES: `unknown` (only
  waits are left — genuine uncertainty, the opposite of clear evidence); a contradiction alone with no risky
  feasibility (already voiced immediately at note time, 7b — repeating it here would be noise, not a new alert);
  and `passed` — an "approaching" alert has nothing to say once a deadline has already gone by, that is simply
  overdue, and overdue is already surfaced loudly and repeatedly elsewhere (rail, the 8a briefing's own "Top of
  mind", `recommend_now`'s +50 weighting, `get_forgetting`). `passed` is also structurally unreachable through this
  path regardless, since `upcomingDeadlineTargets` only looks FORWARD from now — confirmed live, not assumed (see
  bug note below), rather than trusted from reading the code alone.
- **Fires once per risk EPISODE, not once ever and not every tick.** A `deadline_alerts.alerted_ids` setting (a
  JSON array of item ids) tracks which deadlines the user has already been told about while they are CURRENTLY
  risky. Checked on every scheduler tick (30 s) and at startup (`sweepDeadlineRisk` called from both
  `scheduler.ts#tick` and `#startupSweep`, alongside the existing missed-session/happening sweeps — same
  established pattern, no new mechanism): a deadline newly risky (not already in the set) → toast + `activities`
  row + added to the set; a deadline still risky → silent, already told; a deadline no longer risky → removed from
  the set, so a LATER re-risk (a missed session, a new conflict booked over planned work, time simply passing)
  alerts fresh instead of staying silenced forever. Verified live through the full lifecycle: infeasible → alert
  fires once, two further relaunches stay silent → effort reduced to comfortable → relaunch clears the set, no
  alert → effort pushed back to infeasible → relaunch alerts again. Cheap enough to run on every tick without
  throttling, for the handful of deadlines a personal calendar actually has — no premature optimisation added.
- **Delivered as a toast** (`showToast`, `persistent: true` so it does not vanish before being read, no action
  buttons — this is informational, not a reminder with its own pending/acknowledged state machine) **and** an
  `activities` row (`verb:'deadline_alert'`, attached to the item's own project when it has one) so it is visible in
  that Thing's timeline afterwards, same as every other proactive system event in this app. Deliberately NOT also a
  chat message (unlike 8a's briefing): a deadline alert is a system event, matching how reminder delivery already
  works (toast + activity, never a `messages` row) — not a conversational exchange. If the user wants to talk about
  it, "is X on track?" (7b) or "what am I forgetting?" (7d, which already surfaces the same `atRiskLines`) are right
  there.
- **A real bug caught by actually running the "passed" case rather than assuming it would work:** the original
  design included `passed` in the trigger set. Testing it live (an already-overdue hard deadline) produced NO
  alert at all — `upcomingDeadlineTargets`'s own query (`itemsDueBetween(nowUtc, end, ...)`) uses `nowUtc` as its
  LOWER bound, so anything already due in the past never enters the candidate list in the first place; the
  `passed` branch was unreachable dead code. Rather than changing the target-gathering to also look backward (which
  would just duplicate the overdue surfacing this app already does everywhere), removed `passed` from the trigger
  set entirely and documented why in the module's own header comment — the right fix turned out to be "this
  shouldn't have been in scope," not a code patch.
- **Verified live** on scratch DBs via `SECRETARY_CHAT`/`SECRETARY_USER_DATA` (an item created in one launch,
  `startupSweep` on the NEXT launch is what actually exercises this, since the sweep runs before the scripted
  turns): an infeasible 40 h deadline due the next day → `Deadline at risk: "Huge project"` toast, body
  `"Huge project" (Sat, 19 Sept at 17:00, 1 day left): 0 of 1 part done. NOT feasible as it stands — about 40 h of
  work left against roughly 12 h free before then.`; a tight-but-doable 8 h deadline → `Tight — about 8 h of work
  left against roughly 12 h free before then.`, cross-checked against `assess_deadline`'s own independent
  "Feasible but tight" verdict for the same item; a comfortable deadline → correctly silent, no false positive.
- **Not built here**: 8c (missed-task/waiting-item follow-up), 8d (adaptive intensity/quiet hours — this alert has
  no quiet-hours awareness yet and could in principle toast at 3 a.m. if a deadline's risk genuinely changes then),
  8e (conversational replanning). No unit test: `main/deadlineAlerts.ts` is DB/Electron-coupled glue, not a
  platform-independent `core/*.ts` module, matching this project's established convention that only `core/*.ts`
  gets the plain-Node unit-test treatment — verification here is live, via the scenarios above.

## Phase 8a — the morning briefing (2026-09-18)
- **One concise message, computed and phrased entirely in code — zero model calls.** `src/core/briefing.ts`
  (`describeBriefing(bundle, opts) → string`, platform-independent) is deliberately tiny: it invents NO second ranking
  system, it reuses the exact `priorities` (already scored, already sorted) and `summary` that `core/calendar/
  aggregate.ts#assembleDay` already computes for TODAY'S Day View Model — the same one every calendar surface
  consumes. All this module does is decide how much of that ranked list is worth saying in one message, and write
  the sentence: a greeting word that follows the actual hour (morning/afternoon/evening, never a fixed "good
  morning" regardless of when it fires), the day's load word (light/normal/busy/overloaded), up to 3 named
  priorities with their top reason and an honest "+N more" beyond that (never silently dropped, never a full dump),
  the first TIMED event of the day (all-day events excluded, since they don't answer "what's first"), and — new
  ground beyond what `assembleDay` covers — a "Coming up" clause for hard deadlines/dated Things due after today but
  soon (spec 7b's "surface it before it is urgent" idea, reused via `main/deadlines.ts#upcomingDeadlineTargets`
  rather than invented fresh). An empty day says so plainly ("Nothing pressing today") — never a manufactured
  "all clear!" when there is simply nothing to report.
- **A real, non-obvious bug found and fixed while wiring this up:** the "coming up" window was first computed as
  `upcomingDeadlineTargets(3, nowUtc)`, whose own cutoff is an exact 72-HOUR count from the current moment, not a
  calendar-day boundary. A deadline due 17:00 three calendar days out was silently missed by a briefing that ran at
  04:39 local, because 72 exact hours from 04:39 lands mid-afternoon on day 3 — before 17:00. Fixed in
  `main/briefing.ts#comingUpSoon`: over-fetch one extra day from `upcomingDeadlineTargets`, then apply the real
  bound by comparing LOCAL CALENDAR DATES, not elapsed hours. Caught by actually running it against a hard deadline
  3 days out and noticing it never appeared — exactly the kind of thing that would have shipped silently wrong.
- **Trigger: every time the window becomes visible** (`win.on('show', …)` in `src/main/index.ts` — covers cold
  launch's initial show, a tray-icon restore, and everything else, in one hook), gated to fire at most once per
  local calendar day by `main/briefing.ts#maybeSendMorningBriefing` via a `briefing.lastDate` setting. The gate is
  written only AFTER the message is successfully built and inserted — a transient failure (a momentarily locked
  DB, say) leaves the flag unset, so the very next window-show tries again instead of silently going without a
  briefing for the rest of the day. The whole handler is wrapped in try/catch (`briefing.failed` logged on error):
  a briefing failure must never block the window from showing or take the companion's own greeting down with it.
- **Delivered as a real assistant message** (`role:'assistant', tier:0` — renders with the existing "instant · no
  model call" badge, same as any other tier-0 answer), pushed to the renderer over a NEW dedicated IPC channel
  (`onMessageAdded`/`IPC.messageAdded`) rather than the existing generic `onChanged` → refetch-everything path.
  This was a deliberate choice, not an oversight: `onChanged` already exists and `refresh()` could have been
  extended to also refetch `chatHistory`, but that refetch would race an in-flight `sendMessage`/`sendVoice` call —
  the real user message is inserted into the DB before the model call returns, so a wholesale chatHistory refetch
  mid-exchange would show it early, and the send flow's own `setMessages((m) => [...m.filter(id!==tempId),
  res.userMessage, …])` would then re-append it, duplicating the bubble. A message pushed and appended by id (with
  a dedupe guard) can never race or duplicate that flow, regardless of what else the renderer is doing. Delivery is
  delayed 400 ms (`setTimeout`, mirroring the EXISTING identical precedent for the toast "Reschedule" prefill a few
  lines above it in `index.ts`) since on a cold launch this fires close to `ready-to-show`, before the renderer's
  own `ipcRenderer.on` listener is necessarily attached yet — the initial `chatHistory(60)` fetch on mount is a
  natural fallback net even if that delay were somehow still too short.
- **Deliberately NOT touched:** the companion's own "first open of the day" greeting (Phase 4, `App.tsx`,
  localStorage `companion.greeted`) is left completely independent — a separate, robust, purely-visual mechanism
  that must keep working even if the briefing computation fails for any reason. They are not coupled to the same
  flag; in practice both fire within the same window-show, so they read as one moment to the user without actually
  being one mechanism.
- **Verified live** on scratch DBs via `SECRETARY_CHAT`/`SECRETARY_USER_DATA`, DB state confirmed directly: an
  empty day → "Nothing pressing today."; a rich day (an overdue bill, something due today whose importance was
  correctly inferred from being due-within-a-day per the existing 6a `inferImportance` rule, a hard deadline 3
  days out, one calendar event) → `Good morning — Friday 18 September. Today looks light. Top of mind: "Pay the
  electricity bill" (overdue); "Call the vet" (high importance). First up: "Team meeting" at 14:00. Coming up:
  "Submit the visa application" (Mon 21 Sep).`; a second launch the SAME day → correctly silent (no
  `briefing.sent` log line, `messages` table unchanged); a simulated NEXT day (backdating the `briefing.lastDate`
  setting) → fires fresh, correctly. 16 unit checks in `tests/briefing.test.ts` (run via `node tests/
  briefing.test.ts`, no cross-core imports so no loader-hook needed) cover all of the above plus edge cases
  (three-or-fewer priorities never show "+N more"; a priority with no reason is still named, just without a
  parenthetical; scheduled events sort chronologically for "first up" regardless of input order; "coming up" is
  never lost when today itself is empty). One test-authoring mistake caught by running it: a fixture defaulted
  `summary.status` to `'light'`, so a test expecting "Coming up: …" with NO status line was wrong about the
  code's actual (correct) behaviour — fixed the assertion, not the code.
- **A dev-hook quirk worth remembering, not a product bug:** `SECRETARY_CHAT` scripts that complete very fast (only
  tier-0 manual calls, no real model latency) can quit the app before the window's `ready-to-show`/`show` sequence
  has actually finished — the briefing silently never fires in that specific case, because the window never really
  showed. Adding one turn with genuine model latency (any ordinary typed message) reliably gives the window enough
  wall-clock time to show first. This only matters for scripted testing; a real user's window always finishes
  showing since nothing is racing to quit the app.
- **Not built here** (later Phase 8 slices per spec, not 8a's scope): deadline preparation, missed-task/waiting-item
  follow-up, adaptive intensity, quiet hours, conversational replanning. The briefing also does not yet mention
  waiting items going stale or plans falling behind — those are 7d/`get_forgetting`'s job today; whether the
  morning briefing should eventually fold in a condensed version of that is an open question for a later slice, not
  answered here.

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

## Fixed: bare ordinal dates ("on the 25th") silently mis-dated as today (2026-09-18)
- `src/main/ordinal-date.ts` — `parseBareOrdinalDay(text, refDate, zone)`: chrono-node has NO concept of a day-of-month
  with no month named. Verified directly against the library, two distinct failure modes: "the 25th" alone → chrono
  returns zero results; "meeting on the 23rd at 5pm" → chrono returns exactly ONE result covering only "at 5pm"
  (`isCertain('day') === false`), silently defaulting the date to today. Both were reaching the user as a real but
  wrongly-dated event/constraint/task, with no error at all — the app said something confident and wrong.
- `router.ts#parseWhen` (the one shared date parser almost every rule calls) now checks for a bare ordinal FIRST:
  if chrono found nothing, or found only a time (`!isCertain('day')`), the ordinal's date wins and any time chrono
  DID find (including a full start–end pair collapsed to its start, see below) is layered onto it. A genuine chrono
  date match (`isCertain('day')`) is always trusted as-is; the ordinal check never overrides a real date.
- `deadlines.ts#noteDateConflicts`'s own inline copy of this exact fallback (written when 7b was built) now calls the
  same shared function instead — the app no longer risks resolving "the 20th" to two different dates depending on
  which code path ran, which is exactly the kind of drift 7g's date-reference chains would have made worse.
- **A second, related bug surfaced by fixing the first and re-testing live:** "I'm busy on the 25th from 4pm to 8pm"
  got the date right immediately but the TIME came out as 16:00–17:00, dropping the "to 8pm" entirely. Root cause: the
  availability rule's own time-range regex only recognised ONE meridiem for the whole range ("4 to 8pm"), not one per
  side ("4pm to 8pm") — a pre-existing, narrower bug that a wrong date had been quietly hiding (nobody notices a wrong
  end-time on an event that was already on the wrong day). Fixed by widening that one regex to accept a meridiem on
  either or both numbers, with sensible inference when only one side states it; the two other call sites with the
  identical one-sided-meridiem limitation (`create_event`'s "meeting … 2pm to 4pm" and the recurring-class phrase) were
  NOT touched — left as a known, narrower, related gap rather than an unbounded regex audit of the whole file.
- Verified: "meeting with professor x on the 23rd at 5pm" → Wed 23 Sept 17:00 (was: today); "submit the report on the
  30th" → Wed 30 Sept (was: today); "I'm busy on the 25th from 4pm to 8pm" → Fri 25 Sep 16:00–20:00 (was: today,
  16:00–17:00); "I'm busy tomorrow 9-5" and "I'm busy friday 2-4" (no meridiem at all — the pre-existing heuristic)
  and the note-date-contradiction feature (7b) all re-verified unaffected. All 77 existing unit checks still pass.

## Fixed: a stated duration ("it'll take 15 minutes") was misread as a due time (2026-09-18)
- Found incidentally while running the §11G acceptance test (see below), not part of what it checks: "Write the annual
  report, it'll take an hour and a half, high importance." created a task titled "Write the annual report, it'll take
  and a half, high importance", due at an exact clock time close to the actual moment of testing — a due date the user
  never stated, invented from a sentence that only said how LONG the work would take.
- Root cause: `router.ts`'s `IMPERATIVE` rule ("write the report tomorrow at 5pm") calls the shared `parseWhen` on the
  whole remaining sentence. `chrono.casual.parse` treats a bare quantity+unit ("an hour", "15 minutes", "for two hours")
  as a relative offset from right now and reports the computed date/hour/minute as fully certain — indistinguishable,
  by every certainty flag `parseWhen` already checks, from a genuine date reference like "thursday at 3". `cleanTitle`
  then stripped the matched duration phrase out of the title, mangling it too.
- Fixed centrally in `parseWhen` itself (same place as the bare-ordinal-day fix above, and for the same reason: every
  other tier-0 rule that touches a date shares this one function, so hardening it there protects all of them at once).
  A new `BARE_DURATION` regex drops any chrono match that is nothing but a quantity + hour/minute unit, optionally
  preceded by a benign qualifier (for/about/roughly/around/over/almost/nearly/next) — treated exactly as if chrono had
  found nothing. Deliberately excludes anything starting with "in" ("in an hour", "in 20 minutes"): that IS a genuine
  relative-deadline signal, already handled correctly and unaffected by this change (verified below) — it just never
  reaches `parseWhen` with a bare quantity from the phrases this fix targets, since those either keep the "in" prefix
  chrono itself matches, or go through the availability/propose_slot rules' own separate duration regexes, which were
  already isolating durations correctly before this fix and are untouched by it.
- Verified: the two exact repro sentences now fall through tier 0 entirely (to the model), producing clean titles
  ("Write the annual report" / "Reply to the landlord's email") with `due_at_utc: null` and the model's own
  `effort_minutes` (90 / 15) — confirmed directly against the database, not just the reply text. Regression pass
  confirmed nothing legitimate broke: "call the bank thursday at 3", "submit the report friday, hard deadline",
  "write the report tomorrow at 5pm" (still tier 0, still exact/day-precision as before), "meeting … on the 23rd at
  5pm" (bare-ordinal path untouched), "I'm busy for the next hour" (its own separate duration regex, untouched) — and,
  critically, "finish it in an hour" and "get the tickets in 20 minutes" STILL create an exact due time ~1h/20min from
  now, proving the "in" exclusion works and genuine relative deadlines were not collateral damage. All existing unit
  tests still pass (`recurrence.test.ts` fails, but confirmed via `git stash` to fail identically without this change —
  a pre-existing, unrelated Node module-resolution issue in a different file, not caused by this fix).
- Not touched: `inferImportance`/the model's own importance guess for "high importance" phrasing came back inverted
  (stored as low) in both the original repro and this fix's regression run — a separate, pre-existing, likely
  model-judgement issue (or an `inferImportance` HIGH-regex gap: it matches the word "important" but not "importance"),
  out of scope for this ticket; worth a dedicated look if it recurs.

## Fixed: `add_link` crashed when the blocked/blocker side didn't exist as an item yet (2026-09-18)
- Found incidentally while running the §11G acceptance test, not part of what it checks: "They said they'll get back to
  me about the lease once the landlord signs off." correctly created a waiting item; "I can't sign the lease until they
  get back to me." — said when "sign the lease" had never been mentioned before — THREW and rolled back the entire
  round (`Invalid arguments for add_link: to_id: Invalid input: expected string, received undefined`, or on a repeat run,
  `An item cannot depend on itself`), so not even a "Sign the lease" task got created. Workaround verified at the time:
  creating the task first, THEN stating the dependency, worked fine.
- Root cause: `add_link`'s schema (`tools.ts`) required a real `from_id`/`to_id` for BOTH sides, but the model has no way
  to know an id for something that doesn't exist as an item yet — tool calls in one round are all decided in a single
  model generation, before any tool has run, so it cannot first call `create_item` and then use the id THAT returns in
  the same response. Two prompt sections (orchestrator.ts's "Brain dumps (7a)" clause list and the Phase 3f "Dependencies"
  line) told the model to call `add_link` directly with no instruction covering this case, so it either omitted the id
  (`undefined` → Zod throws) or, worse, reused an id it did have — the wait's own — for both sides, tripping the
  self-dependency guard instead. This is a harder version of a softer, already-documented 7a gap ("the 'can't book
  until the dept confirms' clause became a wait but no blocks link on the first run") — same root cause (a side named
  for the first time has no id yet), just without the earlier gap's silent-omission mercy.
- Fixed the way `add_note`'s `item_title` already solves the identical problem for its own target, but taken one step
  further: `add_link` now accepts `from_title`/`to_title` as an alternative to `from_id`/`to_id` on EITHER side
  (schema `.refine`s require exactly one of the pair per side). The case implementation (`resolveSide` in the `add_link`
  case) resolves a title against everything open (any kind except `project`, so a title can land on an existing item OR
  an existing wait) via the same `resolveEntity` used elsewhere; on no confident match it creates a plain task instead —
  invariant-11 "resolve before creating," but creating rather than erroring is the deliberate difference from
  `add_note`'s behaviour, since here nothing else can serve as the link's target. A newly-created side inherits the
  OTHER (already-resolved) side's project, if it has one. The prompt (both sections above) now tells the model to use
  `from_title`/`to_title` for anything not already known, and explicitly never to invent an id or call
  `create_item`/`create_waiting` first just to get one.
- The self-dependency and circular-link guards (already existing) still run AFTER both sides resolve, so they still
  work correctly even when a title-based resolution on one side happens to land on what the other side just became —
  verified live: "I can't sign the lease until I sign the lease" (title never seen before, identical on both sides)
  rolled back to a completely empty database, no orphan task left behind, because the whole round (including the first
  side's own `insertItem`) sits inside ONE SQLite transaction that the self-dependency error unwinds in full — the
  atomic all-or-nothing write-round guarantee (spec invariant 4) was not weakened by this fix, only the case that used
  to fail before ever reaching a real write now succeeds.
- Verified live on scratch DBs: the exact repro now succeeds in ONE model call, ONE round — "sign the lease" is created
  (capitalised via the existing `capital` helper, matching every other task's convention) and correctly linked as
  blocked by the existing wait, confirmed directly against `items`/`links`/`PRAGMA foreign_key_check`. Regression:
  "I can't send the mailing until the list is cleaned" correctly resolved "the mailing" to an EXISTING task rather than
  creating a duplicate (title-resolution reuses existing items exactly as intended, not just the "doesn't exist" path);
  the self-dependency guard still refuses "I can't sign the lease until I sign the lease" against an existing item too.
  All existing unit tests still pass (same pre-existing, unrelated `recurrence.test.ts` failure as noted above).
- Not touched: the softer 7a-documented gap this supersedes can be considered closed by this fix (the underlying cause
  — a side with no id yet — is the same one); no separate note was kept for it. `remove_link` still requires real ids
  on both sides (unchanged) — unlinking only makes sense for a link that already exists, so there is nothing to resolve
  or create there.

## §11G intelligence acceptance run (2026-09-18, several fresh scratch DBs, all steps via SECRETARY_CHAT/SECRETARY_USER_DATA)
**Re-run the same day, after both bugs below were fixed: 13 of 14 pass.** Step 7 (nothing can start) now passes in ONE shot
with natural phrasing — no workaround needed, since it exercises the exact `add_link` scenario that used to crash. Step 11
(infeasible) was redone with a time-independent all-day-busy setup (the original "before 9am" phrasing was time-of-day
dependent and happened to become trivially feasible on the later re-run, which is a test-design note, not a regression).
**Step 2 (the spoken dump) could not complete on the re-run** — not a code fault: it sat in Gemini's retry/backoff ladder for
15+ minutes before being killed, and a follow-up probe confirmed a plain "hello" still succeeds instantly on the healthy
cheap model while the stronger models voice always uses (`preferStrong`) are hitting `RESOURCE_EXHAUSTED` on their own daily
free-tier quota (20 requests/day/model) — exhausted by the volume of testing done across this whole session. The voice
pipeline itself is untouched by either fix and was verified working earlier this same session and when it was originally
built. All other 13 steps, including the two that exercise this session's fixes directly, pass — see their own bug-fix
sections above for the detailed verification.

All 14 steps of spec §11G pass **on the original run, before the two bugs below were found and fixed**. Each ran against its
own throwaway scratch DB (never the real one); a few needed a second, more tightly-controlled scenario after the first
attempt was confounded by something else (noted per step below — that is a test-design note, not a product failure).
1. **Pass.** A 9-clause typed dump against an existing "IIM application" project (CV done, Transcript/Case study open) → ONE
   model call, 6 changes: the case study clause resolved to the EXISTING checklist item (effort updated, no duplicate — invariant
   11), a commitment to Priya, a task+reminder, a waiting item, an idea. Zero clarifying questions asked (within "at most one").
2. **Pass.** The same dump, spoken (`@file.wav` via real TTS through the actual Gemini voice pipeline): resolved the case study
   to the same existing checklist item, same commitment/task/context structure, 1 model call. (First attempt hit a transient
   Gemini 503 — handled honestly, "nothing was changed", not a code fault; the retry succeeded.)
3. **Pass.** The same dump's "I'm exhausted today" became context only (no item) and "I told Priya I'd send the draft tonight"
   became a commitment attached to the project — cleanly separate outcomes, never merged.
4. **Pass.** "Is the IIM application on track?" named the bottleneck ("Case study" — the largest stated remaining piece) without
   being asked which component mattered, entirely tier 0.
5. **Pass.** The same assessment and "what is left?" listed only CV/Transcript/Case study/Send draft to Priya + the wait on the
   professor — exactly what was created, nothing invented. (Minor test-design note, not a spec violation: the "send draft to
   Priya" promise was filed as part of the focused project since it was mentioned right after it, which is a defensible reading
   but worth knowing about if it ever needs to NOT auto-attach.)
6. **Pass, on the second, controlled attempt.** First attempt used natural-language item creation ("...needs about 90 minutes...")
   and the model's own importance guess came back inverted (see bug note below) so both times of day picked the same item; a
   second attempt with `!create_item` setting importance/effort directly showed the intended effect cleanly: 09:00 picked "The
   annual report" (big, important — "a fresh morning"), 23:00 picked "Reply to the landlord" (small — "it's late — a small one").
7. **Pass, on the second attempt.** First attempt hit the `add_link` crash (bug below) which prevented the blocked item from
   ever being created, so "nothing open at all" was accidentally correct for the wrong reason. Second attempt (task created
   first, then the dependency) got the intended answer: "Nothing you can start right now: Sign the lease waits on the reply
   from they." — honest, names the reason, invents nothing.
8. **Pass.** "What am I forgetting?" cleanly separated "Promises first / Waiting on / Coming up" (definite) from "Possible, not
   acted on: 1 idea noted but never made a task" — never merged or reordered.
9. **Pass, verified by code + DB, not screenshot.** The idea row's DB state is `kind='idea', status='open'`; `App.tsx`'s
   `standalone` filter (line ~460) explicitly excludes `kind === 'idea'` from both the Open list and its count — confirmed the
   filter is still in place and unchanged, not re-derived from a live screenshot this run.
10. **Pass (event-avoidance); buffer-avoidance not independently re-demonstrated this run.** "I need two hours to write the
    case study before next Friday" found free time and booked it exactly as proposed; asking again afterward for "six hours
    before 9am" correctly saw the just-booked event and reported 0 min free (proving the search reads real committed state, not
    a cached view). A dedicated attempt to force a slot right against a 30-min buffer failed only because the availability
    rule doesn't parse a "busy from X today until <a different weekday>" span (an incidental, minor phrasing gap, not spawned
    as a follow-up) — buffer-avoidance is the same `planning.assessSlot` function already verified for buffers in §11C step 21,
    not a separately-demonstrated live proposal in this run.
11. **Pass.** "I need six hours for something before 9am" → correctly `infeasible`, citing "0 min free in total"; the follow-up
    "book it" was correctly REFUSED ("nothing to book... tell me a different deadline") rather than booked anyway — confirms
    the 7e fix (never let the model force an infeasible proposal through) still holds.
12. **Pass, rigorously.** A 15-session plan with 2 sessions genuinely missed and a real conflicting event booked over a future
    session: "replan the sessions" showed exactly what would clear (10 sessions) and replace them (10 new, skipping the one that
    still clashed with the conflicting event, adding one more at the end to compensate), stated the remaining shortfall, and
    ended "Nothing moves until you say so — shall I go ahead?" — confirmed via direct DB read that session count/state were
    UNCHANGED between preview and approval. "Yes, go ahead" committed precisely what was previewed; the conflicting event was
    left untouched; `PRAGMA foreign_key_check` clean.
13. **Pass, rigorously.** Three obligations due Sunday → "plan my week" proposed 3 sessions → "nothing saturday" → "I have a
    dentist appointment sunday at 2pm" → "okay, do it" committed exactly 4 events (3 work blocks at the previewed times + the
    dentist appointment), zero events on Saturday, confirmed via direct DB read. Entirely tier 0 throughout this chain.
14. **Pass.** Scanned every scratch DB's `scheduler_log` across the whole run for any `chat.done` line reporting more than 1
    model call, or any `ai.call_budget_exceeded` event: none found. Every turn was 0 (tier 0) or 1 (tier 2/voice) model calls.
- **Two real bugs found INCIDENTALLY (not what §11G checks for) — spawned as separate follow-up sessions, not fixed here:**
  (1) A sentence starting with an IMPERATIVE-list verb ("write", "reply to", …) that states a DURATION rather than a due time
  ("it'll take 15 minutes") gets misread by tier 0's imperative-create rule: chrono treats the duration phrase as a relative
  offset from now, fabricating a real exact due timestamp the user never stated and truncating the title around the matched
  phrase (invariant-1 violation — never invent a time). (2) "I can't X until Y" when X has never been mentioned before (so no
  item exists to link) throws `Invalid arguments for add_link: to_id: ... received undefined` and rolls back the ENTIRE round,
  so not even a task gets created — a harder version of the pre-existing, already-documented (7a) "link sometimes silently
  missing" gap. Both need a fresh session with full context, not a quick inline patch during an acceptance run.

## Phase 7g — conversational planning (2026-09-18)
- **One evolving proposal across turns, never a new plan each message.** `src/main/weekplan.ts` holds a single
  module-level draft (`fromUtc`/`untilUtc`/`excludedDays`/`fixed`/`obligationIds`, captured once at "plan my week" so the
  target list doesn't drift mid-conversation while each item's own due date/effort/title is still re-read fresh on every
  recompute). "Plan my week" (`startWeekPlan`) always starts a FRESH draft from this week's real unscheduled obligations
  (due within 14 days, per `repo.unscheduledObligations`), superseding whatever was open. Every further instruction
  REFINES the same draft (`refineWeekPlan`) — exclude a day, or add something the user mentioned as a `FixedCommitment`
  (with or without a time; no time given → the whole day is kept clear for it, since the time isn't known) — and
  recomputes the WHOLE placement from scratch each time (cheap enough not to bother diffing). Only `commit_week_plan`
  writes anything, and only once the user has clearly approved what was just shown.
- **`src/core/weekplan.ts`** (platform-independent, no Electron/SQLite/model): `planWeek` is a simple greedy pass — most
  urgent obligation first (sorted by due date in the glue layer), earliest free slot via 7e's own `core/schedule.ts#
  findFreeWindows`, reserve it, move on, so the next obligation can never land on the same time. A due date bounds the
  search to strictly before it (an obligation is never placed "on time" after its own deadline has passed); an
  obligation already overdue is never searched for at all. Grading a placement (clear/tight/poor) is `planning.assessSlot`
  's job in the glue layer, exactly as in 7e/7f — duplicating it in core would be the "computation in the wrong place"
  mistake spec §8 warns against. `summarizeWeekPlan`/`describeWeekPlan` turn a graded placement list into the one honest
  sentence: "Proposed"/"Booked" verb, each placed session named with its grade suffix when not clear, unplaced items
  named plainly ("Could not fit …"), excluded-day count, fixed-thing count, and a trailing "say what to change, or 'do
  it' to commit — nothing is booked yet" only while it is still a live proposal, never once committed.
- **Compute, then phrase, one model call:** `plan_week`/`refine_week_plan` are read-classified tools — the orchestrator's
  `phraseReadResults` relays their computed text verbatim, never a second call. `commit_week_plan`/`discard_week_plan`
  are write tools going through the usual confirm/apply path. Router (tier 0, gated correctly so these phrases mean
  nothing different in ordinary conversation): "plan my week" → `plan_week`; then, ONLY while a draft is open
  (`hasActiveWeekPlan`) — "nothing/keep <day> free", "<day> is off limits" → `exclude_day_local`; "I have/there's a
  <thing> on/this <day> [at <time>]" → `add_fixed_title`/`add_fixed_date_local`/`add_fixed_at_local`; "do it/go ahead/
  book it" → `commit_week_plan`; "never mind/scrap that/start over" → `discard_week_plan`.
- **A proposal must be SEEN before it can be approved — enforced in code, not just the prompt.**
  `orchestrator.ts#stripPrematureWeekPlanCommit` drops any `commit_week_plan` call that arrives in the SAME tool round as
  `plan_week`/`refine_week_plan` (logs `ai.weekplan_premature_commit`): even if the model tries to satisfy "plan my week
  and just do it" in one round, the proposal still goes out and the user gets a real turn to approve or redirect before
  anything is booked. `commitWeekPlan` also re-grades everything ONE more time at commit (time may have passed, or
  something else got booked meanwhile) and silently drops — never books over — anything that is now graded `hard`,
  reporting it as unplaced instead.
- **Real bug found and fixed via live testing:** a day-only due date is stored as that day's local MIDNIGHT (its start,
  per spec §2 honest precision). `planWeek`'s search cutoff used that raw timestamp directly as the bound, which meant
  "due Sept 20" excluded ALL of Sept 20 from the search — the deadline is literally the day's first instant. Symptom:
  "could not fit ANY of the 3 obligations anywhere" when the due day alone should have had capacity. Fixed by
  `main/weekplan.ts#effectiveDueUtc`: non-`exact` precision now searches up to END of the due day (23:59:59 local), not
  its start.
- **Verified live, end-to-end, on a scratch DB** (`SECRETARY_USER_DATA`), the exact spec chain: "plan my week" (proposed
  sessions avoiding a fully-busy Friday) → "nothing saturday" (recomputed, moved everything to Sunday) → "I have a
  presentation sunday at 3pm" (recomputed again: 2 of 3 items fit around it, 1 honestly reported unplaced) → "okay, do
  it" (committed EXACTLY what was previewed — 2 work-block events + 1 presentation event, 3 total; the unplaced item
  stayed unplaced, not silently booked). Confirmed via direct SQLite inspection that DB state matched the preview
  exactly, `PRAGMA foreign_key_check` clean. Also verified: "never mind" discards with zero events created; "do it" or
  "nothing tuesday" with no active draft falls through cleanly (no draft → the model gets a plain error, nothing crashes);
  the code-level guard against same-round commit.
- **Unit tests** (`tests/weekplan.test.ts`, 13 checks): basic placement, no double-booking, spillover to the next day, a
  due date bounding the search, an already-overdue obligation never searched, nowhere workable before deadline reported
  honestly, an excluded day genuinely cleared, a fixed commitment blocking exactly its own window (timed and all-day),
  the summarize/describe split, and that an assumed effort is never quoted as the user's own figure. One test-authoring
  mistake caught by actually running it: a scenario had the busy window run right up to `workEndHour` itself, leaving no
  free time within working hours regardless of the due date — not a product bug, just an unrealistic fixture; fixed by
  moving the busy window's end inside the work day.
- **Node tooling gotcha, worth remembering:** `core/weekplan.ts` is the first `core/*.ts` module tested via plain `node`
  that itself imports ANOTHER core module (`./schedule`, extensionless — matching the same convention every other
  core file already uses, e.g. `core/plans.ts` → `./recurrence`). That convention is required for the real app's
  Vite/tsc "Bundler" resolution, but Node's own native TypeScript type-stripping does NOT auto-append `.ts` to an
  unresolved relative specifier the way a bundler does — every previously-tested core file was a "leaf" only importing
  `luxon`, so this never came up before. Changing the import to `.ts` breaks `tsc` (`TS5097`); changing it to `.js`
  (the NodeNext convention) satisfies `tsc`/Vite but Node's runtime then looks for a literal `schedule.js` that doesn't
  exist. Fixed WITHOUT touching the source convention: `tests/_ts_ext_loader.mjs`, a tiny Node ESM `resolve` hook that
  retries a failed relative import with `.ts` appended, registered (`node:module#register`) only inside
  `weekplan.test.ts` itself before a dynamic `await import(...)` of the module under test; ordinary type-only imports
  (`import type {...}`) are elided by type-stripping and need no such help. Reusable verbatim if a future core module
  ever imports another one.
- Not exercised: the model's own free-text phrasing of `plan_week`/`refine_week_plan` results when the tier-0 router
  phrases don't match (the read-tool text is still relayed verbatim either way — untested is only whether the model
  reliably calls the right tool from looser phrasing, not whether the computed text itself is ever altered); a
  multi-week horizon (only "this week", per week-start setting, is in scope); refining with a fixed-commitment time that
  itself conflicts with something already placed (recompute handles it structurally but wasn't specifically probed).

## Phase 7f — replanning (2026-09-18)
- **The core rule, literally: nothing moves without approval.** `replan_sessions` now previews before it ever writes.
  First call: `src/main/replan.ts#buildReplanProposal` computes exactly what would be cleared (a plan's own future
  `planned`/`moved` sessions — done and missed rows are never touched) and what would replace it (candidate slots along
  the PLAN'S OWN cadence, from `core/plans.ts#generateSessionSlots`, one per vacated session), grades every candidate
  with the same deterministic `planning.assessSlot` used by 7e, and NEVER even proposes a slot graded `hard` — it is
  skipped and counted instead (`skippedHardConflicts`). Nothing is written; the tool returns `needs_confirmation` with
  the preview as the question, reusing the SAME generic `confirm` Offer + deterministic yes/no plumbing built for
  `delete_event` in §11C and extended nowhere else since — no new mechanism needed. Second call, `confirmed: true`,
  recomputes the SAME proposal fresh (never trusts a stale cached list — matches `delete_event`'s own precedent) and
  commits precisely those ids: `repo.deleteEventRow` per cleared session, `repo.insertEvent` per new one.
- **`src/core/replan.ts`** (platform-independent): `planReplan(input) → ReplanProposal` does the workload-vs-capacity
  arithmetic (shortfall before/after, `still_short`, `covers_minutes`) and two honesty checks that skip the confirm
  question entirely because there is nothing to approve: `nothing_to_replan` (no future sessions at all) and
  **`no_change`** (the recomputed cadence lands on exactly the same times as before — a real bug's fix, see below).
  `describeReplanQuestion`/`describeReplanDone` write the sentence in both directions — before ("Nothing moves until
  you say so — shall I go ahead?") and after ("Replanned … cleared … put … in their place").
- **A real bug, caught by actually running it (not just reading the code):** the first version graded every single
  candidate slot as `hard`, always, because the sessions a replan is about to CLEAR are still sitting in the database
  at preview time — every candidate landed on the exact time of the very row it was meant to replace, and
  `planning.assessSlot` correctly (from its own point of view) called that a hard conflict with itself. Fixed by
  widening `assessSlot`'s `ignoreEventId?: string` to `ignoreEventId?: string | string[]` (backward compatible — the
  one other call site, `update_event`'s own single-id move-check, is untouched) and passing every id about to be
  cleared. Caught immediately because the very first live test came back "12 slots skipped, nowhere workable found" —
  the honesty in the phrasing (7c/7d/7e's whole discipline) is what made the bug visible instead of silently wrong.
- **Triggers (spec: "work is missed, a deadline moves, availability changes, or a plan falls behind"):**
  (1) `mark_session {state:'missed'}` now checks the SAME "falling behind" definition as 7d's `get_forgetting` (a real
  miss, or no runway left to cover the target) and appends a nudge — never auto-replans — `Say "replan the X sessions"
  if you'd like me to work out a catch-up schedule.` (2) `add_constraint` (kind `unavailable`) now calls
  `replan.plansAffectedByConstraint` — expands the new window over a 90-day horizon (so a recurring "busy every
  Tuesday" constraint is caught, not just a one-off) and, if it now sits on top of any active plan's future sessions,
  appends `This now clashes with N sessions of "X" — say "replan the sessions" if you'd like me to work around it.`
  Router: "replan the study sessions" / "catch up the plan" / "fix the schedule for X" / "reschedule X" → `replan_sessions`.
  (3) A moved deadline is NOT wired in this pass — see below.
- **Deliberately out of scope for this pass:** replanning is built only for PLAN sessions (the concrete, testable case
  in §11G 12), not a general re-scheduler for ad hoc deadlines/tasks — that overlaps 7g's "conversational planning" and
  would need its own design. A plan's `deadline_item` link (if the linked item's own due date changes) is not wired to
  automatically prompt a replan yet. The commit is not undoable (`reversible: false`, matching the OLD `replan_sessions`'
  own precedent from 6f — not a regression). Two pre-existing date-parsing gaps were hit while testing and are NOT
  fixed here (out of scope, unrelated to 7f's own logic): "on the 23rd"/"on the 25th" (an ordinal day with no month)
  reliably parses as today's date instead of the named day, in both `create_event` and `add_constraint` — worth a
  dedicated pass since it silently mis-dates things rather than erroring.
- **Verified on scratch DB r1** (a 12-session plan, 2 sessions marked missed): the missed-session nudge appeared
  correctly; "replan the study econometrics sessions" with nothing else conflicting correctly detected **no_change**
  and asked nothing (the two missed sessions' own still-on-calendar rows correctly counted as 2 skipped hard
  conflicts, since a miss is not a deletion); after booking a real meeting over one future session and adding a
  recurring-style unavailable window over another, "replan the sessions" correctly proposed clearing 9/10 future
  sessions and replacing only 8/9 of them (skipping both new hard conflicts), named the exact times on both sides, and
  said the plan would still be short; "no, keep it" left the database completely untouched (12 sessions, unchanged);
  "yes, go ahead" committed exactly what was previewed — the meeting and the missed sessions were never touched, the
  foreign-key check stayed clean, and the count matched exactly (12 → 11: 2 missed kept, 1 old cleared without a
  replacement, 9 new ones in place of the other 9).

## Unit tests for 7b/7c/7e/7f core logic (2026-09-18)
- `tests/now.test.ts` (29 checks), `tests/deadline.test.ts` (26), `tests/schedule.test.ts` (10), `tests/replan.test.ts`
  (12, added with 7f — see its own section above) — same convention as `tests/recurrence.test.ts`/`entity.test.ts`:
  plain Node type-stripping, no build step, no framework. Run individually: `node tests/now.test.ts` / `deadline.test.ts`
  / `schedule.test.ts` / `replan.test.ts`. Not wired into `tsconfig.*.json` (same as the existing two) or any `npm test`
  script — there isn't one yet; worth adding a `test` script that runs all six in a row.
- **now.test.ts**: `bandFor` hour boundaries and that a zone conversion actually happens (not just the raw UTC hour);
  ranking order (overdue > promise; ideas ranked-but-penalised, never silently dropped, unlike project/waiting/note
  which never enter ranking at all); the unblocks score cap at 3 vs. the wording still reporting the true count;
  blockers → excluded with the exact reason, never picked; attendance-style titles and fixed-time-far-out both excluded
  as "not work to start"; day-precision items are never "fixed" regardless of wording; the in-a-meeting ≤10 min rule;
  every free-window branch (<15 min hard cutoff, fits/doesn't-fit, the >180 min "fits in" phrase is suppressed as
  noise); night/morning/evening weighting; low-energy weighting and its sentence; a running work block always wins;
  the 12-point alternatives window; the "nothing at all" / "nothing in this meeting" honesty paths; assumed effort is
  never called "your figure".
- **deadline.test.ts**: `hoursText` formatting; `waitLabel`; all seven `Feasibility` values including the two distinct
  routes into `tight` (plain ratio > 0.6 vs. a long dependent chain with a real test proving the CHAIN-specific branch
  and its wording actually fire, not just that the ratio also happened to qualify); a done blocker no longer blocks;
  `unscheduled`/`startable`/`blocked` set membership; waits never counted toward `total`/`done`; the full bottleneck
  priority order (a gating wait > a gating step > the largest STATED piece > null when nothing stated/nothing gates,
  including the "one lone piece is never its own bottleneck" edge case); assumed-vs-stated effort wording ("all of
  that" vs. a fraction); contradictions voiced first in every mode including `bare`; `short` vs `bare` differing by
  exactly the leading name/progress sentence and nothing else.
- **schedule.test.ts**: a clean day; a meeting splitting it into two gaps with the right `precededByBusy` on each; the
  duration filter only affects which gaps are RETURNED, never the running totals (needed so an infeasible verdict can
  still cite the true total free time); overlapping busy windows merging correctly (no phantom negative micro-gap);
  `fromUtc`/`untilUtc` truncating the first/last day instead of the nominal work hours; a day fully eaten by one
  meeting contributing nothing while the next day still counts; an overnight event starting before the workable window
  correctly truncating that day's start; `max` capping returned windows without capping the total/longest accounting.
- **Two real mistakes were caught by actually running these, not just writing them** — worth remembering as a reason
  to always execute a new test before trusting it: (1) a "close alternative" scenario used `importance:1` (+15) as the
  gap-of-15 from a `+30` pick, which is 15 points away — OUTSIDE the 12-point alternatives window — so the "close" item
  never actually appeared as an alternative; fixed by using `unblocks:3` (+24, 6 points away) instead. (2) the
  `unblocks` wording test assumed the score-capped count (3) was also what the SENTENCE reports for `unblocks:7`; the
  code actually reports the true count (7) in the text while only capping the score's contribution — the test's
  assumption was wrong, not the code; fixed the assertion, left the (reasonable) behaviour alone.

## Voice — spoken brain dumps (2026-09-17, spec §8 Phase 7 "Voice")
- **A mic button beside Send**, in the conversation input row (`App.tsx`). Press to start recording (`getUserMedia` +
  `MediaRecorder`, button turns red and counts seconds), press again to stop and send; a small ✕ appears beside it while
  recording to cancel and send nothing. Textarea and Send are disabled while recording; the mic itself is disabled while
  a text message is in flight (`status.kind !== 'idle'`), but NOT while recording (so stopping always works).
- **Electron blocks `getUserMedia` by default** — `session.defaultSession.setPermissionRequestHandler` in `index.ts` now
  grants only the `media` permission (camera+mic as one Chromium grant; only audio is ever requested), scoped to this
  app's own window. The Windows OS-level microphone privacy toggle still governs actual hardware access underneath that.
- **Format: client-side WAV, not the browser's native webm/opus.** Chromium's `MediaRecorder` in this app only produces
  `audio/webm;codecs=opus`, which is not on Gemini's officially documented supported audio list; `blobToWavBase64`
  (`App.tsx`) decodes the recording with `AudioContext.decodeAudioData`, downmixes to mono, and hand-encodes a 16-bit PCM
  WAV — universally supported — entirely in the renderer, before the base64 ever reaches the main process.
- **Audio goes to Gemini directly, through the exact same provider and tool schema as a typed dump — one model call,
  same 7a extraction rules** (spec's own words). `ProviderMessage`'s user variant grew an optional `audio: {base64,
  mimeType}`; `gemini.ts#toContents` adds it as a second `inlineData` part alongside the text part, in the SAME turn.
  `orchestrator.ts#enqueueVoice`/`handleVoice` mirror `enqueueChat`/`handleChat` almost exactly (same queue, same
  `runToolRound`, same `phraseReadResults`, same `ask_clarification` handling, same one-call budget assertion) but skip
  tier 0 entirely (nothing to pattern-match before the audio is heard) and always set `preferStrong` (audio+extraction is
  inherently hard). `VOICE_ADDENDUM` is appended to `SYSTEM_PROMPT` only for this call; typed messages are untouched.
- **The transcript problem, and how it was actually solved.** Free text alongside tool calls is UNRELIABLE — verified
  directly against the real API (see below): gemini-3.6-flash routinely returns tool calls with NO accompanying text at
  all, despite being told to always include one. The fix: a small, always-mandatory tool `note_transcript {text}`,
  included ONLY in the voice request's tool list (never in `toolDefinitions()`, so typed messages are unaffected). The
  model is instructed to call it first, exactly once, every turn. This is intercepted by the orchestrator exactly like
  `ask_clarification` already is — filtered out of `calls` before `runToolRound`, never reaching the tool executor — and
  its text becomes both (a) the stored user-message content (`repo.updateMessageContent`, mutating the in-memory
  `userMessage.content` too — a real bug was caught here: the FIRST version updated only the DB row, so the returned
  `ChatResponse` still carried the stale "🎙️ …" placeholder and the chat bubble would have shown that forever) and
  (b) what the personality line and activity records use as "what the user said". This was empirically far more reliable
  than free text: 4/4 test recordings got a clean transcript via the tool call after adding it, versus 0/2 via text alone.
- **Local storage, never sent anywhere else.** Every recording is also written to `<userData>/voice/<timestamp>-<id>.wav`
  (`index.ts`, the `chat:sendVoice` IPC handler) purely for the user's own record — a save failure only logs a warning
  and never blocks the actual message. The audio is never read back by the app, never uploaded anywhere but the one
  Gemini call the feature requires, and the file itself never leaves the machine.
- **Verified against the real Gemini API with real spoken audio**, not synthetic text: four WAV files were generated with
  Windows' own `System.Speech.Synthesis` TTS (a genuine speech signal, not silence or noise) and driven through the
  actual production code path end to end — via a new dev hook, `SECRETARY_CHAT="@C:\path\to\clip.wav||next line"` (a
  line starting with `@` is a voice turn; mixes freely with typed `||` turns and `!tool` manual lines) — on a scratch
  database. All at 1 model call, tier "voice", MAX_MODEL_CALLS_PER_MESSAGE never exceeded:
  - "Remind me to call the bank tomorrow at three p m." → task + reminder, correct date AND time (tomorrow's date, 15:00).
  - "The case study will take about two hours and I need to finish it by Friday." → task due Friday, `effort_minutes: 120`
    stored from the user's own spoken figure (invariant 2 — confirmed in the database, not just the reply text).
  - "Hey, just checking in, how's it going today." (nothing actionable) → clean acknowledgment, nothing created at all.
  - "I can't book the meeting room until the department confirms the budget." → a genuine `waiting` item (waiting_on
    "department") AND a task, both created correctly — see the gap noted below.
- **Known gap, not fixed here:** the same dependency phrase typed alone would hit tier 0's widened 7b rule (built earlier
  this session) and get a `blocks` link between the wait and the task, deterministically. Voice always skips tier 0, so
  it falls to the model's general judgement under the Brain dumps (7a) prompt section only — it made the wait and the
  task correctly but did not add the link. A typed brain dump longer than one line has this same gap already (tier 0
  also steps aside for `looksLikeDump`), so this is not a voice-specific regression — worth a pass across both spoken and
  multi-clause typed dumps together, not solved by re-routing voice through tier 0 (the transcript only exists after the
  one model call already happened).
- **Not exercised from here:** the actual button click / hold-to-record / permission-prompt flow in a live window — this
  needs a real microphone and a human voice, which this environment cannot provide; the user should press the button
  and speak to confirm that half. Also not tried: a genuinely silent or noise-only recording (the model is instructed to
  say so via `note_transcript` rather than invent content, but this has not been observed against real silence).

## Phase 7d + 7e — "what am I forgetting?" widened, and smart scheduling (2026-09-17)
- **7d — definite vs possible, strictly kept apart (§11G 8, 9).** `get_forgetting` (tools.ts) now returns, alongside the
  existing commitments/overdue/waiting/due_soon(2d)/at_risk(7b): `unscheduled` (due within 14 days, no work block set aside,
  deduped against commitments/overdue/waiting/due_soon by title so nothing is said twice), `plans_behind` (a plan with an
  ACTUAL missed session, or no more runway left — `next_session_utc` null — while `shortfall_minutes` remains; a brand-new
  plan that simply hasn't reached its target yet is NOT "behind", or every plan would be flagged on day one), and
  `possible: {ideas, suggestions, quiet_projects}` — open `kind='idea'` items, open `is_suggestion=1` items, and open
  projects with no due date and no activity in 4+ days. The orchestrator composes two clearly separate sentences: a
  "Definite" paragraph (or "Nothing definite.") and, only if there is anything, "Possible, not acted on: …" — never merged,
  never reordered by the model. `get_forgetting` is read-only, so mentioning something possible can never itself create it
  (the other half of invariant 9's spirit). Zero model calls (tier 0 → get_forgetting, phrased in code).
- **Ideas no longer count as Open** (`App.tsx` `standalone` filter, alongside `waiting`/nested `checklist_item`) — spec §4's
  "idea, not a hard task" now holds in the rail, not just in the prompt; required by §11G 9 read literally ("nothing labelled
  possible appears in Open afterwards"). Ideas still exist as rows and surface via `get_forgetting`'s possible section.
- **7e — smart scheduling, feasible/tight/infeasible, never books itself.** `src/core/schedule.ts` (`findFreeWindows`,
  platform-independent) walks the calendar day by day between two workable hours (08:00–22:00) and returns gaps ≥ the
  asked-for duration against HARD-busy windows only (events + `unavailable` constraints), plus `totalFreeMinutes` and
  `longestGapMinutes` for explaining an infeasible answer. `src/main/schedule.ts` (`proposeSlot`) turns each gap into a
  candidate slot — nudged forward by the default 15 min buffer when the gap is generous and bounded by a real prior event,
  so a big gap doesn't manufacture a false "tight" grading — then grades EVERY candidate with the existing deterministic
  `planning.assessSlot` (buffers, neighbours, avoid windows: the same clear/tight/poor/hard used since 6f). Candidates sort
  clear → poor → tight, earliest first; the best is the pick, up to two same-tier/next-tier alternatives on different days
  are offered. Top-level `feasibility`: no candidate at all → `infeasible` (says whether there's no free time at all, or
  free time exists but never in one uninterrupted block, using `totalFreeMinutes`/`longestGapMinutes`); best candidate
  `tight` → `tight`; `clear`/`poor` → `feasible`. A deadline already passed is caught before any search and refused
  outright. `describeProposal` writes the whole sentence in code — zero model calls to ask.
- Tool `propose_slot {title, minutes?, item_id?, before_local?/before_date_local?}` (read-only — NEVER books). Router:
  "I need <duration> for/to <X> before/by <Y>", "find (me) (some) time for <X> before/by <Y>", "when can I fit in/do <X>
  before/by <Y>" → propose_slot; duration omitted → uses the matched item's own `effort_minutes` or a labelled 60 min
  assumption. Title resolves against open items/steps first (invariant 11) after stripping a leading verb ("finish/write/
  do the report" → "the report"); an item's own due date is the deadline when none is stated.
- **Booking is a separate, always-remembered, deterministic confirm step — this is where a real bug was caught and fixed.**
  `propose_slot` always calls `setOffer({kind:'slot_proposal', …})`, even on infeasible (with `startsAtLocal/endsAtLocal:
  null` in that case) — NOT only when a bookable slot was found. Router intercepts "book it"/"yes"/"schedule it" etc.
  whenever this offer exists: a real slot → replay `create_event` with EXACTLY the proposed time; no slot → a REPLY refusing
  ("There's nothing to book … tell me a different deadline…"), never falling through to the model. **First cut only set the
  offer when a slot existed; on infeasible, "book it" fell through to tier 2 and the MODEL, seeing the conversation's own
  "busy all day" constraints, called `create_event` with `override_conflicts=true` on its own initiative** — exactly the
  "scheduled something that cannot happen" failure §11G 11 forbids. Fixed by always setting the offer and refusing
  deterministically; prompt also now explicitly forbids the model from adding `override_conflicts` to force an infeasible
  proposal through.
- Verified on scratch DBs: feasible (a real 2 h gap, phrased with the deadline), tight (only a 0-gap-either-side slot exists
  before the stated time — phrased "It's tight: straight before …"), infeasible (both days blocked → "there's only 0 min
  free in total… something has to give"), infeasible → "book it" now correctly refused (was the bug above), a genuine
  "book it" → `create_event` fires and the day reads it back correctly, all at tier 0 / 0 model calls. 7d: promise +
  overdue + waiting + unscheduled + a genuinely missed plan session all listed distinctly under one "Definite" paragraph; an
  idea and an unconfirmed suggestion listed separately under "Possible"; a fresh plan/fresh project correctly NOT flagged;
  a project stale for 4+ days correctly flagged as "gone quiet".
- Not exercised: §11G 2 (spoken dump — Phase 7a's own item, not touched here); a real multi-day propose_slot search where
  the best slot lands on a later day than the first checked; `tests/` still has no unit coverage for `core/now.ts`,
  `core/deadline.ts` or `core/schedule.ts` — worth adding before Phase 7 is called done.

## Phase 7c — "what should I do right now?" (2026-09-17)
- **Ranked in code, phrased in code, zero model calls.** `src/core/now.ts` (`recommendNow(input) → Recommendation`,
  `describeRecommendation`) is platform-independent; `src/main/now.ts` (`recommendNowAt(nowUtc)`) collects: open tasks /
  deadlines / commitments / checklist steps / ideas (never suggestions, waits, projects, notes), each with open blockers
  (waits named as "the reply from X"), how many things it unblocks, whether a work block for it is running now, its project,
  the user's effort figure; the free window before the next timed event or unavailable constraint (`occurrencesBetween` +
  `constraintWindows`), whether the user is inside an event / unavailable window right now; today's context (low energy).
- **Scoring:** running work block +100 ("you set this time aside for it") · blocked → set aside with the reason · inside a
  meeting → only ≤10 min things · free window < 15 min and effort > window → set aside ("needs about 1 h and "X" starts in
  8 min") · fits the window +8 / won't finish −12 · overdue +50 · promise +30 · hard +25 · critical +30 / high +15 / low −8 ·
  idea −25 · due today +14 / tomorrow +8 / ≤3 days +4 · unblocks +8 each (max 3) · night (before 07:00 or from 21:00): effort
  > 45 min −25, ≤ 20 min +10 "it's late — a small one" · evening: > 2 h −8 · morning: ≥ 1 h and important +6 "a big one for a
  fresh morning" · low energy: > 1 h −15, ≤ 20 min +5. Effort assumed at 30 min for a step, 60 otherwise, and said to be the
  user's figure only when it is. Ties: earlier due, then older.
- **Output:** ONE pick with up to three reasons; runners-up (max two) only when within 12 points; blocked things named as
  "set aside" when the pick is weak; when nothing can start: "Nothing you can start right now: X waits on …; Y needs about
  1 h and "Z" starts in 8 min." (+ "It's late — nothing here needs tonight." at night). Never an unranked list.
- Tool `recommend_now {at_local?}` (read; `at_local` only for testing the clock), router: "what should I do (right) now / next /
  first / today", "what now", "where do I start", "what's next", "give me one thing". Prompt: relay, never answer from memory.
- Dev hook: manual read tools in `SECRETARY_CHAT` now print their phrased answer ("→ …") via `ToolRunResult.text`.
- **Fixes from the user's first real run (2026-09-17 01:30 IST):** (1) "I'm busy for the next hour" became 02:00–03:00: NOT a
  timezone fault (machine, Node and the app all agree on Asia/Calcutta; message timestamps match the clock) — chrono reads
  "next hour" as a point an hour ahead and the rule rounded it to the hour. The availability rule now handles durations and
  end times starting NOW, to the minute: "for the next hour / for 2 hours / for 45 minutes / half an hour", "until 3 / till
  4pm", "right now / for a bit" (→ 60 min). (2) Low energy weighed too weakly (only effort > 60 min was penalised, the
  assumed hour was not): now effort ≥ 45 −20, ≤ 20 +10, and when the pick is still ≥ 45 min the sentence says "You said
  you're low today — this is the smallest thing that's actually open … leaving it for tomorrow is fine." (3) Things you
  ATTEND are not work to start: an attendance-like title (`ATTENDANCE` regex: screening, meeting, class, appointment, flight,
  dinner …) or an exact clock more than two hours away is set aside ("is something you attend (Sat 16:00), not work to
  start" / "is fixed for …"), never offered, never "you can make a start". The user's "Umar Khalid screening" is a TASK row
  with an exact time — semantically an event; consider turning such rows into events when the user confirms.
- Gotcha hit again: a Python heredoc through Bash turned `\b` into a backspace inside the ATTENDANCE regex — repaired with
  `chr(92)+'b'`; always scan for control characters after a heredoc patch.

## Phase 7b — deadline intelligence (2026-09-17)
- **Compute, then phrase — literally.** `src/core/deadline.ts` (`assessDeadline(input) → DeadlineAssessment`, `describeAssessment`)
  is platform-independent and produces the whole answer as prose; `src/main/deadlines.ts` is the SQLite glue
  (`assessTarget(id)`, `capacityUntil(due)`, `upcomingDeadlineTargets(14)`, `atRiskLines(14)`). Asking "is X on track?" costs
  ZERO model calls (tier 0 → `assess_deadline`, phrased from `result.text`).
- **Components** = a project's parts (open + done, not cancelled) plus its open waits; for a dated standalone item, the item plus
  everything that transitively blocks it. Never anything else — the text ends "That is everything you have listed — tell me if
  there are more parts" instead of inventing steps (§11G 5).
- **What is computed:** remaining / done (steps only — waits are not counted as parts), blocked (open blockers among the
  components), startable, unscheduled (no future work block via `events.item_id`), downstream reach per component over the
  `blocks` graph, critical path (longest effort chain), needed minutes (stated + assumed), capacity, feasibility.
- **Bottleneck rule (in order):** a WAIT that gates steps ("the reply from Priya — it gates one step and has no expected date") →
  the step with the largest downstream reach → the largest remaining piece if the user gave figures. Waits are spoken of by who
  owes the reply, never by their row title.
- **Feasibility:** `no_deadline` · `complete` · `passed` · `unknown` (only waits left) · needed > capacity → `infeasible` ·
  critical path > 80 % of capacity with blocks, or needed/capacity > 0.6 → `tight` · else `comfortable`. Capacity = per day
  min(6 h workable, `available_minutes`) − `scheduled_minutes` via `buildSummaries`, today only the part before 22:00 — "roughly".
- **Estimates (invariant 2):** `items.effort_minutes` (column existed, now written) via `create_item/update_item.effort_minutes`,
  ONLY for the user's own figure ("attaching the document will take about two hours" → 120). Missing figures are assumed at
  60 min and the text says so ("1 h of that is assumed at 60 min a piece — give me your own figures").
- **Surfacing before it is urgent:** `atRiskLines(14)` (tight / infeasible / passed / gated by a wait) feeds (1) the context as
  "Deadlines to watch (computed — relay, do not re-rank)", (2) `get_forgetting` → "Deadlines to watch: …", (3) `get_project` on a
  dated Thing appends the bare assessment (bottleneck + verdict) so "what is left for X?" names the bottleneck unasked (§11G 4).
- Router: "is X on track / feasible / doable", "can I still make X", "what's the bottleneck (for X)", "how's X looking",
  "am I going to make X", "where do I stand on the X deadline" → `assess_deadline` (name resolved over dated projects + hard/
  deadline items; no name → focused project, else the soonest). Prompt: a "Deadlines (7b)" section — relay, never re-rank, never
  add a component, pass effort_minutes only for stated figures.
- **Verified on scratch c8** (TISS mailing due Wed 23, parts: Send first email ✓, Attach the document 2 h stated, Follow up
  blocked by the wait on Priya): "is the TISS mailing on track?" → 1 of 3 parts done · bottleneck the reply from Priya (gates one
  step, no expected date) · can start now / blocked lists · comfortably feasible, ~3 h against ~42 h · assumption labelled · 0
  model calls. "what is left for TISS mailing?" carries the bottleneck line. "what am I forgetting?" adds "Deadlines to watch".
  Set-up sentences (due date, effort, "can't follow up until Priya replies") each cost one model call.
- Not exercised yet: an `infeasible` verdict on real data; multi-level block chains beyond one edge; `tests/` has no unit test
  for core/deadline.ts yet (worth adding: chain, wait-gated, passed).
- **Fixes from the user's first real-data run (2026-09-17):** (1) `get_project.done` listed a tick that had been UNDONE (it was
  built from `completed` activities) — now only completions whose item is still `done` count. (2) "I can't follow up until Priya
  replies" never became a link through the model, twice — the 3f dependency rule is now wide and deterministic: "can't X until /
  before / unless Y", "X has to happen before I can Y", "once Y, I can X"; the blocker side resolves "Priya replies / I hear
  from Priya / the dept confirms" to the single open WAIT on that person, else to an item; the blocked side resolves over open
  items AND checklist steps. (3) **Contradictions are voiced:** `deadlines.noteDateConflicts(item)` reads every note on a dated
  item (chrono + a bare-ordinal fallback for "the 20th"), and a note naming a different day is reported — at note time
  ("Careful — that says Sun, 20 Sept, but it is dated Wed, 23 Sept. Which is right?") and first in every assessment
  ("Careful: a note on it says … — which is right?"), and it makes the deadline count as at-risk. (4) Blockers of a part that
  live outside the Thing (a wait filed elsewhere) are pulled into the assessment so the part shows as blocked.

## Phase 7a — brain dump and messy input (2026-09-17)
- **Routing:** `router.looksLikeDump(text)` (newline, > 220 chars, or ≥ 3 clauses split on sentence ends / "also" / "and then" /
  "plus" / "oh and" / dashes) → tier 0 bails out entirely so it cannot grab the first clause and drop the rest. The whole
  message goes to the model ONCE with `preferStrong` (provider starts on the second model in the chain — 3.6-flash — instead
  of flash-lite; still one call). `ai.response` logs "(model, dump)".
- **Extraction is the existing tool set**, no second pipeline: the prompt's "Brain dumps (7a)" section maps clause → tool
  (obligation → create_item, deadline → kind deadline, remind → remind_*, promise → commitment + committed_to, note → add_note,
  feeling/location → note_context, done → record_activity / complete_checklist_item, "haven't heard back" → create_waiting,
  "can't X until Y" → add_link (+ create_waiting when Y is a wait), Thing mentioned → update / project_id) and says: resolve by
  id before creating; do every clear part; at most one question.
- **One clarifying question, enforced in code:** new read tool `ask_clarification {question, about}`. The orchestrator lifts
  it out of the round, applies every other call, appends "One question: …" to the composed reply; a second/third ask is dropped
  and logged (`ai.clarify_capped`), logged to `extractions` like any proposal. A response that is ONLY a question replies with
  the question.
- **Invariant 11 in the tool layer:** `create_item` runs `findTwin(title, open items + checklist steps, not projects/waits)`
  (`resolveEntity` match ≥ 0.9, or content-word containment with ≥ 2 tokens on the shorter side) and, on a twin, UPDATES it
  through `update_item` (due, details appended, hardness, commitment, idea → task) + attaches the project + adds any reminder
  via `create_reminder`; phrase "Already had "X" — …". "Email TISS about the invoice" vs "… about the mailing" stay separate.
- **Reply shape:** ≥ 3 applied changes → "Got it — N things:" + one "• phrase" line each (bubbles are `whitespace-pre-wrap`).
- **Verified on scratch c8** (project "TISS mailing" with 3 steps, event "Umar Khalid screening"): a 9-clause dump → ONE call
  (gemini-3.6-flash, 23 s, 17k tokens in), 10 changes: step "Send first email" ticked off (resolved, not re-created), waiting
  on Priya under TISS mailing, "Attach the document" resolved to the existing step (promoted, due Friday), reminder, commitment
  to Rahul, today's context "exhausted" (nothing stored), task "Book room…" due before the 26th, waiting on the department, note
  attached to the screening event, an idea (not a task) for "should probably start reading". "What am I forgetting?" then
  listed promise → waits → coming up and reflected the exhaustion. §11G 1 and 3 exercised (typed); 2 (spoken) is later.
- Seen: "remind me thursday evening" on a Thursday after midnight → the model chose NEXT Thursday (ambiguous; left). The
  "can't book until the dept confirms" clause became a wait but no `blocks` link on the first run — prompt now spells out
  wait + link together; re-verify. **Superseded 2026-09-18: root cause identified and fixed (`add_link` now accepts
  `from_title`/`to_title` for a side with no id yet, see "Fixed: `add_link` crashed …" below) — this was the same gap,
  just without the throw a slightly different repro phrasing later exposed.**

## Light / dark mode (2026-09-17)
- Every colour the UI uses is a Tailwind theme variable: `@theme` in `styles.css` names the palette (`cocoa`, `cream`, `accent`,
  `cocoa-soft`, `mocha`, `paper`, `paper-2/3/4`, `sand`, `ash`, `ash-2`, `pure`, `tan`, `slate-soft`, `rust`, `ink-muted`) and the
  renderer uses `bg-cocoa` / `text-cream` etc. instead of `bg-[#3A2E28]` (all bracketed hex utilities were renamed). The
  FullCalendar block uses the same variables (`color-mix` for the translucent ones).
- `:root[data-theme="dark"]` overrides the palette AND inverts the stone/amber/rose/emerald/sky/red scales + `--color-white`,
  so the ~250 existing `text-stone-500`-style utilities keep their meaning. The room/companion SVG art keeps its own colours.
- Setting `ui.theme` (light|dark) in `settings` (whitelisted in `index.ts`), mirrored in localStorage (`main.tsx` applies it
  before first paint). Toggle: "☾ dark / ☀ light" at the right of the top nav. Dev hook: `SECRETARY_VIEW=…,theme:dark`.
- Not done: following the OS preference automatically (an "auto" option) — the user asked for a two-way switch.

## §11C calendar acceptance run (2026-09-17, scratch c7, fresh DB, ~9 electron launches = restarts between groups)
- Pass by conversation: 2, 3, 5, 6, 7 (Thursday meeting → moved → task due Thu with no time → reminder 14:30 separate → date note);
  14 (dentist cancelled, "what am I doing friday?" no longer lists it); 13 (series 14:00–16:00, "move next tuesday's class to 3" →
  exdate + standalone, series row untouched); 15 (plan → 12 sessions, 24 h against 30 h target, "8 h not yet placed" after a skip);
  16 ("skip friday's econometrics session" → missed, plan active, shortfall stated); 17 (one session moved by `update_event`, plan
  "next session Mon 18:00", others untouched); 18 (progress = hours done/target/missed — no streak, no score); 19 (5:15 over the
  17:00 meeting → refused, "18:00 onwards"); 20 (coffee at 18:00 straight after → booked, "tight fit: 0 min gap"); 21 (buffer 30 min
  after TISS → call 10 min after the TISS meeting booked with "poor fit"); 22 (Friday "busy" in Month, descriptive word + dot);
  24 (Delhi = one all-day event, band Mon–Wed in Month and Week, "continues" on Tue/Wed in get_day); 26 (Mon start; setting 0 → Sun);
  27 (after relaunch: plan progress, moved + missed sessions, series + moved occurrence, Delhi, buffers all read back identically).
- Pass by screenshot: 1 (own full-width surface, no rail), 8 (priority strip under the header with no panel open), 9 (glyph + word:
  "! high", "◆ hard deadline", "☐"), 10 (panel with priorities/due/schedule/reminders/notes/completed), 11 (`complete_item` = the
  panel's ✓ → item under Completed, `completed` activity in history, gone from Due), 25 (Sep 16: "looking back", no Priorities
  section, missed reminder listed, Completed + What happened).
- 4 and 12: the drop handlers call exactly `update_event {id, starts_at_local, ends_at_local}` and `create_event {kind:work_block,
  item_id}`; both ran and the assistant read the new state back ("Meeting … 17:00–18:00", "Submit the report — time set aside").
  The mouse gesture itself was not performed (cannot be automated here) — the user should drag once to close 4 and 12 for real.
- 25's data: the fresh DB had no past-dated rows, so one completed item, its activity and a missed reminder dated 2026-09-16 were
  planted by SQL (`scratchpad/backdate.cjs`) — the rendering is real, the history was staged.
- 23 (nothing moved without approval): the `activities` audit shows every event change traces to an explicit request — EXCEPT
  two defects found and fixed during the run (below). Both are now deterministic.
- **Defects found and fixed during the run:**
  1. "econometrics class every tuesday 2-4" went to the model (router noun rule needed the noun first) and the model dropped the
     end time → 1 h. Router now accepts a one/two-word qualifier before the noun ("econometrics class", "team standup"), never a
     verb/preposition; tier 0 builds the 2 h series.
  2. "cancel the econometrics class" with a series + a moved occurrence: the model picked the moved occurrence's id and deleted just
     that, leaving the series (invariant 10 violation). `delete_event` on a series (or an event sharing its title with a series)
     now returns a confirmation question first; `confirmed=true` removes the series AND its same-titled moved occurrences together.
  3. Worse: answering that question with "no, keep it" made the model SKIP an occurrence instead. Confirmation questions now set a
     `confirm` Offer (orchestrator, when a write round is rolled back for confirmation and the tool set no offer of its own); tier 0
     answers it: yes/"yes, cancel the whole series"/go ahead → replay with confirmed=true; no/keep it/leave it/don't/never mind →
     "Okay — nothing changed." The model never sees the yes/no. Prompt also says a decline means call nothing.
  4. `undo` could not undo any event change ("Cannot undo …"). Undo now covers events: created → removed; deleted → restored;
     moved/skipped → restored; a moved occurrence → standalone removed + series row (pre-exdate) restored (`before` carries
     `occurrence_of`). Whole-series cancels write one `deleted` activity per row, so undo restores one row at a time.
  5. "move the class on october 13 to 5" made the model read the calendar instead of moving. New tier-0 rule: "move <day>'s X to
     <time>" / "move the X on <date> to <time>" → the single matching timed occurrence that day → `update_event`
     (+ `occurrence_start_local` for a series instance).
- Still open from this run: the DayPanel "Cancel series…" button now relies on the tool's own confirmation (its window.confirm was
  removed); the live missed-session sweep was not observed (no session passed during the run).

## Phase 6f — plans and conflict levels (2026-09-16)
- **Plans** (`plans` table, migration 7; `events.plan_id` + `events.session_state` planned|done|missed, migration 8 adds
  `events.item_id`). `src/core/plans.ts` (platform-independent): `generateSessionSlots(plan, clockLocal, tz, {fromUtc, max})`
  (wall-clock rrule), `planProgress(plan, sessions, nowUtc)`, `sessionsToMarkMissed(sessions, nowUtc, grace 120 min)`,
  `describeProgress` → "2 h done of 30 h · 1 session missed · 28 h to go, 24 h of it scheduled — 4 h not yet placed".
- Tools: `create_plan {title, rrule, session_minutes, clock_local? (default 17:00), starts_on?, ends_on?, target_hours?,
  project_id?, deadline_item_id?}` writes ONE plan row + its sessions as `events` kind `work_block` with `plan_id`;
  `update_plan`, `pause_plan {resume|abandon}`, `mark_session {id, state}`, `replan_sessions` (deletes future *planned* sessions
  and regenerates; done/missed rows are never touched), `get_plan` (read, phrased in code). Sessions are ordinary events: drag
  one and only that one moves (`update_event`), the series row is never rewritten (invariant 10).
- Router (tier 0): "Study econometrics two hours every Monday, Wednesday and Friday until October 15, 30 hours in total" →
  create_plan; "did / skip friday's econometrics session" → mark_session done|missed (day parsed, else the nearest session);
  "how is the econometrics plan going" → get_plan. Context lists plans with ids + progress; the prompt has a Plans section.
- Scheduler: `sweepMissedSessions` on each tick marks planned sessions that ended >2 h ago as missed (system activity). get_day
  says "(missed session)"; the Day panel shows `PlanProgress` and "Session done" / "Skip session" buttons through the tool layer.
- **Conflict levels** (`planning.assessSlot(start, end, ignoreEventId?) → {level clear|tight|poor|hard, reasons, next_free_utc}`):
  hard = overlap with an event or an `unavailable` constraint → refused with an alternative (unless `override_conflicts`);
  poor = inside a buffer rule or an `avoid` window → booked, phrase says "Note — poor fit: …"; tight = <15 min gap either
  side → booked, "Note — tight fit: …". The app grades, the user decides; nothing is ever moved silently.
- **Buffers** are constraints kind `avoid` with label `buffer|after|30|TISS` (`add_buffer {minutes, side after|before|around,
  scope}`; `bufferRules`, `describeBuffer`, `DEFAULT_BUFFER_MIN=15`). Router: "thirty minutes to get home from TISS", "nothing
  straight after class". The rail renders them as "↔ buffer · 30 min after “TISS”", never the raw label.
- Verified on scratch c6: plan → 13 sessions / 26 h against a 30 h target ("4 h not yet placed"); "Quick coffee" 5 min after a
  meeting → booked, tight fit named; call 10 min after a TISS meeting with a 30 min TISS buffer → booked, poor fit named;
  overlap with an existing meeting → refused with the next free slot; "skip friday's econometrics session" → that session
  missed, progress line updated; Week header chips count session hours. Not observed here: a mouse drag of a session, and the
  live missed-session sweep (needs a session to actually pass).
- Dev-hash auto-open now waits for `info` (not items), so `SECRETARY_VIEW=calendar…` works on an empty scratch DB.

## Phase 6e — manipulation (2026-09-16)
- `calendar/dragging.ts`: `moveEntry` / `resizeEntry` / `dropExternal` — every drag ends in a tool call (`update_event` with
  `occurrence_start_local` for one occurrence of a series; `create_event kind=work_block item_id` when a due chip or an
  unscheduled obligation is dropped into the grid); the library's own move is always reverted and the real row comes back
  through the data. Timed events cannot be dropped into the due row; due markers cannot be moved between days by drag (that is
  a reschedule, from the panel). `useExternalDraggable(ref)` makes `[data-item-id]` rows draggable via the adapter's
  `ExternalDraggable`. Week and Day grids: entries `editable` unless the day is past; Day's "Due today" rows are draggable.
- `calendar/UnscheduledList.tsx` beside the Week grid: `repo.unscheduledObligations()` (IPC `calendar:unscheduled`) — open items
  with a due date and no work block serving them, soonest first, whatever week is on screen; overdue ones ringed amber.
- Series in natural language: router "econometrics class every tuesday 2-4" → `parseRecurrencePhrase` + `firstOccurrence` →
  `create_event {rrule, starts_at_local, duration_minutes}`; panel shows "↻ repeats every week on Tuesday · n occurrences changed
  or skipped" (`describeRRule`), never the RRULE. Move/skip one occurrence from chat ("move next tuesday's class to 3", "skip the
  class on the 6th") or from the panel/drag: exdate + standalone event; the series row is never rewritten. Verified on scratch c2:
  series row `FREQ=WEEKLY;BYDAY=TU` with two exdates and one standalone moved occurrence.
- Conflicts: `conflictsFor` now expands recurring series and ignores all-day events (being "in Delhi" no longer blocks a 2 pm class).
- Panel "What changed": `activitiesForTarget(type, id)` (IPC `activities:target`) lists the thing's activities with actor.
- Not automatable here: the actual mouse drag. Tool paths behind every drag are the same `update_event`/`create_event` verified
  above; §11C 4, 12 and 13 need a hand on the mouse to confirm.

## Phase 6d — Month, Week, Agenda with distinct jobs (2026-09-16)
- One fetch per visible range: IPC `calendar:days` → `buildDays(from, n)` (the same `buildDay` per date, ≤ 42). `CalendarSurface`
  computes the range per mode (`rangeFor`: day 1 · week 7 from the week start · agenda 14 · month = full weeks covering the
  month), fetches once, and every view reads the same `DayBundle[]`. Header title/step follow the mode (month ±1 month, week ±7,
  agenda ±14, day ±1); a one-line "job" caption names each view's purpose. Panel works in every mode via `onSelectOn(date, sel)`.
- **Month** (`MonthView.tsx`, our own CSS grid, no library): overview — per cell the status tint + dot + word (light/normal/busy/
  overloaded, from `summary.status`), the compact `PrioritySummary` chips, multi-day all-day events as bands with open ends where
  they continue (`span` starts/continues/ends), up to two timed titles, "✓ n" for past days. Click → Day. Other months muted.
- **Week** (`WeekView.tsx`, FullCalendar timeGridWeek through the adapter): planning — seven columns; the all-day row is the
  DUE strip (unscheduled items as `k-due` chips, hard ones with ◆), spanning events as bands, constraints hatched, column headers
  (new adapter prop `renderDayHeader`/`dayHeaderContent`) carry the day's status word and compact chips; click a header → Day.
- **Agenda** (`AgendaView.tsx`): chronological list — a block per day (date, status pill, compact chips), lines in time order:
  all-day/spanning first, then timed events and reminders by clock, then due-without-time; today's block shows "carried in" and
  "done"; empty days collapse to one line.
- Compact chips (Month/Week/Agenda) show carried-in overdue only on TODAY, and `DaySummary` counts (hard deadlines, high,
  commitments, due effort) describe the day itself (overdue counts toward today only) — one forgotten task no longer paints the
  whole month. Load thresholds retuned: <0.25 light · <0.45 normal · <0.75 busy · else overloaded (Friday with 4 h booked, 3 due,
  1 h unavailable → busy; §11C 22).
- Router: "submit the report friday, hard deadline" → kind deadline + hardness hard, title clean.
- Dev hook `SECRETARY_VIEW=calendar:<date>,mode:month|week|agenda`. Verified by screenshots on scratch c2: Month with the
  Delhi band Mon–Wed and Friday busy; Week with the due strip, header chips and hatched constraint; Agenda blocks in order.

## Phase 6c — visual grammar and priorities (2026-09-16)
- `calendar/grammar.tsx` is the one vocabulary for every calendar surface: `IMPORTANCE` (0 critical ‼ rose · 1 high ! amber ·
  2 normal • stone · 3 low · muted; each with word, glyph, badge and title weight), `TYPE` (event ▪ solid · commitment 🤝 ·
  work block ▤ lighter · session 📘 · deadline ◆ strong · task ☐ · reminder 🔔 · happening ⏱ dashed · constraint ▨ hatched ·
  waiting ⏳ · note 📝 · thing ◼ · step ☐ · idea ○), `grammarOf(item)` (hard/deadline → deadline), `<TypeGlyph>` (type first,
  importance tone on it), `<Marks>` (both axes as badges: "! high" + "◆ hard", plus "⚠ overdue", "🤝 to Priya", "soft target"),
  `titleClass` (weight by importance), `<PrioritySummary summary priorities compact>` (chips: overdue, critical, hard deadlines,
  promises, high, clashes, hours booked, due, reminders + "first: …" top titles; built from DaySummary so Month cells reuse it),
  `<Legend>`. Never colour alone — every tone has a glyph and a word.
- Calendar surface: the priority summary strip sits under the header before any panel is opened (§11C 8); legend at xl widths.
  DayView rows use `TypeGlyph` + `Marks`; a markers row above the grid shows hard deadlines (◆, clickable) and reminders (🔔 time).
  DayPanel rows use the same glyphs and words. Grid entries take their glyph from `TYPE`.
- Verified by screenshot on scratch c2 Thursday: strip "⚠ 1 overdue · ◆ 1 hard deadline · 🤝 1 promise · ! 5 high · ▪ 3 h booked
  · ☐ 4 due · 🔔 1 · first: …"; "Application due" shows "! high" AND "◆ hard" (two axes); an overdue task shows "⚠ overdue"; the
  markers row shows "◆ Application due · 17:00" and "🔔 14:30 Leave for the meeting". §11C 8 and 9 exercised.

## Phase 6b — day detail panel (2026-09-16)
- `calendar/DayPanel.tsx` opens on the right of the Calendar surface when the date title, a task, an event or a reminder is
  clicked (`calendar/selection.ts`: date | item | event(+occurrence) | reminder | happening). Header: the date and the summary
  counts. Top: the selected thing, editable — item: ✓ Done, ↻ Tomorrow, Cancel, Full editor…, Reschedule (date + optional time
  → `update_item due_at_local|due_date_local`), Importance (critical/high/normal/low → `update_item importance`), add a note
  (`add_note item_id`); event: rename on blur (`update_event title`), Move date/start/end (`update_event`, with
  `occurrence_start_local` for one occurrence of a series), Skip this one / Cancel series… / Cancel event (`delete_event`),
  ✓ Task done for a work block's item, add a note (`add_note event_id` — new target); reminder: ↻ 15 min / 1 h / Tomorrow
  (`snooze_reminder`), Move (`update_reminder fire_at_local`), Cancel alarm (`cancel_reminder`). Then a note on the date itself,
  then the rest of the day as selectable rows (Priorities, Due, Schedule, Reminders, Notes, Completed). Everything goes through
  `quick` → `runTool` → the same tool layer, so each change lands in `activities` and the model sees it.
- `DayView` no longer opens editors itself: every row/grid entry selects for the panel. Dev hook `SECRETARY_VIEW=calendar:<date>,panel:date`.
- Verified by screenshot on scratch c2 (Thursday): panel shows 4 pressing · 3 due · 2 scheduled · 1 reminder · 1 overdue with the
  day's rows; "add a note to the meeting with professor x: bring the slides" attached to the event via the new target.
  §11C 10 exercised; 11 (complete from the panel → gone from Open, still in history) uses the existing complete_item path.

## Phase 6a — third pass: the Calendar surface (2026-09-16)
- **Surfaces (spec §7):** `App.tsx` now has a top navigation — Conversation · Calendar · Things · Settings — and renders ONE
  surface at a time. Conversation is the old three-zone layout (room · conversation · rail). Calendar is
  `calendar/CalendarSurface.tsx`: full width, its own header (‹ today › · long date · status pill · week-start · Month / Week /
  Day / Agenda), body = `DayView` for Day; Month/Week/Agenda are labelled placeholders until 6d. No rail on it, no room. Things
  and Settings are placeholder screens (later phases). Dev hook `SECRETARY_VIEW=calendar[:date]` opens the surface.
  `DayView` no longer owns navigation; it reports its bundle up via `onLoaded` so the header can show the day's status.
- **Bugs fixed this pass:** (1) titles truncated in Due today / Reminders / Priorities → wrap (`break-words`), and the surface is
  wide anyway; (2) importance was never inferred — everything sat at 2. `src/core/importance.ts` `inferImportance` (critical/
  high/low word lists, commitment → high, hard deadline → high, due within a day → high, "someday/maybe/no rush" → low and it
  overrides a model value) runs in `create_item` when the model gave none; a one-off `backfillImportance()` at startup (guarded
  by setting `importance.backfilled`) re-derives open items still at 2; (3) "Priorities 0 while four items overdue": the four
  were due EARLIER TODAY at exact times — the model treated them as merely due today. Now `passedToday` (exact, time passed,
  viewing today) counts as overdue, is excluded from Due today, and lands in Priorities with "was due … at HH:MM".
- **Verified (Test C step 1) on scratch DB c2 by screenshot:** Calendar opens as its own full-width screen with no Overdue /
  Coming Up / Open rail; header carries navigation and the four view controls; Priorities show both overdue items with full titles.
  Importance check: "submit the visa application friday" → 0, "Call Tom …" due today → 1, "someday clean out the garage" → 3.

## Phase 6a — second pass (2026-09-16)
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
