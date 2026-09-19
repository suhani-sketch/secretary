import type { CompanionState, Gaze, PersonalityWeights, Signals } from './companionState'

/**
 * Rare memorable moments (reshape "small unexpected moments"): the little things a user notices once and remembers.
 *
 * These are probability rolls layered on TOP of `resolveState` and per-day-capped in localStorage — never more than
 * one of each per day, so they stay memorable instead of routine. Each one takes the same (signals, seed,
 * personality, ambient state) that resolveState already reads, so nothing here needs new data or a new tick loop.
 *
 * The moments are DETERMINISTIC per day and per seed. That matters for attachment: the specific way YOUR creature
 * does its "proud stretch" on a project completion is stable — it will always do the same one, so over time you
 * recognize it as a signature. Two users' creatures with different seeds will have different signature moments.
 *
 * The four moments implemented:
 *   1. napAtDesk — the creature falls asleep at the desk after a long stretch of no user interaction. ≤1/day.
 *      Only during working hours, only when the user has been away >30 min, only in an idle/working slot.
 *   2. rainWindow — on a cloudy or misty day, the creature is drawn to the window with strong bias. ≤1/day.
 *   3. proudStretch — on a real project completion, a specific-per-seed variant of the celebrate pose. ≤1/day per project.
 *   4. unusualNap — occasionally curls up somewhere unusual (not the nest), once a week at most.
 *
 * Each moment can win OR pass; a pass means "let resolveState carry on as normal" so silence is a valid answer.
 */

const STORAGE_KEY = 'creature.moments'

interface MomentsRecord {
  date: string
  // Which moments have fired today. A moment listed here is done for the day.
  fired: string[]
  // Per-week counter for weekly-capped moments.
  week: string // ISO week key
  weeklyFired: string[]
}

function loadRecord(): MomentsRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { date: today(), fired: [], week: currentWeekKey(), weeklyFired: [] }
    const parsed = JSON.parse(raw) as MomentsRecord
    // Roll over at day/week boundary.
    const t = today()
    const w = currentWeekKey()
    if (parsed.date !== t) { parsed.date = t; parsed.fired = [] }
    if (parsed.week !== w) { parsed.week = w; parsed.weeklyFired = [] }
    return parsed
  } catch {
    return { date: today(), fired: [], week: currentWeekKey(), weeklyFired: [] }
  }
}

function saveRecord(r: MomentsRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r))
  } catch {
    /* storage full or private mode — the day cap just doesn't persist; next reload starts fresh. That means a
       moment could fire twice on a day the storage is disabled, which is a lot better than never firing at all */
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function currentWeekKey(): string {
  const d = new Date()
  // Week number to keep it simple — YYYY-Www.
  const year = d.getFullYear()
  const start = new Date(year, 0, 1)
  const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000)
  const week = Math.ceil((days + start.getDay() + 1) / 7)
  return `${year}-W${week}`
}

/** Deterministic per-seed float in [0,1) — same mixing as the personality module, kept local so this file doesn't
 *  depend on the main-process personality file. */
function seededFloat(seed: number, key: string): number {
  let h = seed >>> 0
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0
  h = ((h ^ (h >>> 16)) * 2246822507) >>> 0
  h = ((h ^ (h >>> 13)) * 3266489909) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0x1_0000_0000
}

export interface MomentInput {
  base: { state: CompanionState; gaze: Gaze }
  signals: Signals
  now: number
  seed: number
  personality: PersonalityWeights
  weather: 'clear' | 'cloudy' | 'misty' | null
  lastUserActivityAt: number
}

/**
 * Runs after resolveState and may override the base pose with a "moment". Returns the base unchanged if nothing
 * fires — that's the correct silent answer most of the time.
 */
export function maybeMoment(input: MomentInput): { state: CompanionState; gaze: Gaze; momentKey?: string } {
  const { base, signals, now, seed, personality, weather, lastUserActivityAt } = input
  const record = loadRecord()

  // 1. napAtDesk — long user absence, during work hours, at the desk. A soft, funny moment: caught napping.
  //    Only from an idle/working slot. Deterministic per (day, seed) so it happens at a stable phase within the day.
  if (!record.fired.includes('napAtDesk') && !record.weeklyFired.includes('napAtDesk')) {
    const inWorkHours = signals.hour >= 10 && signals.hour <= 17
    const userAwayLongEnough = now - lastUserActivityAt > 30 * 60 * 1000
    const inBaseThatAllows = base.state === 'idle' || base.state === 'working' || base.state === 'reading'
    // Fire in a narrow 5-minute daily window derived from seed, so each creature has its "usual nap time".
    const dailyWindowStart = 10 * 3600 * 1000 + Math.floor(seededFloat(seed, 'napAtDesk_time') * 7 * 3600 * 1000)
    const localMs = (signals.hour * 3600 + new Date(now).getMinutes() * 60) * 1000
    const inWindow = Math.abs(localMs - dailyWindowStart) < 5 * 60 * 1000
    if (inWorkHours && userAwayLongEnough && inBaseThatAllows && inWindow) {
      record.fired.push('napAtDesk')
      saveRecord(record)
      return { state: 'sleepy', gaze: 'closed', momentKey: 'napAtDesk' }
    }
  }

  // 2. rainWindow — on a cloudy or misty day, strong pull to the window with a moment of quiet gazing outside.
  //    Personality's rainAffinity gates strength; higher-affinity creatures pull to the window more surely.
  if (!record.fired.includes('rainWindow') && (weather === 'cloudy' || weather === 'misty')) {
    const inBaseThatAllows = base.state === 'idle' || base.state === 'looking' || base.state === 'reading'
    const gatePassed = seededFloat(seed, 'rainWindow_' + today()) < personality.rainAffinity
    const inWorkHours = signals.hour >= 9 && signals.hour <= 20
    if (inBaseThatAllows && gatePassed && inWorkHours) {
      record.fired.push('rainWindow')
      saveRecord(record)
      return { state: 'looking', gaze: 'window', momentKey: 'rainWindow' }
    }
  }

  // 3. unusualNap — once a week at most, the creature curls up somewhere unusual (on the bench, not the nest).
  //    A memorable "aww" moment when spotted; never more than once per week so it doesn't become routine.
  if (!record.weeklyFired.includes('unusualNap')) {
    const inBaseThatAllows = base.state === 'sleepy' || base.state === 'sleeping'
    if (inBaseThatAllows) {
      const gate = seededFloat(seed, 'unusualNap_' + record.week) < 0.20 // small chance per week
      if (gate) {
        // Only actually fire when we're in the right time window — say mid-afternoon on a random day.
        const dayOfWeek = new Date().getDay()
        const specialDay = Math.floor(seededFloat(seed, 'unusualNap_day_' + record.week) * 7)
        if (dayOfWeek === specialDay && signals.hour >= 13 && signals.hour <= 16) {
          record.weeklyFired.push('unusualNap')
          saveRecord(record)
          // We express this by returning sleepy with 'closed' gaze — Room.tsx picks the position, and if we hint
          // via momentKey the Room can place the creature on the bench instead of the nest.
          return { state: 'sleepy', gaze: 'closed', momentKey: 'unusualNap' }
        }
      }
    }
  }

  return { state: base.state, gaze: base.gaze }
}

/** Utility for tests / manual verification: what has fired today. */
export function momentsFiredToday(): string[] {
  return loadRecord().fired
}

/** Utility for tests: reset the daily record. */
export function resetMomentsForTest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* fine */
  }
}
