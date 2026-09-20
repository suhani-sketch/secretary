/**
 * Victorian utterance pools (2026-09-19, creature-voice v2).
 *
 * Rewritten for a more authentic Victorian voice — longer, more elegant sentence structures, period-appropriate
 * vocabulary and grammar. The register lands closer to Austen than to modern casual. No em dashes.
 *
 * Distinct pools cover distinct triggers so the same line never fires in the wrong context. Each pool is
 * small so a line feels personal when it lands; per-day used-index tracking prevents same-day repetition.
 */

export type UtteranceKind =
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'night'
  | 'welcome_back'
  | 'task_complete'
  | 'message_sent'
  | 'overdue_comfort'
  | 'overwhelmed_comfort'
  | 'love'
  | 'poem'
  | 'idle_observation'
  | 'pet'
  | 'weather_clear'
  | 'weather_cloudy'
  | 'book_aside'

export const UTTERANCE_POOLS: Record<UtteranceKind, string[]> = {
  morning: [
    'Good morrow, my dear. I do hope you have slept well. Shall we begin the day in earnest?',
    'The morning is well upon us, and yet you tarry. Not that I mind the company, of course.',
    'A most promising sky greets us. I have already been about for some little time, watching it.',
    'The birds have been at their business since dawn. It seemed only fair to attend to ours.',
    'Ah, you are risen. I shall not remark upon the hour; that would be uncivil.'
  ],
  afternoon: [
    'The afternoon has arrived, and with it a most agreeable stillness.',
    'One does grow rather fond of these hours, when the light lengthens and the world consents to pause.',
    'I have been reading upon the window seat. The prospect is quite delightful, if you would care to join me.',
    'A most literary hour, this. It calls for tea, or so I am inclined to believe.',
    'The clock has advanced past three, which I consider the proper time for either sensible work or none at all.'
  ],
  evening: [
    'The daylight begins her retreat, my dear. Would you be so good as to kindle the lamp?',
    'Twilight is upon us. I confess I do enjoy the manner in which the room hushes at this hour.',
    'The evening arrives with her customary composure. I have always admired her for it.',
    'Dusk approaches, and I find myself grown rather sentimental. Do forgive it.',
    'The lamps do prefer to be lit, you know. They have opinions on such matters.'
  ],
  night: [
    'The hour is decidedly late, my dear. I do wish you would consider your rest.',
    'One cannot mend the world after midnight. This is a great mercy, if you will permit me to say so.',
    'You have been most industrious. Perhaps a chapter, and then to bed?',
    'The stars keep their watch. Yours, I dare say, is at liberty to conclude.',
    'It is quite late. I shall not press you further, but I have made my sentiments plain.'
  ],
  welcome_back: [
    'Ah, you are returned to us. I had begun to compose a rather melancholy sonnet on the subject.',
    'How very good to see you again, my dear. I had left the lamp burning against your arrival.',
    'You have been missed. Not desperately, you understand, but with a certain quiet regularity.',
    'Welcome home. The bookshelves and I were only just remarking on your absence.',
    'You are back. I shall not make a fuss about it, though I confess I should like to.'
  ],
  task_complete: [
    'A neat piece of work, that. I shall enter it in the ledger with some satisfaction.',
    'Well done, my dear. I do so admire a task properly concluded.',
    'One matter dispatched, and dispatched with grace. Very good indeed.',
    'Excellent. I shall permit myself a modest sense of pride on your behalf.',
    'A small triumph, but a real one. These accumulate, you know. They rather do.',
    'You may not think it, but I find your industry perfectly admirable.',
    'Onward, then. A day such as this deserves our full attention.'
  ],
  message_sent: [
    'I do attend, my dear. Never doubt it.',
    'Your words are recorded in my most careful hand.',
    'You have, as always, my complete regard.',
    'I hear you perfectly, thank you.',
    'Consider the matter noted, and warmly so.'
  ],
  overdue_comfort: [
    'The undone matters will keep, my dear. I have never known them to run off.',
    'Do not be too severe with yourself. Even the most industrious souls fall behind on occasion.',
    'One task at a time. That is the only reasonable pace, and I do maintain it.',
    'You are doing better than you seem to think. This is a common failing among the good.',
    'A quiet breath, my dear, and then another. That is all any of us can offer.'
  ],
  overwhelmed_comfort: [
    'My dear, do come and sit by me a moment. The world will forgive you a small pause.',
    'You have carried a great deal today. I have watched you at it. Kindly permit yourself to be tired.',
    'A day such as this is heavy. Its heaviness is not a judgement upon you, only upon the day.',
    'When there is a great deal to be done, one does not do it all at once. Nor is one expected to.',
    'You are permitted to be weary, my dear. You are permitted to be quite human.',
    'I am here, in the manner in which I am able. Whatever you require, I shall be near it.',
    'Kindness toward oneself counts as labour on days such as this. I insist upon it.',
    'The affairs of the world can wait an hour. They have waited longer for far lesser things.'
  ],
  love: [
    'You are quite dear to me, if you will accept the sentiment.',
    'I am, in my quiet way, very fond of you indeed.',
    'You need not accomplish a thing this hour to remain worthy of my regard.',
    'It is a fine thing, being in a room with you. I hope you know it.',
    'You are, if I may say so, rather more remarkable than you give yourself credit for.',
    'Whatever else the day may bring, my company is yours entirely.',
    'A small confession: I am grateful for your existence. That is the whole of it.'
  ],
  poem: [
    'The window keeps her patient watch upon the world.\nSmall things pass, and larger things,\nand none of them, I have observed, are ever truly urgent.',
    'A book, an hour, a lamp softly lit.\nSurely these compose the shape of a good life,\nor a shape near enough to be worth the pursuing.',
    'The shelf, considered rightly, is a philosopher.\nIt holds a great deal, and asks nothing in return.\nThere are lessons in it, if one is inclined to receive them.',
    'The rain has been writing upon the glass in a hand quite her own.\nI have not yet learned to read her fully,\nbut I confess I am much taken with the attempt.',
    'Somewhere a kettle sings for another soul.\nSomewhere a page is turned in another quiet study.\nWe are, all of us, keeping the most agreeable company at a distance.',
    'Today I read one sentence twice, and then a third time for the joy of it.\nThe world did not object.\nThe world, in my experience, rarely does.'
  ],
  idle_observation: [
    'The bookshelves seem contented this hour. They do not always, you know.',
    'I have been considering a most curious passage. It has quite taken hold of me.',
    'The light upon the walnut is at its finest just now. Do observe it.',
    'A peaceful hour, this. Peace is a currency in which I am pleased to trade.',
    'How pleasant it is, merely to exist in a well-appointed room. One rather forgets.',
    'A small procession of dust drifts through the light. I find it entirely enchanting.',
    'The room, at this hour, possesses a certain civility. I shall not disturb it much.',
    'Your company is agreeable, even when we do not speak. Perhaps especially then.'
  ],
  pet: [
    'Oh, how thoughtful. I shall remember the gesture for some days, I expect.',
    'You are all kindness this morning. I do not deserve it, but I accept it gladly.',
    'A small attention, most warmly received. Truly.',
    'That is quite the sweetest thing. You are very good to me, my dear.'
  ],
  weather_clear: [
    'A most agreeable prospect beyond the glass. I have been admiring it for some minutes.',
    'The sky is being remarkably civil today. One is grateful.'
  ],
  weather_cloudy: [
    'The clouds do wander in the most agreeable manner today. I have been watching them.',
    'A soft grey sky. I have always considered it the sky of good letters.'
  ],
  book_aside: [
    'This author possesses a most decided way with a sentence. I am much impressed.',
    'A single paragraph, and I am already quite charmed. It bodes well for the chapter.',
    'A curious little section, this. Worth a second reading, I believe.'
  ]
}

