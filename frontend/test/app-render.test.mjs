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

import { mediaMatches } from './media.mjs'

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
    models: ['opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    default_model: 'claude-opus-5',
    default_effort: null,
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
  model: 'haiku',
  effort: 'low',
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

function buildDom({ serverToken = 'test-token', routes = ROUTES, width = null, height = 0, touch = false } = {}) {
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
    window.requests.push(`${init.method ?? 'GET'} ${path}`)
    // A session's view is kept with its conversation; a new session is a new conversation.
    const viewOf = /^\/api\/conversations\/([^/]+)\/view$/.exec(path)
    if (init.method === 'PUT' && viewOf) {
      const list = routes.get('/api/conversations')
      routes.set('/api/conversations', {
        conversations: list.conversations.map((c) =>
          c.conversation_id === viewOf[1] ? { ...c, view: JSON.parse(init.body).view } : c,
        ),
      })
      return { ok: true, status: 204, text: async () => '' }
    }
    // What answers in a session is kept with its conversation too.
    const agentOf = /^\/api\/conversations\/([^/]+)\/agent$/.exec(path)
    if (init.method === 'PUT' && agentOf) {
      window.choices.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...CONVERSATION, ...JSON.parse(init.body) }) }
    }
    if (init.method === 'POST' && path === '/api/conversations') {
      const created = {
        ...CONVERSATION,
        conversation_id: `conv-${routes.get('/api/conversations').conversations.length + 1}`,
        title: 'New conversation',
        untitled: true,
        turn_count: 0,
        last_run_status: null,
      }
      routes.set('/api/conversations', {
        conversations: [created, ...routes.get('/api/conversations').conversations],
      })
      routes.set(`/api/conversations/${created.conversation_id}`, { ...created, messages: [], runs: [], turns: [], latest_seq: 10 })
      return { ok: true, status: 201, text: async () => JSON.stringify(routes.get(`/api/conversations/${created.conversation_id}`)) }
    }
    // A session renamed: its conversation goes by the name given.
    const named = /^\/api\/conversations\/([^/]+)$/.exec(path)
    if (init.method === 'PATCH' && named && JSON.parse(init.body).title) {
      const list = routes.get('/api/conversations')
      const title = JSON.parse(init.body).title
      routes.set('/api/conversations', {
        conversations: list.conversations.map((c) =>
          c.conversation_id === named[1] ? { ...c, title, untitled: false } : c,
        ),
      })
      return { ok: true, status: 200, text: async () => JSON.stringify({ conversation_id: named[1], title }) }
    }
    if (init.method === 'DELETE' && routes.has(path)) {
      // Gone from the server: from its own address, and from the list of notes.
      routes.delete(path)
      const state = routes.get('/api/state')
      routes.set('/api/state', {
        ...state,
        notes: state.notes.filter((note) => `/api/notes/${note.note_id}` !== path),
      })
      return { ok: true, status: 204, text: async () => '' }
    }
    // What goes with a note, and what goes with a paper, are asked at one address.
    const body =
      path === '/api/related'
        ? routes.get(url.includes('note_id=') ? '/api/related?note' : '/api/related?paper')
        : routes.get(path)
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'not_found', message: path } }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  window.streams = []
  window.requests = []
  window.choices = []
  window.sources = []
  class FakeEventSource {
    constructor(url) {
      window.streams.push(url)
      window.sources.push(this)
      this.onopen = null
      this.onerror = null
      this.onmessage = null
      this.listeners = new Map()
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener)
    }
    /** What the server would send: one event, named by its type. */
    emit(event) {
      this.listeners.get(event.type)?.({ data: JSON.stringify(event) })
    }
    close() {}
  }
  window.EventSource = FakeEventSource
  if (width !== null) {
    // A window of a given size: what the layout asks of it is answered from that.
    window.matchMedia = (query) => ({
      matches: mediaMatches(query, { width, height, touch }),
      addEventListener() {},
      removeEventListener() {},
    })
  } else if (!window.matchMedia) {
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
  const own = [...root.querySelectorAll('.card.paper .card-tags .tag')].map((node) => node.textContent)
  assert.deepEqual(own, ['field:labor', 'jmp:2026'])
  // Nothing is open yet: what is on the page is the library, papers first.
  assert.ok(root.querySelector('.library'), 'the library is not where one starts')
  assert.equal(root.querySelector('.cm-content'), null, 'something was opened unasked')
  assert.deepEqual(
    [...root.querySelectorAll('.library .mode-tabs button')].map((node) => node.textContent),
    ['Papers 1', 'Notes 1'],
  )

  // Where the project stands with git is said in the top bar.
  const syncButton = root.querySelector('.sync-button')
  assert.ok(syncButton, 'no sync indicator')
  assert.ok((syncButton.textContent ?? '').includes('2 to save'), syncButton.textContent)

  // No password is asked for here, so there is no session to offer to end.
  assert.equal(root.querySelector('[data-action="sign-out"]'), null)

  // A server that says nothing of its version is not given one.
  assert.equal(root.querySelector('.topbar .version'), null)

  // No recogniser in this browser: no microphone, rather than one that fails.
  assert.equal(root.querySelector('.mic-button'), null)

  const header = root.querySelector('.conv-button')?.textContent ?? ''
  assert.ok(header.includes('What does the paper assume?'), `conversation not named: ${header}`)

  // The composer says what answers in this session, and its menu changes it.
  const agentButton = root.querySelector('[data-setting="agent"]')
  assert.ok(agentButton, 'no model and effort button')
  assert.ok((agentButton.textContent ?? '').includes('haiku · low'), agentButton.textContent)
  agentButton.click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const options = [...root.querySelectorAll('.agent-menu [role="menuitemradio"]')]
  assert.deepEqual(
    options.map((node) => (node.textContent ?? '').replace('✓', '').trim()),
    ['Default (claude-opus-5)', 'opus', 'sonnet', 'haiku', 'Other…', 'Default', 'low', 'medium', 'high', 'xhigh', 'max'],
  )
  assert.deepEqual(
    options.filter((node) => node.getAttribute('aria-checked') === 'true').map((node) => (node.textContent ?? '').replace('✓', '').trim()),
    ['haiku', 'low'],
  )
  options[1].click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(window.choices, [{ model: 'opus', effort: 'low' }])
  assert.equal(root.querySelector('.agent-menu'), null, 'the menu stayed open after a choice')
  assert.ok(
    (root.querySelector('[data-setting="agent"]')?.textContent ?? '').includes('opus · low'),
    'the new choice is not shown',
  )
})

