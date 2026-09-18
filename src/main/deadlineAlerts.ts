/**
 * Deadline preparation (spec §8 8b) — approaching-deadline alerts.
 *
 * "Only fires when the evidence is clear, never speculatively": this reuses 7b's own deterministic feasibility
 * verdict verbatim (`assessTarget`/`upcomingDeadlineTargets`, the exact same computation `is X on track?` and
 * `get_forgetting`'s "Deadlines to watch" already use) — no second, looser heuristic invented for this slice. At
 * normal intensity a deadline alerts on the two feasibility values that are genuine arithmetic, not a judgement
 * call: needed time exceeds remaining capacity (`infeasible`), or the ratio is past the tight threshold (`tight`).
 * Under LOW intensity (8d, `notifyPrefs.ts`) the bar rises to `infeasible` only — `tight` is a real signal but a
 * softer, more debatable one, exactly the kind of thing "less pushy" should stop interrupting for. Deliberately
 * narrower than `atRiskLines` (used by get_forgetting) at every intensity: `unknown` (only waits are left — genuine
 * UNCERTAINTY, the opposite of clear evidence) and a bare contradiction with no risky feasibility (already voiced
 * immediately at note time, 7b) are both excluded. `passed` is excluded too, and not just for the same reason: this
 * is an "approaching" alert — by the time a deadline has actually gone by it is not approaching anything, it is
 * simply overdue, which the app already surfaces loudly and repeatedly elsewhere (the rail, the morning briefing's
 * own "Top of mind", recommend_now's +50 overdue weighting, get_forgetting). It is also structurally unreachable
 * here regardless: `upcomingDeadlineTargets` only looks FORWARD from `nowUtc`, so a passed deadline never even
 * enters this sweep's candidate list in the first place — confirmed live rather than assumed (see CLAUDE.md).
 */
import * as repo from './repo'
import { upcomingDeadlineTargets, assessTarget, assessmentText } from './deadlines'
import { showToast } from './notifier'
import { log } from './log'
import { intensityEffects } from './notifyPrefs'

const SETTING_KEY = 'deadline_alerts.alerted_ids'
/** Same horizon as 7b's own "surface it before it is urgent" default (atRiskLines/get_forgetting). */
const HORIZON_DAYS = 14

function loadAlerted(): Set<string> {
  const raw = repo.getSettingValue(SETTING_KEY)
  if (!raw) return new Set()
  try {
    const ids = JSON.parse(raw) as unknown
    return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveAlerted(ids: Set<string>): void {
  repo.setSettingValue(SETTING_KEY, JSON.stringify([...ids]))
}

/**
 * Checked on every scheduler tick and at startup — cheap for the handful of deadlines a personal calendar actually
 * has. Fires ONCE per risk episode: silent every tick while a deadline stays risky (never repeat-pesters about the
 * same thing), and silent again once it clears — but ready to fire again if it becomes risky a second time later
 * (a missed session, a new conflict booked over planned work, time simply passing).
 */
export function sweepDeadlineRisk(nowUtc = new Date().toISOString()): void {
  const effects = intensityEffects()
  // "Less pushy" (8d): under low intensity, only the unarguable verdict (infeasible) counts as clear evidence —
  // tight is a softer, more debatable signal that low intensity chooses not to interrupt for.
  const clearRisk = effects.deadlineAlertOnlyInfeasible ? new Set(['infeasible']) : new Set(['infeasible', 'tight'])
  const alerted = loadAlerted()
  const currentlyRisky = new Set<string>()
  for (const t of upcomingDeadlineTargets(HORIZON_DAYS, nowUtc)) {
    const a = assessTarget(t.id, nowUtc)
    if (!a || !clearRisk.has(a.feasibility)) continue
    currentlyRisky.add(t.id)
    if (alerted.has(t.id)) continue // already told the user about this episode — never repeat-pester
    const verdict = a.feasibility === 'infeasible' ? 'is not feasible as it stands' : 'is tight'
    const projectId = t.kind === 'project' ? t.id : (repo.parentProjectOf(t.id)?.id ?? null)
    showToast({ title: `Deadline at risk: "${t.title}"`, body: assessmentText(a, 'short'), persistent: effects.toastPersistent })
    repo.insertActivity({
      targetType: 'item',
      targetId: t.id,
      projectId,
      verb: 'deadline_alert',
      actor: 'system',
      summary: `Deadline alert: "${t.title}" ${verdict}`,
      reversible: false
    })
    log('info', 'deadline.alert', `"${t.title}" — ${a.feasibility}`, t.id)
  }
  // Anything no longer risky drops out, so a later re-risk fires fresh instead of staying silenced forever.
  for (const id of alerted) if (!currentlyRisky.has(id)) alerted.delete(id)
  for (const id of currentlyRisky) alerted.add(id)
  saveAlerted(alerted)
}

/** For tests and diagnostics — which deadlines are in an already-alerted episode right now. */
export function currentlyAlertedIds(): string[] {
  return [...loadAlerted()]
}
