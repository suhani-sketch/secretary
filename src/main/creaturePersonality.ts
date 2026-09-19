import * as repo from './repo'
import { log } from './log'

/**
 * Character-seed layer (the reshape: "attachment through consistency + personalization + persistence").
 *
 * On the very first launch, the creature is given a 32-bit seed — random, once, stored forever in
 * `settings['creature.seed']`. From that seed we derive a small personality vector: how much this particular
 * creature reads, how often it goes to the window, whether it likes rain, its resting-spot preference, its
 * expressiveness, its curiosity. The vector is not stored — it's re-derived every time from the seed, so it stays
 * pixel-stable across restarts and there is only one source of truth.
 *
 * The user never sees the vector. They discover, over days: "mine always goes to the window when it's raining."
 * That is the point.
 *
 * On top of the seed sits a small habit-drift accumulator — `settings['creature.drift.<key>']` — which slowly
 * shifts the effective vector toward the user's real habits (morning-active user → morning-active creature). Each
 * key is a plain integer count of a specific signal (mornings-active, project-completions-in-armchair-env, …),
 * incremented on real events, never on ticks. When the vector is read for use in the renderer, drift blends in at
 * a bounded rate so no single day can flip the character.
 *
 * The vector is exposed to the renderer via three narrow settings keys (all readable, none writable through the UI
 * IPC) so the state machine can weight its ambient rotation without a new IPC channel or a new database table.
 */

const SEED_KEY = 'creature.seed'
const SEED_CREATED_KEY = 'creature.seed_created_at'
/** Every drift key is namespaced with this prefix so we can list/clear the whole set easily and never collide with
 *  another feature's settings. Kept plain strings so the same pattern works from either process. */
const DRIFT_PREFIX = 'creature.drift.'

export interface PersonalityVector {
  /** 0-1: how often the ambient rotation picks reading. Higher = "this one loves books." */
  readingLove: number
  /** 0-1: how often the ambient rotation picks looking out the window. */
  windowLove: number
  /** 0-1: bias toward the window on cloudy/misty days and rainy environments. */
  rainAffinity: number
  /** Minutes offset (-90…+90) shifting the night/dawn edges — one creature sleeps earlier, another stays up. */
  sleepOffsetMinutes: number
  /** Preferred resting-spot when idle: 'nest' | 'armchair' | 'bench' | 'rug'. */
  restingSpot: 'nest' | 'armchair' | 'bench' | 'rug'
  /** 0-1: how big/wide the micro-motions read. Some creatures are quiet, some more expressive. */
  expressiveness: number
  /** 0-1: probability boost for looking-at-viewer when a new item/project appears. */
  curiosity: number
}

/** Deterministic per-seed helper — mix seed with a fixed key and take a float in [0,1). */
function mixed(seed: number, key: string): number {
  let h = seed >>> 0
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0
  // Second pass to spread bits so nearby keys don't correlate.
  h = ((h ^ (h >>> 16)) * 2246822507) >>> 0
  h = ((h ^ (h >>> 13)) * 3266489909) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0x1_0000_0000
}

/**
 * Compute the vector from a seed. Ranges are deliberately narrow — a creature that reads 40% of the time and one
 * that reads 15% both still feel like the same product, but they don't feel like the same creature.
 */
export function vectorFor(seed: number): PersonalityVector {
  const restingWeights: ('nest' | 'armchair' | 'bench' | 'rug')[] = ['nest', 'armchair', 'bench', 'rug']
  const restingIndex = Math.floor(mixed(seed, 'resting_spot') * restingWeights.length) % restingWeights.length
  return {
    readingLove: 0.15 + mixed(seed, 'reading_love') * 0.25, // 0.15 - 0.40
    windowLove: 0.10 + mixed(seed, 'window_love') * 0.20, //   0.10 - 0.30
    rainAffinity: 0.20 + mixed(seed, 'rain_affinity') * 0.40, // 0.20 - 0.60
    sleepOffsetMinutes: Math.round((mixed(seed, 'sleep_offset') - 0.5) * 180), // -90 .. +90
    restingSpot: restingWeights[restingIndex],
    expressiveness: 0.35 + mixed(seed, 'expressiveness') * 0.4, // 0.35 - 0.75
    curiosity: 0.20 + mixed(seed, 'curiosity') * 0.4 //          0.20 - 0.60
  }
}

/** Read the persisted seed. On the very first call ever, generate one and remember it forever. */
export function getOrCreateSeed(): number {
  const existing = repo.getSettingValue(SEED_KEY)
  if (existing) {
    const n = parseInt(existing, 10)
    if (Number.isFinite(n)) return n >>> 0
  }
  // A real random seed for a real personal creature — this line runs once in the app's whole lifetime for this user.
  const generated = Math.floor(Math.random() * 0x1_0000_0000) >>> 0
  repo.setSettingValue(SEED_KEY, String(generated))
  repo.setSettingValue(SEED_CREATED_KEY, new Date().toISOString())
  log('info', 'creature.seeded', `${generated}`)
  return generated
}

/** Bump a drift key by 1. Called on real signals only (a completion in a certain environment, an app-open at a
 *  certain hour) — never on ticks, never on synthetic events. Kept as a plain settings integer for simplicity. */
export function bumpDrift(key: string): void {
  const setting = DRIFT_PREFIX + key
  const cur = parseInt(repo.getSettingValue(setting) ?? '0', 10) || 0
  repo.setSettingValue(setting, String(cur + 1))
}

export function readDrift(key: string): number {
  return parseInt(repo.getSettingValue(DRIFT_PREFIX + key) ?? '0', 10) || 0
}

/**
 * The vector as the renderer should read it: seed-derived, gently biased by drift. Drift never flips the
 * character — it only nudges. A creature with `restingSpot: 'nest'` won't wake up preferring the armchair
 * overnight because you completed one project there; it takes real repetition.
 */
export function effectiveVector(): PersonalityVector {
  const seed = getOrCreateSeed()
  const base = vectorFor(seed)
  const morningActivity = readDrift('morning_active')
  const armchairCompletions = readDrift('completed_in_armchair')
  // Cap drift's effect: past a couple of dozen signals it saturates. The floor is 0.
  const morningWeight = Math.min(0.1, morningActivity * 0.005)
  const armchairWeight = Math.min(0.15, armchairCompletions * 0.02)
  return {
    ...base,
    // A morning-active user shifts sleep earlier (so the creature is awake earlier alongside them).
    sleepOffsetMinutes: base.sleepOffsetMinutes - Math.round(morningWeight * 60),
    // Enough completions in an armchair-environment nudge the resting spot toward the armchair, without ever
    // overriding the seed pick outright — a creature born to sleep in the nest stays a nest-sleeper.
    readingLove: Math.min(0.5, base.readingLove + armchairWeight)
  }
}
