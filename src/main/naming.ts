/**
 * The naming moment (spec §8 Phase 9g). Once — never during onboarding, never forced, never asked twice. Checked
 * on every window-show, the same trigger 8a/8c already use, and delivered the same way: a quiet chat message, not
 * a toast, so answering it is entirely the user's own pace.
 */
import * as repo from './repo'
import { setOffer } from './ai/context'
import type { ChatMessage } from '../shared/types'

const SETTING_NAME = 'creature.name'
const SETTING_OFFERED = 'creature.name_offered'
/** A real relationship, not a first-launch gesture: genuine use spread across several different days. */
const DAYS_BEFORE_ASKING = 3

export function creatureName(): string | null {
  return repo.getSettingValue(SETTING_NAME)
}

/** Idempotent, safe on every show: returns the message only the one time it is actually sent. */
export function maybeOfferName(): ChatMessage | null {
  if (repo.getSettingValue(SETTING_NAME)) return null // already named
  if (repo.getSettingValue(SETTING_OFFERED)) return null // already asked, once, ever — ANSWERED or not, never asked again
  if (repo.distinctUserMessageDays() < DAYS_BEFORE_ASKING) return null
  repo.setSettingValue(SETTING_OFFERED, new Date().toISOString())
  setOffer({ kind: 'naming' })
  return repo.insertMessage('assistant', 'I think I should have a name. What would you like to call me?', 0)
}
