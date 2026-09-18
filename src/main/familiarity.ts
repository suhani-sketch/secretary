/**
 * Familiarity through real memory (spec §8 Phase 9f). A small, sparse aside — never a new fact, only ever a
 * reflection of what the activity history and item record ALREADY say — prepended to a reply when the user returns
 * to a Thing the app can genuinely show a multi-session pattern for. "The creature never pretends to remember
 * something it does not actually have": every line here is computed from `activities`/`items`, nothing is
 * invented, and nothing fires for a Thing touched for the first time, or only once or twice — "Back to the
 * application?" only if it genuinely is.
 */
import { DateTime } from 'luxon'
import * as repo from './repo'

export type FamiliarityKind = 'struggled' | 'achievement' | 'recurring' | 'long_running'

const RESCHEDULE_STRUGGLE_MIN = 3
const RECURRING_DAYS_MIN = 4
const LONG_RUNNING_DAYS_MIN = 21
const ACHIEVEMENT_AGE_DAYS_MIN = 7

/**
 * The one honest observation for this item/project, or null — most Things have none, and that is the common,
 * correct case. Checked in order of how much it would actually mean to hear: a genuine struggle first (moved
 * often enough that it is a pattern, not one ordinary reschedule), then a finished thing being brought up again,
 * then a Thing returned to across enough distinct days to be a real pattern, then simply having sat open a while.
 */
export function familiarityNote(itemId: string): { kind: FamiliarityKind; line: string } | null {
  const it = repo.getItem(itemId)
  if (!it) return null
  const history = it.kind === 'project' ? repo.activitiesForProject(itemId, 200) : repo.activitiesFor('item', itemId, 100)
  if (!history.length) return null

  const reschedules = history.filter((a) => a.verb === 'rescheduled').length
  if (reschedules >= RESCHEDULE_STRUGGLE_MIN) return { kind: 'struggled', line: `"${it.title}" again — this one has had a few goes.` }

  if (it.status === 'done') {
    const completedAt = [...history].reverse().find((a) => a.verb === 'completed' || a.verb === 'status_changed')?.created_at
    if (completedAt && DateTime.utc().diff(DateTime.fromISO(completedAt), 'days').days >= ACHIEVEMENT_AGE_DAYS_MIN) {
      return { kind: 'achievement', line: `"${it.title}" — you already finished that one.` }
    }
    return null // done, but too recent to be a callback — 9e's reactive lines cover a fresh completion
  }

  const days = new Set(history.map((a) => a.created_at.slice(0, 10)))
  if (days.size >= RECURRING_DAYS_MIN) return { kind: 'recurring', line: `Back to "${it.title}"?` }

  const createdDaysAgo = DateTime.utc().diff(DateTime.fromISO(it.created_at), 'days').days
  if (it.status === 'open' && createdDaysAgo >= LONG_RUNNING_DAYS_MIN) return { kind: 'long_running', line: `"${it.title}" has been on the list a while now.` }

  return null
}