test('the composer takes dictation where the browser has a recogniser', async (t) => {
  const dom = buildDom()
  const { window } = dom
  t.after(() => window.close())
  const errors = []
  window.addEventListener('error', (event) => errors.push(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => errors.push(event.reason))
  // A recogniser standing in for the browser's: the test says what it heard.
  const recognitions = []
  window.webkitSpeechRecognition = class {
    constructor() {
      this.started = false
      this.stopped = false
      recognitions.push(this)
    }
    start() {
      this.started = true
    }
    stop() {
      this.stopped = true
    }
    hear(...phrases) {
      this.onresult?.({ results: phrases.map((transcript) => [{ transcript }]) })
    }
  }
  // What is sent, as sent.
  const sent = []
  const fetch = window.fetch
  window.fetch = async (input, init = {}) => {
    if (init.method === 'POST' && String(input).endsWith('/messages')) sent.push(JSON.parse(init.body))
    return fetch(input, init)
  }
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

  window.eval(readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8'))
  await settle(300)

  const root = window.document.getElementById('app')
  const input = root.querySelector('.composer textarea')
  const mic = root.querySelector('.composer .mic-button')
  assert.ok(mic, 'no microphone in the composer')
  assert.equal(mic.getAttribute('aria-pressed'), 'false')

  // What is typed stays; what is heard goes in at the caret, a space between.
  input.value = 'Look at'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
  input.setSelectionRange(7, 7)
  mic.click()
  await settle()
  assert.equal(recognitions.length, 1)
  assert.ok(recognitions[0].started, 'the recogniser was not started')
  assert.equal(mic.getAttribute('aria-pressed'), 'true')
  assert.ok(mic.classList.contains('listening'))
  // Provisional words, then the settled ones in their place.
  recognitions[0].hear('the second')
  await settle()
  assert.equal(input.value, 'Look at the second')
  recognitions[0].hear('the second ', ' table please')
  await settle()
  assert.equal(input.value, 'Look at the second table please')

  // Esc stops the microphone, and only that.
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  assert.ok(recognitions[0].stopped, 'Esc did not stop the recogniser')
  assert.equal(mic.getAttribute('aria-pressed'), 'false')
  // A result arriving after it was stopped is not typed in.
  recognitions[0].hear('ignored')
  await settle()
  assert.equal(input.value, 'Look at the second table please')

  // Sending while it listens stops it, and sends what was shown.
  mic.click()
  await settle()
  recognitions[1].hear('now')
  await settle()
  assert.equal(input.value, 'Look at the second table please now')
  root.querySelector('.composer-actions button.primary').click()
  await settle(100)
  assert.ok(recognitions[1].stopped, 'sending did not stop the recogniser')
  assert.equal(sent.length, 1, 'nothing was sent')
  assert.equal(sent[0].prompt, 'Look at the second table please now')

  // A refusal is said in words, where the hint is.
  const again = root.querySelector('.composer .mic-button')
  again.click()
  await settle()
  recognitions[2].onerror({ error: 'audio-capture' })
  await settle()
  assert.equal(root.querySelector('.composer-error')?.textContent, 'No microphone was found.')
  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e?.stack ?? e).join('\n')}`)
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

test('the library, what is open, and the panel about it', async (t) => {
  // Two papers whose authors someone has said, and one still known only by its title.
  const named = (id, label, year, title) => ({
    ...STATE.documents[0],
    document_id: id,
    display_title: title,
    title,
    label,
    year,
    tags: [],
  })
  const state = {
    ...STATE,
    documents: [
      { ...STATE.documents[0], label: null },
      named('doc-002', 'Olley & Pakes (1992)', 1992, 'The Dynamics of Productivity'),
      named('doc-003', 'Levinsohn & Petrin (2003)', 2003, 'Estimating Production Functions'),
    ],
  }
  const text = [
    '# Welcome',
    '',
    'This extends [Olley–Pakes (1996)](paper:doc-002), as Levinsohn and Petrin (2003) do.',
    '',
    '## What is missing',
    '',
    'See also [one that is gone](paper:doc-404).',
    '',
    '| Paper | Proxy | N |',
    '|:--|:-:|--:|',
    '| [OP](paper:doc-002) | **investment** | 12 |',
    '| LP | materials [p. 2](source:ref-001) | 7 |',
    '',
    '```',
    '# not a heading',
    '```',
    '',
  ].join('\n')
  const routes = new Map(ROUTES)
  routes.set('/api/state', { ...state, auth: { password: true } })
  routes.set('/api/version', {
    version: '0.3.1',
    checks_for_updates: true,
    latest: '0.4.0',
    update_available: true,
    release_url: 'https://github.com/tlamadon/litmark/releases/tag/v0.4.0',
  })
  routes.set('/api/notes/welcome', { ...ROUTES.get('/api/notes/welcome'), text })
  routes.set('/api/related?note', { papers: [{ document_id: 'doc-002', count: 2 }] })
  routes.set('/api/documents/doc-003/summary', { document_id: 'doc-003', text: '## Summary\n\nUses intermediate inputs.\n', revision: 'rev-3', status: 'ready' })
  routes.set('/api/skills/summary', {
    name: 'summary',
    text: '# How to summarize a paper\n\nLead with the identification strategy.\n\n## Length\n\nAt most 120 words.\n',
    revision: 'rev-skill',
    customised: true,
  })
  routes.set('/api/changes', {
    changes: [
      { change_id: 'chg-7', target_kind: 'skill', target_id: 'summary', origin: 'agent', summary: 'Learned: lead with identification.', base_revision: 'a', new_revision: 'rev-skill', undoable: true, undone_at: null, created_at: '2026-01-01T00:00:05Z' },
    ],
  })
  routes.set('/api/related?paper', {
    notes: [{ note_id: 'welcome', title: 'Welcome', count: 1 }],
    mentions: [],
    mentioned_by: [{ document_id: 'doc-003', count: 1 }],
    same_tags: [],
  })
  const dom = buildDom({ routes })
  const { window } = dom
  t.after(() => window.close())
  const errors = []
  window.addEventListener('error', (event) => errors.push(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => errors.push(event.reason))
  window.eval(readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8'))
  const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  const type = (input, value) => {
    input.value = value
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  await settle(300)
  const root = window.document.getElementById('app')
  const cards = (kind) =>
    [...root.querySelectorAll(`.library .card.${kind}`)].map((card) => [
      card.querySelector('strong')?.textContent,
      card.querySelector('.card-title')?.textContent ?? null,
    ])
  const sections = () =>
    Object.fromEntries(
      [...root.querySelectorAll('.sidebar section')]
        .filter((section) => section.querySelector('h3'))
        .map((section) => [
          section.querySelector('h3').textContent,
          [...section.querySelectorAll('li')].map((item) => item.textContent),
        ]),
    )

  // The version running is in the top bar, with a mark beside it that leads
  // to the later release there is.
  assert.equal(root.querySelector('.topbar .version-number')?.textContent, 'v0.3.1')
  const update = root.querySelector('.topbar a.version-update')
  assert.equal(update?.getAttribute('href'), 'https://github.com/tlamadon/litmark/releases/tag/v0.4.0')
  assert.ok(update.getAttribute('title').includes('0.4.0'), update.getAttribute('title'))
  // The page is the one the server sent: nothing to reload for.
  assert.equal(root.querySelector('.topbar [data-action="reload"]'), null)

  // Behind a password, the way to end the session is in the top bar.
  assert.equal(root.querySelector('.topbar [data-action="sign-out"]')?.textContent, 'Sign out')

  // ---- the library: a paper is named as it is cited, with its title beneath.
  // Most recently added first, which for papers added together is as they came.
  assert.deepEqual(cards('paper'), [
    ['A Paper', null],
    ['Olley & Pakes (1992)', 'The Dynamics of Productivity'],
    ['Levinsohn & Petrin (2003)', 'Estimating Production Functions'],
  ])
  assert.deepEqual(cards('note'), [], 'notes are on their own tab')
  // What is typed narrows both at once, by whatever a paper is known by.
  type(root.querySelector('.library-tools input'), 'pakes 1992')
  await settle(50)
  assert.deepEqual(cards('paper'), [['Olley & Pakes (1992)', 'The Dynamics of Productivity']])
  type(root.querySelector('.library-tools input'), 'welc')
  await settle(50)
  assert.deepEqual([cards('paper'), cards('note')], [[], [['Welcome', null]]])
  type(root.querySelector('.library-tools input'), '')
  // A tag in the panel narrows the papers to those carrying it.
  click([...root.querySelectorAll('.sidebar .tag-filter .tag')].find((tag) => tag.textContent.startsWith('labor')))
  await settle(50)
  assert.deepEqual(cards('paper'), [['A Paper', null]])
  click(root.querySelector('.library-head .tag.on'))
  await settle(50)
  assert.equal(cards('paper').length, 3)

  // ---- the summarizing skill: how the agent has learned to summarize, one
  // click from the library, open to be read and changed like a note.
  click(root.querySelector('.library [data-action="open-skill"]'))
  await settle()
  assert.equal(root.querySelector('.editor-bar .editor-title')?.textContent, 'How papers are summarized')
  assert.ok((root.querySelector('.cm-content')?.textContent ?? '').includes('Lead with the identification strategy.'))
  assert.equal(root.querySelector('.sidebar .about strong')?.textContent, 'How papers are summarized')
  assert.ok((root.querySelector('.sidebar .about')?.textContent ?? '').includes('Tell it in the chat'))
  assert.deepEqual(sections(), { Contents: ['How to summarize a paper', 'Length'] })
  // What it learned is on the record, named for what it is, with a way back.
  click(root.querySelector('.sidebar details.changes summary'))
  root.querySelector('.sidebar details.changes').open = true
  root.querySelector('.sidebar details.changes').dispatchEvent(new window.Event('toggle'))
  await settle(100)
  const learned = root.querySelector('.sidebar details.changes li')?.textContent ?? ''
  assert.ok(learned.includes('how papers are summarized'), learned)
  assert.ok(learned.includes('Learned: lead with identification.') && learned.includes('Undo'), learned)
  click(root.querySelector('[data-action="library"]'))
  await settle(50)

  // ---- a note, opened from its card
  click(root.querySelector('.library [data-show="notes"]'))
  await settle(50)
  click(root.querySelector('.card.note[data-note="welcome"] .card-open'))
  await settle()
  assert.equal(root.querySelector('.library'), null, 'the library stayed in the way')
  // It is named in the editor's own bar: no line is spent on a heading above it.
  assert.equal(root.querySelector('.editor-bar .editor-title')?.textContent, 'Welcome')
  assert.equal(root.querySelector('.main-head'), null)

  // A link written into the note names its paper, and says so when the paper
  // is gone. Words that merely read like a citation are left as words.
  const links = [...root.querySelectorAll('.cm-paper-link')].map((node) => [
    node.textContent,
    node.classList.contains('missing'),
    node.title,
  ])
  assert.deepEqual(links.slice(0, 2), [
    ['Olley–Pakes (1996)', false, 'The Dynamics of Productivity — open the paper'],
    ['one that is gone', true, 'This paper is not in the library (any more)'],
  ])

  // A table is drawn as one — not as the bars and dashes it is written in —
  // with its columns set as the rule says, and its cells as inline Markdown.
  const table = root.querySelector('.cm-content .cm-table-wrap table')
  assert.ok(table, 'the table is still shown as written')
  assert.deepEqual(
    [...table.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => cell.textContent)),
    [
      ['Paper', 'Proxy', 'N'],
      ['OP', 'investment', '12'],
      ['LP', 'materials p. 2', '7'],
    ],
  )
  assert.deepEqual(
    [...table.querySelectorAll('th')].map((cell) => cell.style.textAlign),
    ['left', 'center', 'right'],
  )
  assert.ok(table.querySelector('td strong'), 'a cell is not rendered as Markdown')
  assert.ok(table.querySelector('.cm-paper-link[data-paper="doc-002"]:not(.missing)'))
  assert.ok(table.querySelector('.cm-source-link[data-source-ref="ref-001"]'))
  assert.ok(!(root.querySelector('.cm-content')?.textContent ?? '').includes('|:--|'))
  const line = root.querySelector('.cm-content')?.textContent ?? ''
  assert.ok(line.includes('as Levinsohn and Petrin (2003) do.'), line)

  // The panel is about the note: its headings, and the papers it is tied to.
  assert.deepEqual(sections(), {
    Contents: ['Welcome', 'What is missing'],
    'Papers in this note': ['Olley & Pakes (1992)×2'],
  })

  // ---- a click on the link opens the paper beside the note, under one line of header
  root
    .querySelector('.cm-paper-link:not(.missing)')
    .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await settle(100)
  const bar = root.querySelector('aside.source .pdf-bar')
  assert.ok(bar, 'the paper did not open')
  assert.equal(bar.querySelector('.pdf-title').textContent, 'Olley & Pakes (1992)')
  assert.ok(bar.querySelector('input[aria-label="Page number"]'), 'the page is not in the same bar')
  assert.ok(bar.querySelector('.close'), 'the way out is not in the same bar')
  assert.equal(root.querySelectorAll('aside.source header').length, 1)

  // ---- the library again, and back: what was open kept its place
  click(root.querySelector('[data-action="library"]'))
  await settle(50)
  assert.ok(root.querySelector('.library') && !root.querySelector('.cm-content'))
  click(root.querySelector('[data-action="library"]'))
  await settle(100)
  assert.ok(root.querySelector('.cm-content') && root.querySelector('aside.source .pdf-bar'))

  // ---- sessions: the conversation under way is a tab, with an address of its
  // own, and what is on screen is kept with it.
  const tabs = () =>
    [...root.querySelectorAll('.topbar .sessions .session')].map((tab) => [
      tab.dataset.session,
      tab.classList.contains('on'),
      tab.querySelector('.session-title').textContent,
    ])
  assert.deepEqual(tabs(), [['conv-1', true, 'What does the paper assume?']])
  assert.equal(window.location.pathname, '/s/conv-1')
  assert.equal(root.querySelector('.session a').getAttribute('href'), '/s/conv-1')
  await settle(900) // The view is told a moment after it settles.
  const kept = routes.get('/api/conversations').conversations.find((c) => c.conversation_id === 'conv-1').view
  // (No page: nothing lays a paper out here, so none is ever in view. A paper
  // opened from a link in the text is shown, not attached to what is asked.)
  // With it, what was opened in the session and not closed: the skill and the
  // note, in the order they were opened, and the paper.
  assert.deepEqual(kept, {
    target: { kind: 'note', noteId: 'welcome' },
    documentId: 'doc-002',
    page: null,
    attached: [],
    library: false,
    texts: [{ kind: 'skill' }, { kind: 'note', noteId: 'welcome' }],
    papers: ['doc-002'],
  })

  // A new session starts with nothing open: its own conversation, the library.
  click(root.querySelector('[data-action="new-session"]'))
  await settle(300)
  assert.equal(window.location.pathname, '/s/conv-2')
  assert.ok(root.querySelector('.library') && !root.querySelector('.cm-content'))
  assert.equal(root.querySelector('aside.source'), null)
  assert.deepEqual(tabs(), [
    ['conv-1', false, 'What does the paper assume?'],
    ['conv-2', true, 'New session'],
  ])
  // Until something is asked in it, it goes by what is open in it.
  click(root.querySelector('.card.paper[data-document="doc-003"] .card-open'))
  await settle(300)
  assert.equal(tabs()[1][2], 'Levinsohn & Petrin (2003)')

  // A tab is renamed where it is: double-click, type, Enter. Escape gives up.
  const renameTab = (id) => {
    const link = root.querySelector(`.session[data-session="${id}"] a`)
    link.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  }
  const press = (node, key) =>
    node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  renameTab('conv-2')
  await settle(20)
  let nameField = root.querySelector('.session[data-session="conv-2"] input.session-name')
  assert.equal(nameField?.value, 'Levinsohn & Petrin (2003)')
  type(nameField, 'Given up on')
  press(nameField, 'Escape')
  await settle(50)
  assert.equal(tabs()[1][2], 'Levinsohn & Petrin (2003)')
  assert.ok(!window.requests.some((request) => request.startsWith('PATCH')), 'renamed unasked')
  renameTab('conv-2')
  await settle(20)
  nameField = root.querySelector('.session[data-session="conv-2"] input.session-name')
  type(nameField, '  Proxy variables  ')
  press(nameField, 'Enter')
  await settle(200)
  assert.equal(root.querySelector('input.session-name'), null)
  assert.equal(tabs()[1][2], 'Proxy variables')
  assert.equal(
    window.requests.filter((request) => request === 'PATCH /api/conversations/conv-2').length,
    1,
    'the name is kept once',
  )

  // Going back to the first is going back to the work: the note, and the paper beside it.
  click(root.querySelector('.session[data-session="conv-1"] a'))
  await settle(300)
  assert.equal(window.location.pathname, '/s/conv-1')
  assert.equal(root.querySelector('.editor-bar .editor-title')?.textContent, 'Welcome')
  assert.equal(root.querySelector('aside.source .pdf-title')?.textContent, 'Olley & Pakes (1992)')
  // And the other kept its own.
  click(root.querySelector('.session[data-session="conv-2"] a'))
  await settle(300)
  assert.equal(
    root.querySelector('.editor-bar .editor-title')?.textContent,
    'Summary — Levinsohn & Petrin (2003)',
  )
  click(root.querySelector('.session[data-session="conv-1"] a'))
  await settle(300)

  // ---- deleting is asked for, confirmed, and then the note is gone from the
  // page; the paper that was beside it is what is left, and the panel is about it.
  click(root.querySelector('.sidebar [data-action="delete-note"]'))
  await settle(20)
  assert.ok(!window.requests.some((request) => request.startsWith('DELETE')), 'deleted unasked')
  assert.ok((root.querySelector('.entry-confirm')?.textContent ?? '').includes('Recent edits'))
  click(root.querySelector('[data-action="confirm-delete-note"]'))
  await settle()
  assert.ok(window.requests.includes('DELETE /api/notes/welcome'), window.requests.join('\n'))
  assert.equal(root.querySelector('.cm-content'), null, 'the deleted note is still on the page')
  assert.equal(root.querySelector('.sidebar .about strong')?.textContent, 'Olley & Pakes (1992)')
  assert.deepEqual(sections(), {
    'Notes about it': ['Welcome'],
    'Mentioned by': ['Levinsohn & Petrin (2003)'],
  })
  click(root.querySelector('[data-action="library"]'))
  await settle(50)
  click(root.querySelector('.library [data-show="notes"]'))
  await settle(50)
  assert.deepEqual(cards('note'), [], 'the note is still listed')
  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e?.stack ?? e).join('\n')}`)
})

test('on a phone: the session at the top, one pane at a time, and a bar afloat at the bottom', async (t) => {
  // A second session, holding other things: the summary of the paper, and the paper.
  const other = {
    ...CONVERSATION,
    conversation_id: 'conv-2',
    title: 'The other line of work',
    turn_count: 0,
    view: { target: { kind: 'summary', documentId: 'doc-001' }, documentId: 'doc-001', page: 1, attached: [], library: false },
  }
  const routes = new Map(ROUTES)
  routes.set('/api/notes/welcome', {
    ...ROUTES.get('/api/notes/welcome'),
    text: '# Welcome\n\nHello **world**.\n\n## Further down\n\nMore.\n',
  })
  routes.set('/api/documents/doc-001/summary', { document_id: 'doc-001', text: '## Summary\n\nSomething.\n', revision: 'rev-s', status: 'ready' })
  routes.set('/api/related?note', { papers: [{ document_id: 'doc-001', count: 1 }] })
  routes.set('/api/related?paper', { notes: [], mentions: [], mentioned_by: [], same_tags: [] })
  routes.set('/api/state', { ...STATE, conversations: [CONVERSATION, other], auth: { password: true } })
  routes.set('/api/conversations', { conversations: [CONVERSATION, other] })
  routes.set('/api/conversations/conv-2', { ...other, messages: [], runs: [], turns: [], latest_seq: 10 })
  routes.set('/api/conversations/conv-1/messages', { run_id: 'run-9', conversation_id: 'conv-1', status: 'queued' })
  routes.set('/api/version', { version: '0.3.8', checks_for_updates: false, latest: null, update_available: false, release_url: null })
  const dom = buildDom({ routes, width: 390 })
  const { window } = dom
  t.after(() => window.close())
  const errors = []
  window.addEventListener('error', (event) => errors.push(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => errors.push(event.reason))
  window.eval(readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8'))
  const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle(300)
  const root = window.document.getElementById('app')
  const shell = root.querySelector('.shell')
  const tab = (name) => root.querySelector(`.phone-tab[data-tab="${name}"]`)
  /** Which of the three is on show; all three are there, hidden or not. */
  const panes = () =>
    Object.fromEntries(
      [...root.querySelectorAll('.body > .pane')].map((pane) => [
        pane.classList[0],
        pane.classList.contains('on'),
      ]),
    )
  /** For each tab: whether it is the one on, and whether there is nothing behind it. */
  const tabs = () =>
    [...root.querySelectorAll('.phone-tab')].map((node) => [
      node.dataset.tab,
      node.getAttribute('aria-current') === 'page',
      node.classList.contains('empty'),
    ])
  /** The number on each tab: how many of its kind are open in the session. */
  const counts = () =>
    [...root.querySelectorAll('.phone-tab')].map(
      (node) => node.querySelector('.phone-tab-count')?.textContent ?? null,
    )
  /** The list of what is open, when it is up: each one's name, and whether it is the one on show. */
  const listed = () =>
    [...root.querySelectorAll('.open-list li')].map((item) => [
      item.querySelector('.open-item').textContent,
      item.classList.contains('on'),
    ])
  const inLibrary = () => root.querySelector('.body > .library') !== null
  const libraryOn = () => root.querySelector('.library .mode-tabs button.on')?.dataset.show
  /** Go to a session, or start one, from the menu in the top bar. */
  const pick = async (name) => {
    click(root.querySelector('.topbar .conv-button'))
    await settle(30)
    const item = [...root.querySelectorAll('.topbar .conv-menu .menu-item')].find((node) =>
      node.textContent.includes(name),
    )
    click(item)
  }

  // The shell knows it is a phone, and the stylesheet hangs off that.
  assert.ok(shell.classList.contains('phone'), shell.className)

  // The top bar is the session's: its name with the menu behind it, and the
  // way to the panel. Not the project, not the library, not a row of tabs.
  assert.equal(root.querySelector('.topbar h1'), null, 'the project has a place in the bar')
  assert.equal(root.querySelector('.topbar [data-action="library"]'), null, 'the library is in the top bar')
  assert.equal(root.querySelector('.topbar .sessions'), null, 'the row of sessions does not fit')
  assert.ok(
    (root.querySelector('.topbar .conv-button')?.textContent ?? '').includes('What does the paper assume?'),
    'the session on screen is not named',
  )
  assert.ok(root.querySelector('.topbar [data-action="about"]'), 'no way to the panel')
  assert.equal(root.querySelector('.topbar .sync-button'), null)
  assert.equal(root.querySelector('.topbar [data-action="sign-out"]'), null)
  // The version is kept an eye on from there — its number is not drawn — and
  // speaks up only when the page has gone stale. It has not.
  assert.ok(root.querySelector('.topbar .version'), 'nothing in the top bar watches the version')
  assert.equal(root.querySelector('.topbar [data-action="reload"]'), null)
  // No panel at the side, no strips to fold things to, no edges to drag.
  assert.equal(root.querySelector('.sidebar'), null)
  assert.equal(root.querySelector('.rail'), null)
  assert.equal(root.querySelector('.chat-splitter, .source-splitter'), null)

  // The bar along the bottom: three tabs, each an icon and a short name, and
  // the library set apart from them.
  const bar = root.querySelector('.phone-bar')
  assert.ok(bar, 'no bar along the bottom')
  assert.deepEqual(
    [...bar.querySelectorAll('.phone-tabs .phone-tab')].map((node) => [
      node.querySelector('.phone-tab-name').textContent,
      node.querySelectorAll('svg').length,
      node.children.length,
    ]),
    [['Notes', 1, 2], ['Papers', 1, 2], ['Chat', 1, 2]],
  )
  const library = bar.querySelector(':scope > [data-action="library"]')
  assert.ok(library, 'the library is not beside the tabs')
  assert.equal(library.closest('.phone-tabs'), null, 'the library is one of the tabs')
  assert.equal(library.getAttribute('aria-label'), 'Library')

  // Nothing is open: the library is what is shown, its button is on, and no
  // tab is. The two with nothing behind them are quieter — and not disabled.
  assert.ok(inLibrary(), 'the library is not where one starts')
  assert.equal(library.getAttribute('aria-pressed'), 'true')
  assert.equal(bar.querySelector('.phone-tabs').dataset.on, 'none')
  assert.deepEqual(tabs(), [['text', false, true], ['paper', false, true], ['chat', false, false]])
  assert.equal(bar.querySelector('[aria-disabled="true"], [disabled]'), null, 'a tab cannot be pressed')
  // All three panes are there already, hidden: each keeps its place from the start.
  assert.deepEqual(panes(), { main: false, source: false, 'chat-drawer': false })

  // An empty pane is a place to open something. Text: a note from the
  // library, on its notes, or a new one.
  click(tab('text'))
  await settle(30)
  assert.equal(inLibrary(), false, 'a tab did not put the library away')
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.equal(bar.querySelector('.phone-tabs').dataset.on, 'text')
  assert.equal(library.getAttribute('aria-pressed'), 'false')
  const noText = root.querySelector('.main .empty-pane')
  assert.equal(noText?.querySelector('p').textContent, 'No note or summary open')
  assert.deepEqual([...noText.querySelectorAll('button')].map((node) => node.textContent), ['Open a note', 'New note'])
  click(noText.querySelector('[data-action="open-from-library"]'))
  await settle(30)
  assert.ok(inLibrary())
  assert.equal(libraryOn(), 'notes', 'the library did not open on the notes')
  // Paper: a paper from the library, on its papers.
  click(tab('paper'))
  await settle(30)
  assert.deepEqual(panes(), { main: false, source: true, 'chat-drawer': false })
  const noPaper = root.querySelector('.source .empty-pane')
  assert.equal(noPaper?.querySelector('p').textContent, 'No paper open')
  assert.deepEqual([...noPaper.querySelectorAll('button')].map((node) => node.textContent), ['Open a paper'])
  click(noPaper.querySelector('[data-action="open-from-library"]'))
  await settle(30)
  assert.equal(libraryOn(), 'papers', 'the library did not open on the papers')
  // The button beside the tabs takes the library away again, and brings it back.
  click(library)
  await settle(30)
  assert.equal(inLibrary(), false)
  click(library)
  await settle(30)
  assert.ok(inLibrary())

  // The chat, with nothing open. It has no header: the session is named in
  // the top bar, there is no edge to fold it to, and the verbatim view is not
  // offered here. The room is the conversation's.
  click(tab('chat'))
  await settle(30)
  assert.equal(inLibrary(), false)
  assert.deepEqual(panes(), { main: false, source: false, 'chat-drawer': true })
  assert.equal(tab('chat').getAttribute('aria-current'), 'page')
  assert.ok(root.querySelector('.chat-drawer .turn'), 'the conversation is not drawn')
  assert.equal(root.querySelector('.chat-head'), null, 'the chat has a header')
  assert.equal(root.querySelector('.view-tabs'), null, 'the transcript is offered')
  assert.equal(root.querySelector('[data-action="hide-chat"]'), null)

  // The message box is folded to a line while the conversation is read; a
  // press on it opens it, with what goes with a message and the buttons.
  const composer = root.querySelector('.chat-drawer .composer')
  const message = composer.querySelector('textarea')
  assert.ok(composer.classList.contains('folded'), 'the message box is not folded')
  assert.equal(message.getAttribute('placeholder'), 'Ask the agent…')
  message.focus()
  await settle(30)
  assert.ok(!composer.classList.contains('folded'), 'a press on the message box did not open it')
  assert.ok(message.getAttribute('placeholder').startsWith('Ask about the papers'))
  // What is typed stays in it when it folds again, at a press anywhere else.
  message.value = 'half a thought'
  message.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle(30)
  composer.querySelector('.composer-actions').dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
  await settle(30)
  assert.ok(!composer.classList.contains('folded'), 'a press inside the message box folded it')
  root.querySelector('.chat-log').dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
  await settle(30)
  assert.ok(composer.classList.contains('folded'), 'a press on the conversation did not fold it')
  assert.equal(message.value, 'half a thought')
  assert.notEqual(window.document.activeElement, message, 'it kept the keyboard')
  // Sent, it folds: what comes next is read.
  message.focus()
  await settle(30)
  click(composer.querySelector('.composer-actions button.primary'))
  await settle(50)
  assert.ok(window.requests.includes('POST /api/conversations/conv-1/messages'), window.requests.join('\n'))
  assert.ok(composer.classList.contains('folded'), 'the message box stayed open after sending')
  assert.equal(message.value, '')
  window.sources.at(-1).emit({ seq: 20, type: 'done', conversation_id: 'conv-1', run_id: 'run-2' })
  await settle(30)
  assert.equal(tab('chat').dataset.sign, undefined, 'a reply read as it arrived was given a dot')

  // A note chosen in the library lands on Text, with the chat still there behind.
  click(tab('text'))
  await settle(30)
  click(root.querySelector('.main [data-action="open-from-library"]'))
  await settle(30)
  click(root.querySelector('.card.note[data-note="welcome"] .card-open'))
  await settle()
  assert.equal(inLibrary(), false)
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.deepEqual(tabs(), [['text', true, false], ['paper', false, true], ['chat', false, false]])
  assert.equal(root.querySelector('.main .empty-pane'), null)
  assert.equal(root.querySelector('.main .editor-title')?.textContent, 'Welcome')
  assert.equal(root.querySelector('.main-head'), null, 'the narrow window\'s "Show the paper" is not the phone\'s')
  // One note is open in the session, and the tab says so; no paper is.
  assert.deepEqual(counts(), ['1', null, null])

  // A press on the tab already on lists what is open there — once the tab has
  // been on a moment. The second press of a double tap is not that.
  click(tab('chat'))
  await settle(10)
  click(tab('text'))
  await settle(10)
  click(tab('text'))
  await settle(30)
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.equal(root.querySelector('.open-list'), null, 'a double tap opened the list')
  await settle(750)
  click(tab('text'))
  await settle(30)
  assert.deepEqual(listed(), [['Welcome', true]], 'the tab already on did not list what is open')
  assert.deepEqual(
    [...root.querySelectorAll('.open-list-foot button')].map((node) => node.textContent),
    ['Open another…', 'New note'],
  )
  // From there, the library on its notes for one that is not open yet.
  click(root.querySelector('.open-list [data-action="open-another"]'))
  await settle(30)
  assert.equal(root.querySelector('.open-list'), null)
  assert.ok(inLibrary())
  assert.equal(libraryOn(), 'notes')
  click(tab('text'))
  await settle(30)
  assert.equal(inLibrary(), false)

  // The session's menu is the row of tabs, folded. It says whose sessions
  // these are, and for each what it holds: going to one is going to the set.
  click(root.querySelector('.topbar .conv-button'))
  await settle(30)
  const menu = root.querySelector('.topbar .conv-menu')
  assert.ok(menu, 'no menu of sessions')
  assert.equal(menu.querySelector('.menu-project')?.textContent, 'Demo')
  const held = (node) => [...node.querySelectorAll('.menu-holds .held')].map((item) => item.textContent)
  assert.deepEqual(held(menu.querySelector('.conv-current')), ['Welcome'])
  const others = [...menu.querySelectorAll('.menu-item')].filter((item) => item.querySelector('.menu-holds'))
  assert.deepEqual(
    others.map((item) => [item.querySelector('.menu-label').textContent, held(item)]),
    [['The other line of work', ['Summary', 'A Paper']]],
  )
  assert.ok((menu.textContent ?? '').includes('New session'), menu.textContent)
  assert.ok([...menu.querySelectorAll('.conv-actions .link')].some((node) => node.textContent === 'Rename'))
  click(root.querySelector('.topbar .conv-button'))
  await settle(30)

  // Going to the other session changes the panes, not only the conversation:
  // its text is the one on show, and there is a paper behind Paper.
  await pick('The other line of work')
  await settle(300)
  assert.ok((root.querySelector('.topbar .conv-button')?.textContent ?? '').includes('The other line of work'))
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.deepEqual(tabs(), [['text', true, false], ['paper', false, false], ['chat', false, false]])
  assert.equal(root.querySelector('.main .editor-title')?.textContent, 'Summary — A Paper')
  assert.equal(root.querySelector('.source .pdf-title')?.textContent, 'A Paper', 'the paper is not named on its pane')
  assert.equal(root.querySelector('.source .empty-pane'), null)
  assert.equal(root.querySelector('.source > .back'), null, 'the narrow window\'s way back is not the phone\'s')
  click(tab('paper'))
  await settle(30)
  // And back: the first session's text, nothing behind Paper, on the tab it was left on.
  await pick('What does the paper assume?')
  await settle(300)
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.deepEqual(tabs(), [['text', true, false], ['paper', false, true], ['chat', false, false]])
  assert.equal(root.querySelector('.main .editor-title')?.textContent, 'Welcome')
  await pick('The other line of work')
  await settle(300)
  assert.deepEqual(panes(), { main: false, source: true, 'chat-drawer': false }, 'not on the tab it was left on')
  await pick('What does the paper assume?')
  await settle(300)

  // The panel is a sheet: what the note is, its contents, what it is tied
  // to — and, at its foot, what a wide window keeps at the end of the top bar.
  click(root.querySelector('[data-action="about"]'))
  await settle(50)
  const sheet = root.querySelector('.sheet')
  assert.ok(sheet, 'no sheet')
  assert.equal(sheet.querySelector('.about strong')?.textContent, 'Welcome')
  assert.deepEqual(
    [...sheet.querySelectorAll('.toc button')].map((node) => node.textContent),
    ['Welcome', 'Further down'],
  )
  assert.ok((sheet.querySelector('.sheet-foot .sync-button')?.textContent ?? '').includes('2 to save'))
  assert.equal(sheet.querySelector('.sheet-foot [data-action="sign-out"]')?.textContent, 'Sign out')
  assert.equal(sheet.querySelector('.sheet-foot .version-number')?.textContent, 'v0.3.8')
  // An entry does what it does, and the sheet is put away.
  click([...sheet.querySelectorAll('.related button')][0])
  await settle()
  assert.equal(root.querySelector('.sheet'), null, 'the sheet stayed up')
  // A paper: its summary on Text, the PDF behind the Paper tab.
  assert.deepEqual(panes(), { main: true, source: false, 'chat-drawer': false })
  assert.deepEqual(tabs(), [['text', true, false], ['paper', false, false], ['chat', false, false]])

  // Two texts are open in the session now, and a paper. The list has them in
  // the order they were opened, goes to either, and closes them.
  assert.deepEqual(counts(), ['2', '1', null])
  await settle(750)
  click(tab('text'))
  await settle(30)
  assert.deepEqual(listed(), [['Welcome', false], ['Summary — A Paper', true]])
  click(root.querySelector('.open-list li:first-child .open-item'))
  await settle()
  assert.equal(root.querySelector('.open-list'), null, 'the list stayed up')
  assert.equal(root.querySelector('.main .editor-title')?.textContent, 'Welcome')
  assert.deepEqual(counts(), ['2', '1', null], 'going to one closed another')
  // Closing the one on show goes to the one beside it; nothing is deleted.
  await settle(750)
  click(tab('text'))
  await settle(30)
  assert.deepEqual(listed(), [['Welcome', true], ['Summary — A Paper', false]])
  click(root.querySelector('.open-list li.on .open-close'))
  await settle()
  assert.equal(root.querySelector('.main .editor-title')?.textContent, 'Summary — A Paper')
  assert.deepEqual(listed(), [['Summary — A Paper', true]])
  assert.deepEqual(counts(), ['1', '1', null])
  assert.ok(!window.requests.some((request) => request.startsWith('DELETE')), 'closing deleted something')
  // The paper's own list; closing the only paper leaves the tab with nothing behind it.
  click(tab('paper'))
  await settle(800)
  click(tab('paper'))
  await settle(30)
  assert.deepEqual(listed(), [['A Paper', true]])
  click(root.querySelector('.open-list .open-close'))
  await settle()
  assert.deepEqual(counts(), ['1', null, null])
  assert.deepEqual(tabs(), [['text', true, false], ['paper', false, true], ['chat', false, false]])
  // Opened again from the panel, it is open again.
  click(root.querySelector('[data-action="about"]'))
  await settle(50)
  click([...root.querySelectorAll('.sheet .entry-actions .link')].find((node) => node.textContent === 'Read PDF'))
  await settle()
  assert.equal(root.querySelector('.sheet'), null)
  assert.deepEqual(counts(), ['1', '1', null])
  assert.deepEqual(panes(), { main: false, source: true, 'chat-drawer': false })
  // The sheet is put away by its own button, and by a press outside it.
  click(root.querySelector('[data-action="about"]'))
  await settle(30)
  click(root.querySelector('[data-action="close-about"]'))
  await settle(30)
  assert.equal(root.querySelector('.sheet'), null)
  click(root.querySelector('[data-action="about"]'))
  await settle(30)
  click(root.querySelector('.sheet .about'))
  await settle(30)
  assert.ok(root.querySelector('.sheet'), 'a press inside the sheet put it away')
  click(root.querySelector('.sheet-backdrop'))
  await settle(30)
  assert.equal(root.querySelector('.sheet'), null)

  // A run under way is said on the Chat tab, quietly, on its icon…
  const list = routes.get('/api/conversations').conversations
  const running = (status) =>
    list.map((c) => (c.conversation_id === 'conv-1' ? { ...c, status } : c))
  routes.set('/api/conversations', { conversations: running('running') })
  window.sources.at(-1).emit({ seq: 21, type: 'run_started', conversation_id: 'conv-1', run_id: 'run-3' })
  await settle(300)
  assert.equal(tab('chat').dataset.sign, 'working')
  assert.ok(tab('chat').querySelector('.phone-tab-icon .phone-tab-sign.working'), 'no sign of work on the icon')
  assert.ok(tab('chat').getAttribute('aria-label').includes('working'))
  // …and a reply that came in while the paper was being read leaves a dot there.
  routes.set('/api/conversations', { conversations: running('idle') })
  window.sources.at(-1).emit({ seq: 22, type: 'done', conversation_id: 'conv-1', run_id: 'run-3' })
  await settle(300)
  assert.equal(tab('chat').dataset.sign, 'answered')
  assert.ok(tab('chat').querySelector('.phone-tab-icon .phone-tab-sign.answered'), 'no dot on the icon')
  assert.deepEqual(panes(), { main: false, source: true, 'chat-drawer': false }, 'the reader was moved')
  // Looking at the chat is what clears it.
  click(tab('chat'))
  await settle(30)
  assert.equal(tab('chat').dataset.sign, undefined)

  // A new session has nothing in it yet: the library is what is shown.
  await pick('New session')
  await settle(300)
  assert.equal(root.querySelector('.topbar .conv-menu'), null)
  assert.ok(inLibrary(), 'a new session did not start at the library')
  assert.deepEqual(tabs(), [['text', false, true], ['paper', false, true], ['chat', false, false]])
  assert.ok(window.location.pathname.startsWith('/s/conv-'), window.location.pathname)
  // Which tab was on is this window's business: it is no part of the saved view.
  await settle(900)
  const saved = routes.get('/api/conversations').conversations.find((c) => c.conversation_id === 'conv-1')
  // What is open in the session is.
  assert.deepEqual(Object.keys(saved.view ?? {}).sort(), ['attached', 'documentId', 'library', 'page', 'papers', 'target', 'texts'])
  assert.deepEqual(saved.view.texts, [{ kind: 'summary', documentId: 'doc-001' }])
  assert.deepEqual(saved.view.papers, ['doc-001'])

  assert.deepEqual(errors, [], `runtime errors: ${errors.map((e) => e?.stack ?? e).join('\n')}`)
})

test('a tablet held upright has the one-pane layout; on its side, the panes side by side', async (t) => {
  const bundle = readFileSync(join(here, 'bundle', 'app.mjs'), 'utf8')
  const at = async (width, height = 0, touch = false) => {
    const dom = buildDom({ routes: new Map(ROUTES), width, height, touch })
    t.after(() => dom.window.close())
    dom.window.eval(bundle)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const root = dom.window.document.getElementById('app')
    return {
      phone: root.querySelector('.shell').classList.contains('phone'),
      bar: root.querySelector('.phone-bar') !== null,
      sessions: root.querySelector('.topbar .sessions') !== null,
      sidebar: root.querySelector('.body > .sidebar') !== null,
    }
  }
  const onePane = { phone: true, bar: true, sessions: false, sidebar: false }
  const sideBySide = { phone: false, bar: false, sessions: true, sidebar: true }
  // An iPad upright, and the last width on that side of the cutoff.
  assert.deepEqual(await at(820, 1180, true), onePane)
  assert.deepEqual(await at(899), onePane)
  // The cutoff itself, and an iPad on its side.
  assert.deepEqual(await at(900), sideBySide)
  assert.deepEqual(await at(1180, 820, true), sideBySide)
  // A large iPad is as wide upright as a small one on its side: upright it
  // has the one pane, and the small one on its side has not.
  assert.deepEqual(await at(1024, 1366, true), onePane)
  assert.deepEqual(await at(1024, 768, true), sideBySide)
  assert.deepEqual(await at(1366, 1024, true), sideBySide)
  // A window of that shape on a desk, worked by a mouse, is left as it was.
  assert.deepEqual(await at(1024, 1366, false), sideBySide)
})