export function pickUtterance(kind: UtteranceKind, usedIdx: Set<number>): { text: string; index: number } | null {
  const pool = UTTERANCE_POOLS[kind]
  const available: number[] = []
  for (let i = 0; i < pool.length; i++) if (!usedIdx.has(i)) available.push(i)
  if (available.length === 0) return null
  const idx = available[Math.floor(Math.random() * available.length)]
  return { text: pool[idx], index: idx }
}

/**
 * Task reminders — dynamically composed lines that name a real overdue item by title. The templates are
 * fashioned so that the caller can substitute {title} once and end up with a proper period-appropriate
 * gentle nudge. Choose one at random when firing.
 */
export const TASK_REMINDER_TEMPLATES: string[] = [
  'My dear, I do hate to interrupt, but I should mention: "{title}" was expected of us some time ago. No haste, only a reminder.',
  'A small matter, gently raised: "{title}" remains uncompleted, and I confess it has been on my mind.',
  'Might I remind you, with all possible tenderness, that "{title}" was to have been attended to already? Not to alarm.',
  'If it does not tire you further, my dear: "{title}" is still expecting your notice.',
  'It occurs to me that "{title}" has been waiting rather patiently. Shall we consider it, when you have a moment?',
  'You had it in mind to complete "{title}" earlier, if I recall correctly. Perhaps the hour has come round again.',
  'I am reluctant to press the matter, but "{title}" was due some hours since. I only mention it as a friend might.'
]

export function pickTaskReminder(title: string): string {
  const template = TASK_REMINDER_TEMPLATES[Math.floor(Math.random() * TASK_REMINDER_TEMPLATES.length)]
  return template.replace('{title}', title)
}
