/**
 * Executes the real application bundle in a DOM.
 *
 * This is the check that was missing: the server can serve every asset with a
 * 200 and the page can still be blank, because nothing had ever *run* the
 * JavaScript. Any import-time or first-render exception fails here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const STATE = {
  project: { name: 'Demo', root: '/tmp/demo', schema_version: 1 },
  agent: {
    backend: 'claude',
    installed: true,
    authenticated: true,
    ready: true,
    message: 'ready',
    detail: null,
  },
  documents: [
    {
      document_id: 'doc-001',
      sha256: 'abc',
      original_filename: 'paper.pdf',
      display_title: 'A Paper',
      title: 'A Paper',
      authors: null,
      year: null,
      page_count: 2,
      byte_size: 1000,
      imported_at: '2026-01-01T00:00:00Z',
      tags: ['field:labor', 'jmp:2026'],
      searchable: true,
      extraction: { status: 'ok', quality: 'ok', warnings: [], error: null },
      summary: { status: 'ready', error: null, generated_at: null },
      summary_text: '## Summary\n\nSomething [cited](source:ref-001).',
      summary_revision: 'rev-s',
    },
  ],
  tags: [
    { tag: 'field:labor', count: 1 },
    { tag: 'jmp:2026', count: 1 },
  ],
  notes: [
    { note_id: 'welcome', title: 'Welcome', revision: 'rev-1', modified_at: '2026-01-01T00:00:00Z' },
  ],
  conversations: [],
  latest_seq: 9,
}

const CONVERSATION = {
  conversation_id: 'conv-1',
  title: 'What does the paper assume?',
  kind: 'chat',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  turn_count: 1,
  status: 'idle',
  last_run_status: 'succeeded',
  resumable: true,
}
STATE.conversations = [CONVERSATION]

// One finished turn, as the server keeps it: the request and its durable
// events. The chat is drawn from these, so a reload shows what the turn did.
const event = (seq, type, payload = {}) => ({
  seq,
  type,
  conversation_id: 'conv-1',
  run_id: 'run-1',
  created_at: '2026-01-01T00:00:00Z',
  ...payload,
})
const TURN = {
  run_id: 'run-1',
  status: 'succeeded',
  kind: 'chat',
  label: null,
  error: null,
  usage: { num_turns: 3, duration_ms: 5600, cost_usd: 0.0425 },
  started_at: '2026-01-01T00:00:00Z',
  ended_at: '2026-01-01T00:00:06Z',
  message: {
    message_id: 'msg-1',
    role: 'user',
    content: 'What does the paper assume?',
    run_id: 'run-1',
    context: { note_id: 'welcome', document_ids: ['doc-001'] },
    created_at: '2026-01-01T00:00:00Z',
  },
  reply: null,
  events: [
    event(1, 'run_started', { kind: 'chat' }),
    event(2, 'tool_started', { tool: 'read_pages', tool_use_id: 't1', input: { document_id: 'doc-001', pages: [1, 2] } }),
    event(3, 'tool_finished', { tool: 'read_pages', tool_use_id: 't1', is_error: false, result: { pages: [{}, {}] } }),
    event(4, 'tool_started', { tool: 'resolve_source', tool_use_id: 't2', input: { document_id: 'doc-001', page_number: 2, quote: 'orthogonal to the timing' } }),
    event(5, 'tool_finished', { tool: 'resolve_source', tool_use_id: 't2', is_error: false, result: { status: 'resolved', reference_id: 'ref-001', quote: 'orthogonal to the timing' } }),
    event(6, 'text_delta', { text: 'It assumes **orthogonality** [p. 2](source:ref-001).', final: true }),
    event(7, 'tool_started', { tool: 'patch_note', tool_use_id: 't3', input: { note_id: 'welcome', old_text: 'a', new_text: 'b' } }),
    event(8, 'tool_finished', { tool: 'patch_note', tool_use_id: 't3', is_error: false, result: { ok: true, title: 'Welcome' } }),
    event(9, 'file_changed', { change_id: 'chg-1', target_kind: 'note', target_id: 'welcome', summary: 'Patched note' }),
    event(10, 'done', { terminal_reason: 'endTurn', status: 'succeeded' }),
  ],
}

const ROUTES = new Map([
  ['/api/state', STATE],
  ['/api/notes/welcome', { note_id: 'welcome', title: 'Welcome', revision: 'rev-1', modified_at: '2026-01-01T00:00:00Z', text: '# Welcome\n\nHello **world**.\n' }],
  ['/api/sync', {
    git: { enabled: true, automatic: true, state: 'dirty', message: '2 changes to save', branch: 'main', remote: 'https://example.com/me/research.git', dirty: 2, ahead: 0, behind: 0, conflict: null, last_commit: { sha: 'abc1234', subject: 'Update note welcome', committed_at: '2026-01-01T00:00:00Z' }, synced_at: null },
    storage: { enabled: true, backend: 's3', where: 's3://papers/library', problem: null, prefetch: false, documents: 1, pdfs_here: 0, synced_at: null, error: null },
    running: false,
  }],
  ['/api/conversations', { conversations: [CONVERSATION] }],
  ['/api/conversations/conv-1', { ...CONVERSATION, backend_session_id: 'abc', messages: [], runs: [], turns: [TURN], latest_seq: 10 }],
  ['/api/changes', { changes: [{ change_id: 'chg-1', target_kind: 'note', target_id: 'welcome', origin: 'agent', summary: 'Patched note', base_revision: null, new_revision: 'rev-2', undoable: true, undone_at: null, created_at: '2026-01-01T00:00:05Z' }] }],
])

function buildDom({ serverToken = 'test-token' } = {}) {
  const html = readFileSync(join(here, '..', '..', 'src', 'litmark', 'static', 'index.html'), 'utf8')
    .replace('<meta name="litmark-token" content="">', '<meta name="litmark-token" content="test-token">')
    // The bundle is injected manually below, so strip the script tags.
    .replace(/<script[^>]*><\/script>/g, '')
    .replace(/<link[^>]*>/g, '')

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const { window } = dom

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const path = url.replace('http://127.0.0.1:8765', '').split('?')[0]
    // The page itself, as the server serves it now: with its current credential.
    if (path === '/') {
      return { ok: true, status: 200, text: async () => `<html><head><meta name="litmark-token" content="${serverToken}"></head></html>` }
    }
    // The API accepts only the server's current credential.
    const sent = init.headers?.get?.('x-litmark-token')
    if (sent !== serverToken) {
      window.refusals = (window.refusals ?? 0) + 1
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'unauthorized', message: 'Missing or invalid session credential.' } }) }
    }
    const body = ROUTES.get(path)
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'not_found', message: path } }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  window.streams = []
  class FakeEventSource {
    constructor(url) {
      window.streams.push(url)
      this.onopen = null
      this.onerror = null
      this.onmessage = null
    }
    addEventListener() {}
    close() {}
  }
  window.EventSource = FakeEventSource
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  window.scrollTo = () => {}
  return dom
}

test('the built application bundle runs and renders without throwing', async (t) => {
  const dom = buildDom()
  const { window } = dom
  // The application keeps timers going (it asks after its sync status now and
  // then); closing the window stops them, so the test run can end.
  t.after(() => window.close())
  const errors = []
  window.addEventListener('error', (event) => errors.push(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => errors.push(event.reason))

  const bundle = readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8')

  // Run the bundle exactly as the browser would.
  let thrown = null
  try {
    window.eval(bundle)
  } catch (error) {
    thrown = error
  }

  assert.equal(thrown, null, `the bundle threw on load: ${thrown?.stack ?? thrown}`)

  // Give the mounted component its first effects and resolved fetches.
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e?.stack ?? e).join('\n')}`)

  const root = window.document.getElementById('app')
  assert.ok(root, 'the mount point is missing')
  assert.ok(root.innerHTML.length > 0, 'the application rendered nothing into #app')
  const text = root.textContent ?? ''
  assert.ok(!text.includes('Opening the project…'), `stuck on the loading state: ${text.slice(0, 200)}`)
  assert.ok(text.includes('Demo'), `project name not rendered: ${text.slice(0, 300)}`)

  // The earlier turn is drawn from its events: the request, each step in the
  // reader's terms, the prose, and the edit with a way to undo it.
  const turn = root.querySelector('.turn')
  assert.ok(turn, 'the conversation rendered no turn')
  const said = turn.textContent ?? ''
  assert.ok(said.includes('What does the paper assume?'), said)
  assert.ok(said.includes('A Paper, pp. 1–2'), `read step missing: ${said}`)
  assert.ok(said.includes('cited'), `citation step missing: ${said}`)
  assert.ok(said.includes('It assumes orthogonality'), `reply missing: ${said}`)
  assert.ok(turn.querySelector('.prose [data-source-ref="ref-001"]'), 'the citation is not a link')
  assert.ok(turn.querySelector('.turn-change'), 'the edit is not listed')
  assert.ok((turn.querySelector('.turn-change')?.textContent ?? '').includes('Undo'), 'no undo offered')
  assert.ok(said.includes('3 steps'), `usage missing: ${said}`)
  assert.equal(root.querySelector('.turn-badge'), null, 'a finished turn needs no badge')
  // Tags: every one in use is a filter, grouped by what comes before its
  // colon, and each paper shows its own.
  const filter = root.querySelector('.tag-filter')
  assert.ok(filter, 'no tag filter')
  const groups = [...filter.querySelectorAll('.tag-group-name')].map((node) => node.textContent)
  assert.deepEqual(groups, ['field', 'jmp'])
  assert.ok((filter.textContent ?? '').includes('labor1'), filter.textContent)
  const own = [...root.querySelectorAll('.entry-tags .tag')].map((node) => node.textContent)
  assert.deepEqual(own, ['field:labor', 'jmp:2026'])

  // Where the project stands with git is said in the top bar.
  const syncButton = root.querySelector('.sync-button')
  assert.ok(syncButton, 'no sync indicator')
  assert.ok((syncButton.textContent ?? '').includes('2 to save'), syncButton.textContent)

  const header = root.querySelector('.conv-button')?.textContent ?? ''
  assert.ok(header.includes('What does the paper assume?'), `conversation not named: ${header}`)
})

test('a page left open across a server restart picks up the new credential', async (t) => {
  // The page was loaded with one credential; the server has since restarted
  // and accepts only another. Without recovery every request is refused and
  // the page sits there looking frozen, though the server is fine.
  const dom = buildDom({ serverToken: 'after-the-restart' })
  const { window } = dom
  t.after(() => window.close())
  const errors = []
  window.addEventListener('unhandledrejection', (event) => errors.push(event.reason))

  window.eval(readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 400))

  const root = window.document.getElementById('app')
  const text = root.textContent ?? ''
  assert.ok(window.refusals > 0, 'the stale credential was never refused: the test proves nothing')
  assert.deepEqual(errors, [], `requests failed for good: ${errors.map((e) => e?.message ?? e).join(' | ')}`)
  assert.ok(text.includes('Demo'), `the project never loaded: ${text.slice(0, 200)}`)
  assert.ok(root.querySelector('.turn'), 'the conversation never loaded')
  // The event stream is opened with the credential the server accepts now.
  assert.ok(window.streams.length > 0, 'no event stream was opened')
  assert.ok(
    window.streams.at(-1).includes('token=after-the-restart'),
    `the stream still carries the old credential: ${window.streams.at(-1)}`,
  )
})
