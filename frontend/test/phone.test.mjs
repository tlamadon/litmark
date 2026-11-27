/**
 * The phone's layout, apart from how it is drawn.
 *
 * What is pinned: where the cutoff is, which pane is on show — the tab that
 * was chosen, or until one is, what the session holds — what the library is
 * opened on from a pane, what a session is said to hold, where a paper opened
 * from the library lands, what the Chat tab says and when its dot comes and
 * goes, and what counts as typing — which is when the bar along the bottom
 * gets out of the way.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

import {
  AFTER_ASK,
  afterLooking,
  afterReply,
  chatSign,
  heldIn,
  keyboardAfter,
  kindFor,
  PHONE_BELOW,
  PHONE_QUERY,
  PHONE_TABS,
  RETAP_AFTER_MS,
  retapOpens,
  shownPane,
  tabForPaper,
  takesTyping,
} from './bundle/phonePanes.mjs'

test('the cutoff is said once, and a window of exactly that width is not a phone', () => {
  assert.equal(PHONE_BELOW, 700)
  const limit = Number(/^\(max-width: ([\d.]+)px\)$/.exec(PHONE_QUERY)?.[1])
  assert.ok(limit < PHONE_BELOW, PHONE_QUERY)
  // No window is a fraction of a pixel wide enough to fall between the two.
  assert.ok(limit > PHONE_BELOW - 0.1, PHONE_QUERY)
})

test('the panes are in the order they sit on a wide window', () => {
  assert.deepEqual(PHONE_TABS, ['text', 'paper', 'chat'])
})

test('the tab the reader chose is the pane on show, whatever is behind it', () => {
  const both = { text: true, paper: true }
  const neither = { text: false, paper: false }
  for (const tab of PHONE_TABS) {
    assert.equal(shownPane(tab, both, false), tab)
    // With nothing behind it too: the pane says so, and offers the way to open something.
    assert.equal(shownPane(tab, neither, false), tab)
  }
})

test('the library, asked for, is laid over whichever tab was on', () => {
  for (const tab of [...PHONE_TABS, null]) {
    assert.equal(shownPane(tab, { text: true, paper: true }, true), 'library')
  }
})

test('until a tab is chosen, what the session holds is what is shown', () => {
  // The text first, as it is the first of the panes…
  assert.equal(shownPane(null, { text: true, paper: true }, false), 'text')
  assert.equal(shownPane(null, { text: true, paper: false }, false), 'text')
  // …the paper where there is no text…
  assert.equal(shownPane(null, { text: false, paper: true }, false), 'paper')
  // …and with neither, the library: where one starts.
  assert.equal(shownPane(null, { text: false, paper: false }, false), 'library')
})

test('a pane is filled from its own kind in the library', () => {
  assert.equal(kindFor('text'), 'notes')
  assert.equal(kindFor('paper'), 'papers')
  assert.equal(kindFor('chat'), null)
})

test('a press on the tab already on opens the library at its kind, but not as a double tap', () => {
  // On for a while: the press is a request for something else to fill the pane.
  assert.equal(retapOpens('text', RETAP_AFTER_MS), 'notes')
  assert.equal(retapOpens('paper', 5000), 'papers')
  // Straight after it came on: the second press of a double tap, which is the first again.
  assert.equal(retapOpens('text', 0), null)
  assert.equal(retapOpens('paper', RETAP_AFTER_MS - 1), null)
  // A double tap is done within half a second; the wait is longer than that.
  assert.ok(RETAP_AFTER_MS >= 600, String(RETAP_AFTER_MS))
  // The chat is not opened from the library.
  assert.equal(retapOpens('chat', 5000), null)
})

test('a session is said by what it holds: its text and its paper', () => {
  const names = {
    note: (id) => ({ plan: 'The plan' })[id] ?? null,
    paper: (id) => ({ 'doc-001': 'Olley & Pakes (1996)', 'doc-002': 'Levinsohn & Petrin (2003)' })[id] ?? null,
  }
  const held = (target, documentId = null) => heldIn({ target, documentId }, names)
  assert.deepEqual(held({ kind: 'note', noteId: 'plan' }, 'doc-001'), {
    text: 'The plan',
    paper: 'Olley & Pakes (1996)',
  })
  assert.deepEqual(held({ kind: 'note', noteId: 'plan' }), { text: 'The plan', paper: null })
  // The summary of the paper beside it needs no second naming…
  assert.deepEqual(held({ kind: 'summary', documentId: 'doc-001' }, 'doc-001'), {
    text: 'Summary',
    paper: 'Olley & Pakes (1996)',
  })
  // …one of another paper, or with no paper beside it, says whose it is.
  assert.deepEqual(held({ kind: 'summary', documentId: 'doc-002' }, 'doc-001'), {
    text: 'Summary of Levinsohn & Petrin (2003)',
    paper: 'Olley & Pakes (1996)',
  })
  assert.deepEqual(held({ kind: 'summary', documentId: 'doc-002' }), {
    text: 'Summary of Levinsohn & Petrin (2003)',
    paper: null,
  })
  assert.deepEqual(held({ kind: 'skill' }), { text: 'Summarizing skill', paper: null })
  assert.deepEqual(held({ kind: 'empty' }, 'doc-002'), { text: null, paper: 'Levinsohn & Petrin (2003)' })
  // Nothing open, and what is no longer in the project: not named.
  assert.deepEqual(held({ kind: 'empty' }), { text: null, paper: null })
  assert.deepEqual(held({ kind: 'note', noteId: 'gone' }, 'doc-404'), { text: null, paper: null })
  assert.deepEqual(held({ kind: 'summary', documentId: 'doc-404' }), { text: null, paper: null })
})

test('a paper lands on its summary when it has one, and on the PDF when it has none', () => {
  assert.equal(tabForPaper('ready'), 'text')
  for (const status of ['pending', 'running', 'failed', 'unavailable', 'none', null, undefined]) {
    assert.equal(tabForPaper(status), 'paper', String(status))
  }
})

test('after a request about a passage is sent, the reader is taken to the chat', () => {
  // The default that was agreed; `stay` is the one other value.
  assert.equal(AFTER_ASK, 'chat')
})

test('the Chat tab says the agent is working while a run is going', () => {
  assert.equal(chatSign({ status: 'running' }, false), 'working')
  assert.equal(chatSign({ status: 'queued' }, false), 'working')
  // A run under way says more than a reply that came before it.
  assert.equal(chatSign({ status: 'running' }, true), 'working')
})

test('the Chat tab carries a dot for a reply nobody has looked at', () => {
  assert.equal(chatSign({ status: 'idle', last_run_status: 'succeeded' }, true), 'answered')
  assert.equal(chatSign({ status: 'idle', last_run_status: 'failed' }, true), 'failed')
  assert.equal(chatSign({ status: 'idle', last_run_status: 'succeeded' }, false), null)
  // Before the list of conversations has been read there is nothing to say.
  assert.equal(chatSign(null, false), null)
  assert.equal(chatSign(undefined, true), 'answered')
})

test('a reply waits when it arrives while the chat is not on show', () => {
  const none = new Set()
  // Reading the text of the session: its reply waits.
  assert.deepEqual([...afterReply(none, 'conv-1', null)], ['conv-1'])
  // Looking at another session's chat: it waits too.
  assert.deepEqual([...afterReply(none, 'conv-1', 'conv-2')], ['conv-1'])
  // Read as it arrives, it does not — and nothing is redrawn for it.
  assert.equal(afterReply(none, 'conv-1', 'conv-1'), none)
  // A second reply in the same conversation is the same dot.
  const one = new Set(['conv-1'])
  assert.equal(afterReply(one, 'conv-1', null), one)
  assert.deepEqual([...afterReply(one, 'conv-2', null)].sort(), ['conv-1', 'conv-2'])
})

test('looking at the chat is what clears its dot', () => {
  const two = new Set(['conv-1', 'conv-2'])
  assert.deepEqual([...afterLooking(two, 'conv-1')], ['conv-2'])
  // Nothing waiting there, or nothing looked at: as it was.
  assert.equal(afterLooking(two, 'conv-3'), two)
  assert.equal(afterLooking(two, null), two)
  // The sets given are never changed in place.
  assert.deepEqual([...two].sort(), ['conv-1', 'conv-2'])
})

test('typing is where a keyboard comes up: a box for text, or the editor being edited', () => {
  const { document } = new JSDOM(`
    <textarea id="message"></textarea>
    <textarea id="shown" readonly></textarea>
    <input id="plain">
    <input id="search" type="search">
    <input id="page" type="text">
    <input id="tick" type="checkbox">
    <input id="file" type="file">
    <input id="fixed" readonly>
    <select id="pick"><option>ask</option></select>
    <button id="send">Send</button>
    <div class="cm-content" contenteditable="true"><div id="line">edited</div></div>
    <div class="cm-content" contenteditable="false" tabindex="0"><div id="read">read</div></div>
    <p id="prose">prose</p>
  `).window
  const at = (id) => document.getElementById(id)
  for (const id of ['message', 'plain', 'search', 'page', 'line']) {
    assert.equal(takesTyping(at(id)), true, id)
  }
  for (const id of ['shown', 'tick', 'file', 'fixed', 'pick', 'send', 'read', 'prose']) {
    assert.equal(takesTyping(at(id)), false, id)
  }
  assert.equal(takesTyping(null), false)
  assert.equal(takesTyping(document.body), false)
  // A box taken off the page while it had the focus is not being typed in.
  const gone = at('message')
  gone.remove()
  assert.equal(takesTyping(gone), false)
})

test('a keyboard put away with the box still in focus is known to be gone', () => {
  // The whole window is seen: nothing is known, and the focus is gone by.
  assert.equal(keyboardAfter('unknown', 1), 'unknown')
  // It covers the lower part of the window: up.
  assert.equal(keyboardAfter('unknown', 0.55), 'up')
  // Seen up, and now the whole window is seen again: put away.
  assert.equal(keyboardAfter('up', 1), 'down')
  // A bar of the browser's coming or going is not the keyboard.
  assert.equal(keyboardAfter('up', 0.85), 'up')
  assert.equal(keyboardAfter('unknown', 0.92), 'unknown')
  // Brought back by a press on the box that still had the focus.
  assert.equal(keyboardAfter('down', 0.55), 'up')
  assert.equal(keyboardAfter('down', 1), 'down')
})
