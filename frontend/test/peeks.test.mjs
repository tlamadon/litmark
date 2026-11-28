/**
 * Focus, apart from how it is drawn: the peeks, in the order they are come to.
 *
 * What is pinned: what tells one peek from another, that the same thing asked
 * for again takes the place of the one on top, that something already
 * underneath is gone back to rather than piled on, how deep they go, and that
 * whether a window is in focus is kept — and survives storage being refused.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_PEEKS,
  peeked,
  peekKey,
  rememberFocus,
  steppedBack,
  storedFocus,
} from './bundle/peeks.mjs'

const paper = (documentId, page = 1) => ({ kind: 'paper', documentId, page, reference: null })
const note = (noteId, referenceId = null) => ({
  kind: 'text',
  target: { kind: 'note', noteId },
  referenceId,
})
const chat = { kind: 'chat' }

test('a peek is known by the thing looked at, not the place in it', () => {
  assert.equal(peekKey(paper('doc-001', 3)), peekKey(paper('doc-001', 9)))
  assert.notEqual(peekKey(paper('doc-001')), peekKey(paper('doc-002')))
  assert.equal(peekKey(note('a', 'ref-001')), peekKey(note('a')))
  assert.notEqual(
    peekKey({ kind: 'text', target: { kind: 'summary', documentId: 'doc-001' }, referenceId: null }),
    peekKey(paper('doc-001')),
  )
  assert.equal(peekKey({ kind: 'text', target: { kind: 'skill' }, referenceId: null }), 'skill:summary')
})

test('one peek leads to another, and each can be stepped back from', () => {
  let stack = peeked([], chat)
  stack = peeked(stack, paper('doc-001', 4))
  stack = peeked(stack, note('a'))
  assert.deepEqual(stack.map(peekKey), ['chat', 'paper:doc-001', 'note:a'])
  stack = steppedBack(stack)
  assert.deepEqual(stack.map(peekKey), ['chat', 'paper:doc-001'])
  assert.deepEqual(steppedBack(steppedBack(stack)), [])
  assert.deepEqual(steppedBack([]), [])
})

test('another passage of the paper on top takes its place', () => {
  const stack = peeked(peeked([chat], paper('doc-001', 4)), paper('doc-001', 9))
  assert.equal(stack.length, 2)
  assert.equal(stack[1].page, 9)
})

test('something already underneath is gone back to, not piled on again', () => {
  let stack = peeked(peeked([chat], paper('doc-001', 4)), note('a'))
  stack = peeked(stack, chat)
  assert.deepEqual(stack.map(peekKey), ['chat'])
  // And it is the one asked for that is kept: a new place in the same thing.
  stack = peeked(peeked([paper('doc-001', 2)], note('a')), paper('doc-001', 30))
  assert.deepEqual(stack, [paper('doc-001', 30)])
})

test('they go no deeper than the limit, letting go of the first', () => {
  let stack = []
  for (let index = 0; index < MAX_PEEKS + 3; index += 1) stack = peeked(stack, note(`n${index}`))
  assert.equal(stack.length, MAX_PEEKS)
  assert.equal(peekKey(stack[0]), 'note:n3')
})

test('asking for a peek leaves the peeks there were as they were', () => {
  const before = Object.freeze([chat])
  const after = peeked(before, paper('doc-001'))
  assert.equal(before.length, 1)
  assert.equal(after.length, 2)
})

test('whether a window is in focus is kept, and off is the way it starts', () => {
  const kept = new Map()
  const storage = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => kept.set(key, value),
    removeItem: (key) => kept.delete(key),
  }
  assert.equal(storedFocus(storage), false)
  rememberFocus(storage, true)
  assert.equal(storedFocus(storage), true)
  rememberFocus(storage, false)
  assert.equal(storedFocus(storage), false)
  assert.equal(kept.size, 0)
})

test('storage that is refused leaves the usual layout', () => {
  const refused = () => {
    throw new Error('refused')
  }
  const storage = { getItem: refused, setItem: refused, removeItem: refused }
  assert.equal(storedFocus(storage), false)
  assert.doesNotThrow(() => rememberFocus(storage, true))
  assert.equal(storedFocus(null), false)
  assert.doesNotThrow(() => rememberFocus(null, true))
})
