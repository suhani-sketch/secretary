/** Entity-resolution unit test — `node tests/entity.test.ts` */
import assert from 'node:assert/strict'
import { nameSimilarity, resolveEntity } from '../src/main/entity.ts'

const pool = [
  { id: 'p1', title: 'TISS mailing' },
  { id: 'p2', title: 'IIM application' },
  { id: 'p3', title: 'Shatayush article' }
]
const r = (name: string) => resolveEntity(name, pool)

assert.equal(r('TISS mailing').kind, 'match')
assert.equal(r('the TISS mailing thing').kind, 'match')
assert.equal(r('tiss mailng').kind, 'match') // typo
assert.equal(r('TISS').kind, 'match') // shorthand: one word fully contained
assert.equal(r('the application').kind, 'match') // "IIM application" — "application" contained
assert.equal(r('IIM app').kind, 'match')
assert.equal(r('Umar Khalid screening').kind, 'none')
assert.equal(r('mailing list cleanup').kind === 'match', false) // shares "mailing" only — not a sure match
assert.ok(nameSimilarity('TISS mailing', 'TISS mailing') === 1)
assert.ok(nameSimilarity('TISS mailing', 'IIM application') < 0.3)
// recent focus tips a borderline case
const borderline = resolveEntity('mailing follow up', pool, ['p1'])
assert.ok(borderline.kind !== 'none')
console.log('entity resolution: all checks passed')
