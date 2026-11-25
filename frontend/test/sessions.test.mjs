/**
 * Sessions: a conversation and what was on screen with it.
 *
 * What is pinned: a saved view is read back trusting none of it, each session
 * has an address, and the row shows the sessions under way in an order that
 * does not shift when something happens in one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addressOf,
  EMPTY_VIEW,
  isUntouched,
  openSessions,
  readView,
  sessionInAddress,
} from './bundle/sessionView.mjs'

const chat = (id, fields = {}) => ({
  conversation_id: id,
  title: id,
  kind: 'chat',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  turn_count: 1,
  status: 'idle',
  last_run_status: 'succeeded',
  resumable: true,
  view: null,
  closed: false,
  ...fields,
})

test('a saved view is read back as it was kept', () => {
  const view = {
    target: { kind: 'summary', documentId: 'doc-002' },
    documentId: 'doc-002',
    page: 14,
    attached: ['doc-002', 'doc-005'],
    library: true,
  }
  assert.deepEqual(readView(JSON.parse(JSON.stringify(view))), view)
  assert.deepEqual(readView({ target: { kind: 'note', noteId: 'plan' } }).target, { kind: 'note', noteId: 'plan' })
  assert.deepEqual(readView({ target: { kind: 'skill' } }).target, { kind: 'skill' })
})

test('what cannot be a view is read as nothing open, not trusted', () => {
  for (const junk of [null, undefined, 'x', 7, [], {}]) assert.deepEqual(readView(junk), EMPTY_VIEW)
  assert.deepEqual(
    readView({
      target: { kind: 'note' }, // no note named
      documentId: 12,
      page: -3,
      attached: ['doc-001', 4, null],
      library: 'yes',
    }),
    { ...EMPTY_VIEW, attached: ['doc-001'] },
  )
  assert.deepEqual(readView({ target: { kind: 'elsewhere', url: 'https://x' } }).target, { kind: 'empty' })
  assert.equal(readView({ page: 3.7 }).page, 3)
})

test('each session has an address, and an address names at most one', () => {
  assert.equal(addressOf('conv-1a2b'), '/s/conv-1a2b')
  assert.equal(sessionInAddress('/s/conv-1a2b'), 'conv-1a2b')
  assert.equal(sessionInAddress('/s/conv-1a2b/'), 'conv-1a2b')
  for (const other of ['/', '/s/', '/s/a/b', '/notes/conv-1', '/s/../x', '/login']) {
    assert.equal(sessionInAddress(other), null, other)
  }
})

test('the row holds the sessions under way, in the order they were begun', () => {
  // As the server lists them: most recently used first.
  const listed = [
    chat('c', { created_at: '2026-01-03T00:00:00Z', view: {} }),
    chat('a', { created_at: '2026-01-01T00:00:00Z', view: {} }),
    chat('b', { created_at: '2026-01-02T00:00:00Z', view: {}, closed: true }),
    { ...chat('bg'), kind: 'system' },
  ]
  const ids = (sessions) => sessions.map((session) => session.conversation_id)
  // A tab does not move because something happened in it; one put away is
  // not there; background work is not a session.
  assert.deepEqual(ids(openSessions(listed, 'a')), ['a', 'c'])
  // The one on screen is always among them, put away or not.
  assert.deepEqual(ids(openSessions(listed, 'b')), ['a', 'b', 'c'])
})

test('conversations from before there were sessions do not bury the row', () => {
  const old = Array.from({ length: 9 }, (_unused, n) =>
    chat(`old-${n}`, { created_at: `2025-12-0${9 - n}T00:00:00Z` }),
  )
  const shown = openSessions(old, null).map((session) => session.conversation_id)
  // Only the most recently used of them, until one is gone to or closed.
  assert.deepEqual(shown, ['old-3', 'old-2', 'old-1', 'old-0'])
  const visited = old.map((c) => (c.conversation_id === 'old-8' ? { ...c, view: {} } : c))
  assert.ok(openSessions(visited, null).some((session) => session.conversation_id === 'old-8'))
})

test('a session nothing has been done in is as good as a new one', () => {
  assert.equal(isUntouched(chat('x', { turn_count: 0 })), true)
  assert.equal(isUntouched(chat('x', { turn_count: 0, view: { library: true } })), true)
  assert.equal(isUntouched(chat('x', { turn_count: 2 })), false)
  assert.equal(isUntouched(chat('x', { turn_count: 0, view: { documentId: 'doc-001' } })), false)
  assert.equal(
    isUntouched(chat('x', { turn_count: 0, view: { target: { kind: 'note', noteId: 'plan' } } })),
    false,
  )
})
