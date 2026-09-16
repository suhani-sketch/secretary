import type { Metaphor } from '../shared/happenings'

/**
 * Recognising living activities in plain speech (spec §8 Phase 5). Deterministic, no model.
 *
 * Four things must stay apart: "I need to do laundry tomorrow" (task), "I've started the washing machine" (happening),
 * "remind me to move the laundry in 45 minutes" (reminder), "laundry's done" (happening resolved). This module only ever
 * recognises the two happening forms; tasks and reminders are handled elsewhere and never come through here.
 *
 * A recognised start carries a label in the user's words, a kind (for micro-rituals and the room), a metaphor where a
 * natural one exists (else null → plain timer), and the stated duration if any. Nothing here has a default duration:
 * the user either said how long, or the happening is open-ended. Offering a timer is the micro-ritual layer's job.
 */

export type HappeningKind =
  | 'egg'
  | 'tea'
  | 'cooking'
  | 'laundry'
  | 'charging'
  | 'process'
  | 'shower'
  | 'getting_ready'
  | 'leaving'
  | 'break'
  | 'focus'
  | 'reading'
  | 'timer'

export interface HappeningStart {
  label: string
  kind: HappeningKind
  metaphor: Metaphor | null
  minutes: number | null
}

/** "8 minutes", "an hour", "half an hour", "1h20", "90 sec". Returns whole minutes (seconds rounded up). */
export function parseDurationMinutes(text: string): number | null {
  const t = text.toLowerCase()
  if (/\b(?:half an hour|half hour|30 mins?)\b/.test(t)) return 30
  if (/\b(?:quarter of an hour|quarter hour)\b/.test(t)) return 15
  if (/\ban hour and a half\b/.test(t)) return 90
  if (/\ban hour\b/.test(t) && !/\d/.test(t)) return 60
  let m = /(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*(?:m|min|mins|minutes)?\b/.exec(t)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  m = /(\d+(?:\.\d+)?)\s*(?:-\s*)?(hours?|hrs?|h)\b/.exec(t)
  if (m) return Math.round(Number(m[1]) * 60)
  m = /(\d+(?:\.\d+)?)\s*(?:-\s*)?(minutes?|mins?|m)\b/.exec(t)
  if (m) return Math.max(1, Math.round(Number(m[1])))
  m = /(\d+)\s*(?:seconds?|secs?|s)\b/.exec(t)
  if (m) return Math.max(1, Math.ceil(Number(m[1]) / 60))
  return null
}

/** Strip a trailing duration clause ("for 8 minutes", "8 min", "for an hour") off a label. */
function stripDuration(label: string): string {
  return label
    .replace(/\s*(?:for|in)\s+(?:about\s+|around\s+|roughly\s+)?(?:\d+(?:\.\d+)?\s*(?:-\s*)?(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s*\d+\s*(?:m|min|mins|minutes)?)?|an hour(?: and a half)?|half an hour|half hour|quarter of an hour)\b.*$/i, '')
    .replace(/\s*\b\d+(?:\.\d+)?\s*(?:-\s*)?(?:hours?|hrs?|h|minutes?|mins?|m)\b\s*$/i, '')
    .trim()
}

const COOKING_OBJECT = /\b(egg|eggs|rice|pasta|noodles|potatoes|dal|daal|lentils|beans|soup|stew|curry|sauce|chicken|fish|bread|cake|cookies|biscuits|dough|veg|vegetables|oats|porridge|milk|water|kettle|pot|pan|oven|dinner|lunch|breakfast|food)\b/
const DRINK = /\b(tea|chai|coffee|matcha|green tea|herbal tea|infusion)\b/
const LAUNDRY = /\b(washing machine|washer|laundry|dryer|tumble dryer|a wash|the wash|the washing|dishwasher|clothes)\b/
const CHARGE = /\b(charg(?:e|ing)|phone|laptop|battery|earbuds|headphones)\b/
const PROCESS = /\b(download(?:ing)?|upload(?:ing)?|update|updating|install(?:ing)?|render(?:ing)?|export(?:ing)?|build(?:ing)?|backup|backing up|sync(?:ing)?|transfer(?:ring)?|compil(?:e|ing)|convert(?:ing)?|scan(?:ning)?|print(?:ing)?)\b/
const SLOW = /\b(soak(?:ing)?|defrost(?:ing)?|thaw(?:ing)?|marinat(?:e|ing)|proof(?:ing)?|prov(?:e|ing)|rising|ferment(?:ing)?|chill(?:ing)?|cooling|setting)\b/
const FOCUS = /\b(focus(?: session| block| time)?|pomodoro|deep work|work session|writing session|study session|studying|working on|sprint)\b/
const READING = /\b(reading session|reading)\b/
const PERSONAL_SHOWER = /\b(shower(?:ing)?|bath|bathing)\b/
const PERSONAL_READY = /\b(getting ready|get ready|getting dressed)\b/
const PERSONAL_LEAVE = /\b(leaving|heading out|going out|on my way|stepping out)\b/
const PERSONAL_BREAK = /\b(break|nap|rest|walk|stretch|lie down|breather)\b/

function classify(label: string, verbHint: string): { kind: HappeningKind; metaphor: Metaphor | null } {
  const t = `${verbHint} ${label}`.toLowerCase()
  if (/\beggs?\b/.test(t)) return { kind: 'egg', metaphor: 'egg' }
  if (DRINK.test(t) && !/\bcoffee machine\b/.test(t)) return { kind: 'tea', metaphor: 'tea' }
  if (LAUNDRY.test(t)) return { kind: 'laundry', metaphor: 'laundry' }
  if (SLOW.test(t)) return { kind: 'cooking', metaphor: 'plant' }
  if (CHARGE.test(t)) return { kind: 'charging', metaphor: 'download' }
  if (PROCESS.test(t)) return { kind: 'process', metaphor: 'download' }
  if (FOCUS.test(t)) return { kind: 'focus', metaphor: 'focus' }
  if (READING.test(t)) return { kind: 'reading', metaphor: null }
  if (PERSONAL_SHOWER.test(t)) return { kind: 'shower', metaphor: null }
  if (PERSONAL_READY.test(t)) return { kind: 'getting_ready', metaphor: null }
  if (PERSONAL_LEAVE.test(t)) return { kind: 'leaving', metaphor: null }
  if (PERSONAL_BREAK.test(t)) return { kind: 'break', metaphor: null }
  if (COOKING_OBJECT.test(t) || /\b(cook|cooking|boil|boiling|bak|baking|roast|roasting|simmer|fry|frying|steam|steaming|oven|stove|hob)/.test(t)) return { kind: 'cooking', metaphor: null }
  return { kind: 'timer', metaphor: null }
}

/** Kind and natural metaphor for a bare label ("egg", "washing machine", "tea") — used when the model supplies the label. */
export function kindForLabel(label: string): { kind: HappeningKind; metaphor: Metaphor | null } {
  return classify(label, '')
}

const tidy = (s: string): string =>
  s
    .replace(/^(?:the|a|an|some|my|our)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Does this message announce the START of a happening? Returns null when it does not, or when it reads as a task
 * ("I need to…", "tomorrow", "remind me") — those must stay tasks and reminders.
 */
export function detectHappeningStart(rawText: string): HappeningStart | null {
  const text = rawText.trim().toLowerCase().replace(/[.!…]+$/g, '').replace(/\s+/g, ' ')
  if (!text || text.length > 140) return null
  // Obligations and alarms are never happenings.
  if (/\b(need to|have to|must|should|gotta|got to|remind me|reminder|tomorrow|next week|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|later today|tonight i(?:'ll| will))\b/.test(text)) return null
  if (/\b(i'?ll|i will|going to|gonna|plan to|planning to)\b/.test(text) && !/\b(i'm|i am|i've|i have)\b.*\b(now|just)\b/.test(text)) {
    // Future intent is a task unless it is an immediate personal one ("I'm going to take a shower").
    if (!/^(?:i'm|i am) (?:going to|gonna|off to) (?:take |have |grab )?(?:a )?(?:quick )?(?:shower|bath|nap|break|walk|lie down)/.test(text)) return null
  }

  const minutes = parseDurationMinutes(text)
  let m: RegExpExecArray | null

  // "I've put an egg on (for 8 minutes)" / "put the rice on" / "I've got eggs on"
  if ((m = /^(?:ok(?:ay)?,? )?(?:i(?:'ve| have| just|'ve just)? )?(?:just )?(?:put|got|have|set|stuck) (.+?) (?:on|going|in the oven|in the pan|on the hob|on the stove|on to boil|to boil|boiling|cooking)(?:\s.*)?$/.exec(text)) && !/\b(list|note|calendar|hold|pause)\b/.test(m[1])) {
    const label = tidy(stripDuration(m[1]))
    if (label && label.length <= 60) {
      const c = classify(label, 'cooking')
      return { label: /in the oven/.test(text) ? `${label} in the oven` : label, kind: c.kind === 'timer' ? 'cooking' : c.kind, metaphor: c.metaphor, minutes }
    }
  }
  // "I've started the washing machine" / "started a wash" / "the dryer's on" / "turned on the dishwasher"
  if ((m = /^(?:i(?:'ve| have| just|'ve just)? )?(?:just )?(?:started|turned on|switched on|put on|loaded|run|running|set off) (.+)$/.exec(text)) && LAUNDRY.test(m[1])) {
    return { label: tidy(stripDuration(m[1])), kind: 'laundry', metaphor: 'laundry', minutes }
  }
  if ((m = /^(?:the )?(washing machine|washer|dryer|dishwasher|laundry)(?:'s| is) (?:on|going|running)(?:\s.*)?$/.exec(text))) {
    return { label: m[1], kind: 'laundry', metaphor: 'laundry', minutes }
  }
  // "I'm making tea" / "making a coffee" / "brewing chai" / "steeping tea for 4 minutes"
  if ((m = /^(?:i'm |i am |just )?(?:making|brewing|steeping|having|pouring) (.+)$/.exec(text)) && DRINK.test(m[1])) {
    return { label: tidy(stripDuration(m[1])), kind: 'tea', metaphor: 'tea', minutes }
  }
  // Cooking verbs: "I'm baking bread for 40 minutes" / "soaking the dal" / "defrosting chicken" / "boiling pasta"
  if ((m = /^(?:i'm |i am |i've |i have |just |i've just |i'm just )?(?:started )?(baking|roasting|boiling|simmering|frying|steaming|cooking|soaking|steeping|defrosting|thawing|marinating|proofing|proving|chilling|reheating|warming up|toasting|grilling) (.+)$/.exec(text))) {
    const verb = m[1]
    const label = tidy(stripDuration(m[2]))
    if (label.length <= 60) {
      const c = classify(label, verb)
      const kind: HappeningKind = c.kind === 'timer' ? 'cooking' : c.kind
      return { label: `${verb} ${label}`, kind, metaphor: c.metaphor, minutes }
    }
  }
  // Charging / a process: "charging my phone" / "downloading the update" / "the export is running" / "waiting on a download"
  if ((m = /^(?:i'm |i am |i've |i have |just |i've just |i'm just )?(?:started |put |waiting (?:on|for) )?(?:the |a |my )?(.+?)(?:'s| is| are)? (?:charging|downloading|uploading|updating|installing|rendering|exporting|building|syncing|running|backing up|printing|scanning|converting|compiling|transferring)(?:\s.*)?$/.exec(text)) && (CHARGE.test(text) || PROCESS.test(text))) {
    const label = tidy(stripDuration(m[1]))
    const c = classify(text, '')
    return { label: label.length <= 60 && label ? `${label} ${/charg/.test(text) ? 'charging' : (/(downloading|uploading|updating|installing|rendering|exporting|building|syncing|backing up|printing|scanning|converting|compiling|transferring)/.exec(text)?.[1] ?? 'running')}` : text, kind: c.kind, metaphor: 'download', minutes }
  }
  if ((m = /^(?:i'm |i am |just |i've |i have )?(?:started )?(charging|downloading|uploading|updating|installing|rendering|exporting|building|syncing|backing up|printing|scanning|converting|transferring) (.+)$/.exec(text))) {
    return { label: `${m[1]} ${tidy(stripDuration(m[2]))}`, kind: /charg/.test(m[1]) ? 'charging' : 'process', metaphor: 'download', minutes }
  }
  // Focus / work session: "starting a 25 minute focus session" / "focus session for 45 min" / "deep work for an hour" / "pomodoro"
  if ((m = /^(?:ok(?:ay)?,? )?(?:i'm |i am |just |let'?s |right,? )?(?:starting|start|beginning|begin|doing|going into|in) (?:a |an |my )?(.+)$/.exec(text)) && (FOCUS.test(m[1]) || READING.test(m[1]))) {
    const c = classify(m[1], '')
    const label = tidy(stripDuration(m[1]).replace(/^\d+[- ]?(?:min(?:ute)?s?|hour)\s+/, ''))
    return { label, kind: c.kind, metaphor: c.metaphor, minutes }
  }
  if ((m = /^(focus(?: session| block| time)?|pomodoro|deep work|work session|writing session|study session|reading session)(?: (?:for|of) .+| \d+.*)?$/.exec(text))) {
    return { label: m[1], kind: READING.test(m[1]) ? 'reading' : 'focus', metaphor: READING.test(m[1]) ? null : 'focus', minutes }
  }
  // Personal: "I'm showering" / "taking a shower" / "getting ready" / "leaving now" / "taking a 10 minute break" / "having a nap"
  if ((m = /^(?:ok(?:ay)?,? )?(?:i'm |i am |just |i'm just |i'm going to |i am going to |gonna |i'm gonna |off to |going to )?(?:take |have |having |taking |grab |grabbing |go for |going for )?(?:a |an )?(?:quick |short |little |small )?(shower(?:ing)?|bath|nap|break|breather|walk|stretch|lie down|rest)(?: now| for .+| \d+.*)?$/.exec(text))) {
    const word = m[1]
    const label = /shower/.test(word) ? 'shower' : word === 'lie down' ? 'lying down' : word
    return { label, kind: /shower|bath/.test(word) ? 'shower' : 'break', metaphor: null, minutes }
  }
  if (/^(?:i'm |i am )(?:in the shower|showering|getting ready|getting dressed|heading out|leaving|leaving now|going out|on my way|stepping out|out for a bit)(?: now)?$/.test(text)) {
    const kind: HappeningKind = /shower/.test(text) ? 'shower' : /ready|dressed/.test(text) ? 'getting_ready' : 'leaving'
    return { label: kind === 'shower' ? 'shower' : kind === 'getting_ready' ? 'getting ready' : 'out', kind, metaphor: null, minutes }
  }
  // Plain timer: "set a 10 minute timer (for the rice)" / "timer for 20 minutes" / "10 minutes for the pasta"
  if ((m = /^(?:set |start |put on |can you set |give me )?(?:a |an )?(?:(?:\d+(?:\.\d+)?|an?)\s*(?:-\s*)?(?:hour|hr|h|minutes?|mins?|m|seconds?|secs?|s)\s*)?timer(?: (?:for|on) (.+?))?(?: for .+)?$/.exec(text)) || (m = /^timer(?:,)? (\d+ ?(?:minutes?|mins?|m|hours?|h))(?: for (.+))?$/.exec(text))) {
    if (minutes) {
      const tail = tidy(stripDuration(m[1] ?? m[2] ?? ''))
      const c = tail ? classify(tail, '') : { kind: 'timer' as HappeningKind, metaphor: null }
      return { label: tail || 'timer', kind: c.kind === 'timer' && tail ? 'cooking' : c.kind, metaphor: c.metaphor, minutes }
    }
  }
  return null
}

/**
 * Does this message END a happening? Returns the label fragment to match against running happenings, and whether it was
 * finished ("done", "ready", "out") or abandoned ("never mind", "cancel", "forget"). Matching to a specific running
 * happening is the router's job (it can see the table); this only reads the sentence.
 */
export function detectHappeningEnd(rawText: string): { fragment: string | null; outcome: 'done' | 'abandoned' } | null {
  const text = rawText.trim().toLowerCase().replace(/[.!…]+$/g, '').replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  if ((m = /^(?:ok(?:ay)?,? )?(?:the |my )?(.+?)(?:'s| is| are|s are| has| have) (?:done|ready|finished|out|over|cooked|boiled|charged|downloaded|complete|completed|dry|washed)(?: now)?$/.exec(text))) return { fragment: m[1], outcome: 'done' }
  if ((m = /^(?:ok(?:ay)?,? )?(?:i'?m |i am )?(?:done|finished|back|out) (?:with |from )?(?:the |my )?(?:shower|bath|break|nap|walk|focus(?: session)?|pomodoro|session|reading|lunch|dinner|(.+))$/.exec(text))) return { fragment: m[1] ?? text.replace(/^(?:ok(?:ay)?,? )?(?:i'?m |i am )?(?:done|finished|back|out) (?:with |from )?(?:the |my )?/, ''), outcome: 'done' }
  if (/^(?:i'?m |i am )?(?:back|out of the shower|done showering|dressed|ready|off the phone)(?: now)?$/.test(text)) return { fragment: null, outcome: 'done' }
  if ((m = /^(?:ok(?:ay)?,? )?(?:never ?mind|forget|cancel|scrap|stop|kill|drop|abandon|ditch) (?:about )?(?:the |that |my )?(.+?)(?: timer| happening)?$/.exec(text))) return { fragment: m[1], outcome: 'abandoned' }
  if ((m = /^(?:took|taken|pulled|got) (?:the |my )?(.+?) (?:off|out)(?: of the .+)?(?: now)?$/.exec(text))) return { fragment: m[1], outcome: 'done' }
  if ((m = /^(?:ate|drank|eating|drinking) (?:the |my )?(.+)$/.exec(text))) return { fragment: m[1], outcome: 'done' }
  return null
}
