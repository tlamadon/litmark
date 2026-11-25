/**
 * Tests for the fold that turns a run's events into a turn.
 *
 * The same function draws a conversation read back from the server and one
 * followed live, so what matters is that the two agree: a turn rebuilt from
 * its durable events is the turn the live stream produced, and a replayed or
 * out-of-place event changes nothing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeChange,
  describeOrigin,
  describeTool,
  pageRange,
  transcriptOf,
} from './bundle/chat/describe.mjs'
import { applyEvent, foldEvent, latestSeq, turnFromRecord } from './bundle/chat/turns.mjs'

const NAMES = {
  document: (id) => ({ 'doc-001': 'Mobility Restrictions' })[id] ?? id,
  note: (id) => ({ findings: 'Findings' })[id] ?? id,
}

let seq = 0
const durable = (type, payload = {}) => ({
  seq: ++seq,
  type,
  conversation_id: 'conv-1',
  run_id: 'run-1',
  ...payload,
})
const fragment = (text, offset) => ({
  type: 'text_delta',
  conversation_id: 'conv-1',
  run_id: 'run-1',
  transient: true,
  partial: true,
  text,
  offset,
})

function live(events) {
  return events.reduce((turns, event) => applyEvent(turns, event), [])
}

test('a turn followed live and the same turn read back are the same turn', () => {
  seq = 0
  const events = [
    durable('message_added', { role: 'user', content: 'Compare them', context: { document_ids: ['doc-001'] } }),
    durable('run_started', { kind: 'chat' }),
    durable('tool_started', { tool: 'read_pages', tool_use_id: 'a', input: { document_id: 'doc-001', pages: [3, 4] } }),
    durable('tool_finished', { tool: 'read_pages', tool_use_id: 'a', result: { pages: [{}, {}] } }),
    fragment('They dif', 0),
    fragment('fer.', 8),
    durable('text_delta', { text: 'They differ.', final: true }),
    durable('file_changed', { change_id: 'chg-1', target_kind: 'note', target_id: 'findings', summary: 'Patched note' }),
    durable('done', { terminal_reason: 'endTurn', status: 'succeeded', usage: { num_turns: 2 } }),
    durable('message_added', { role: 'assistant', content: 'They differ.' }),
  ]
  const [followed] = live(events)

  const record = {
    run_id: 'run-1',
    status: 'succeeded',
    kind: 'chat',
    label: null,
    error: null,
    usage: { num_turns: 2 },
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    message: { content: 'Compare them', context: { document_ids: ['doc-001'] }, created_at: '2026-01-01T00:00:00Z' },
    reply: 'They differ.',
    events: events.filter((event) => !event.transient),
  }
  const readBack = turnFromRecord(record)

  assert.deepEqual(readBack.entries, followed.entries)
  assert.equal(readBack.status, 'succeeded')
  assert.equal(followed.status, 'succeeded')
  assert.equal(readBack.prompt, 'Compare them')
  assert.equal(followed.streaming, '')
  assert.deepEqual(
    followed.entries.map((entry) => entry.kind),
    ['tool', 'text', 'change'],
  )
  // The reply is not added a second time from the saved message.
  assert.equal(readBack.entries.filter((entry) => entry.kind === 'text').length, 1)
  assert.equal(latestSeq([record]), seq)
})

test('fragments show the reply as it is written, and the block replaces them', () => {
  seq = 0
  let turns = live([durable('run_started'), fragment('Half a ', 0), fragment('sentence', 7)])
  assert.equal(turns[0].streaming, 'Half a sentence')
  turns = applyEvent(turns, durable('text_delta', { text: 'Half a sentence.', final: true }))
  assert.equal(turns[0].streaming, '')
  assert.deepEqual(turns[0].entries, [{ kind: 'text', text: 'Half a sentence.' }])
})

test('a missed fragment hides the block rather than showing text with a hole', () => {
  seq = 0
  let turns = live([durable('run_started'), fragment('The first ', 0), fragment('third part', 21)])
  assert.equal(turns[0].streaming, '')
  assert.equal(turns[0].streamBroken, true)
  // Later fragments of the same block are not shown either…
  turns = applyEvent(turns, fragment(' and more', 31))
  assert.equal(turns[0].streaming, '')
  // …until the block arrives whole, and the next one streams normally.
  turns = applyEvent(turns, durable('text_delta', { text: 'The first second third part and more', final: true }))
  assert.equal(turns[0].streamBroken, false)
  turns = applyEvent(turns, fragment('Next', 0))
  assert.equal(turns[0].streaming, 'Next')
})

test('a turn opened mid-reply waits for the block instead of guessing', () => {
  seq = 0
  const record = {
    run_id: 'run-1',
    status: 'running',
    kind: 'chat',
    label: null,
    error: null,
    usage: null,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    message: { content: 'Go on', context: null, created_at: '2026-01-01T00:00:00Z' },
    reply: null,
    events: [durable('run_started')],
  }
  let turns = [turnFromRecord(record)]
  assert.equal(turns[0].status, 'running')
  turns = applyEvent(turns, fragment('tail of a block', 140))
  assert.equal(turns[0].streaming, '')
  turns = applyEvent(turns, durable('text_delta', { text: 'A whole block.', final: true }))
  assert.deepEqual(turns[0].entries, [{ kind: 'text', text: 'A whole block.' }])
})

test('an event delivered twice is folded once', () => {
  seq = 0
  const begun = durable('run_started')
  const started = durable('tool_started', { tool: 'list_notes', tool_use_id: 'a', input: {} })
  const turns = live([begun, started, started, { ...started }])
  assert.equal(turns[0].entries.length, 1)
  assert.equal(foldEvent(turns[0], started), turns[0], 'a replay returns the same turn')
})

test('how a run ended comes from its last event, and from its row on reload', () => {
  seq = 0
  const stopped = live([
    durable('run_started'),
    fragment('Unfinis', 0),
    durable('text_delta', { text: 'Unfinis', final: true, unfinished: true }),
    durable('done', { terminal_reason: 'cancelled', status: 'cancelled' }),
  ])[0]
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.entries[0].unfinished, true)

  const failed = live([
    durable('run_started'),
    durable('error', { message: 'Rate limited.' }),
    durable('done', { terminal_reason: 'error' }),
  ])[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'Rate limited.')

  // Interrupted by a restart: the row says so even though no `done` was seen
  // before the process stopped.
  const interrupted = turnFromRecord({
    run_id: 'run-9',
    status: 'interrupted',
    kind: 'chat',
    label: null,
    error: 'The server restarted while this run was in progress.',
    usage: null,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    message: { content: 'A question', context: null, created_at: '2026-01-01T00:00:00Z' },
    reply: null,
    events: [],
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.match(interrupted.error, /restarted/)
})

test('a refusal by a project tool is a failed step', () => {
  seq = 0
  const [turn] = live([
    durable('run_started'),
    durable('tool_started', { tool: 'patch_note', tool_use_id: 'a', input: { note_id: 'findings' } }),
    durable('tool_finished', {
      tool: 'patch_note',
      tool_use_id: 'a',
      is_error: false,
      result: { ok: false, error: 'revision_conflict', message: 'The note changed since you read it.' },
    }),
  ])
  const step = describeTool(turn.entries[0], NAMES)
  assert.equal(turn.entries[0].isError, true)
  assert.equal(step.tone, 'bad')
  assert.match(step.detail, /changed since you read it/)
  assert.equal(step.target, 'note “Findings”')
})

test('a reply recorded before runs kept their events is still shown', () => {
  const turn = turnFromRecord({
    run_id: 'run-old',
    status: 'succeeded',
    kind: 'chat',
    label: null,
    error: null,
    usage: null,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    message: { content: 'An old question', context: null, created_at: '2026-01-01T00:00:00Z' },
    reply: 'An old answer.',
    events: [],
  })
  assert.deepEqual(turn.entries, [{ kind: 'text', text: 'An old answer.' }])
})

test('steps are described in the terms of the project, and say what they open', () => {
  const read = describeTool(
    { kind: 'tool', id: 'a', tool: 'read_pages', input: { document_id: 'doc-001', pages: [5, 3, 4, 9] }, result: {}, finished: true, isError: false },
    NAMES,
  )
  assert.equal(read.verb, 'read')
  assert.equal(read.target, 'Mobility Restrictions, pp. 3–5, 9')
  assert.deepEqual(read.open, { kind: 'document', documentId: 'doc-001', page: 3 })

  const cited = describeTool(
    {
      kind: 'tool',
      id: 'b',
      tool: 'resolve_source',
      input: { document_id: 'doc-001', page_number: 12, quote: 'a mobility restriction' },
      result: { status: 'resolved', reference_id: 'ref-007', quote: 'a mobility restriction' },
      finished: true,
      isError: false,
    },
    NAMES,
  )
  assert.equal(cited.verb, 'cited')
  assert.deepEqual(cited.open, { kind: 'reference', referenceId: 'ref-007' })

  const missed = describeTool(
    {
      kind: 'tool',
      id: 'c',
      tool: 'resolve_source',
      input: { document_id: 'doc-001', page_number: 12, quote: 'not on the page' },
      result: { status: 'not_found', message: 'No passage matched.' },
      finished: true,
      isError: false,
    },
    NAMES,
  )
  assert.equal(missed.tone, 'warn')
  assert.equal(missed.verb, 'could not locate')
  assert.deepEqual(missed.open, { kind: 'document', documentId: 'doc-001', page: 12 })

  assert.equal(pageRange([7]), 'p. 7')
  assert.equal(pageRange([]), '')
})

test('the transcript shows every step verbatim, arguments included', () => {
  seq = 0
  const [turn] = live([
    durable('message_added', { role: 'user', content: 'Find it' }),
    durable('run_started'),
    durable('tool_started', { tool: 'search_documents', tool_use_id: 'a', input: { query: 'mobility' } }),
    durable('tool_finished', { tool: 'search_documents', tool_use_id: 'a', result: { count: 4 } }),
    durable('text_delta', { text: 'Four passages.', final: true }),
    durable('done', { terminal_reason: 'endTurn', status: 'succeeded', usage: { num_turns: 2, duration_ms: 1500 } }),
  ])
  const text = transcriptOf(turn)
    .map((line) => line.text)
    .join('\n')
  assert.match(text, /› Find it/)
  assert.match(text, /⏵ search_documents\n {4}query: mobility\n {2}⎿ 4 found/)
  assert.match(text, /● Four passages\./)
  assert.match(text, /succeeded · 2 steps · 1\.5s/)
})

test('steps about tags say which papers and which tags', () => {
  const tool = (name, input, result = {}) => ({
    kind: 'tool', id: 'x', tool: name, input, result, finished: true, isError: false,
  })
  const tagged = describeTool(
    tool('tag_documents', { document_ids: ['doc-001', 'doc-002'], add: ['field:labor'], remove: ['old'] }),
    NAMES,
  )
  assert.equal(tagged.verb, 'tagged')
  assert.equal(tagged.target, '2 papers — +field:labor, −old')
  assert.equal(tagged.tone, 'ok')

  const one = describeTool(tool('tag_documents', { document_ids: ['doc-001'], add: ['jmp:2026'] }), NAMES)
  assert.equal(one.target, 'Mobility Restrictions — +jmp:2026')
  assert.deepEqual(one.open, { kind: 'document', documentId: 'doc-001', page: 1 })

  const listed = describeTool(tool('list_documents', { tags: ['jmp:2026'] }, { count: 12 }), NAMES)
  assert.equal(listed.target, 'papers tagged jmp:2026 — 12 papers')
  const searched = describeTool(
    tool('search_documents', { query: 'minimum wage', tags: ['field:labor'] }, { count: 3 }),
    NAMES,
  )
  assert.equal(searched.target, '“minimum wage” in papers tagged field:labor — 3 matches')
})

test('recalling and adding to a note read as what they are', () => {
  const tool = (name, input, result = {}) => ({
    kind: 'tool', id: 'x', tool: name, input, result, finished: true, isError: false,
  })
  const recalled = describeTool(tool('recall', { query: 'mobility restrictions' }, { count: 4 }), NAMES)
  assert.equal(recalled.verb, 'recalled')
  assert.equal(recalled.target, '“mobility restrictions” — 4 things found')

  const added = describeTool(
    tool('append_note', { note_id: 'welcome', text: 'x' }, { ok: true, title: 'Welcome' }),
    NAMES,
  )
  assert.equal(added.verb, 'added to')
  assert.equal(added.target, 'note “Welcome”')
  assert.deepEqual(added.open, { kind: 'note', noteId: 'welcome' })

  const made = describeTool(
    tool('append_note', { note_id: 'log', text: 'x' }, { ok: true, created: true, title: 'Log' }),
    NAMES,
  )
  assert.equal(made.verb, 'created')
})

test('what was learned about summarizing is said as that, and opens the skill', () => {
  const tool = (name, input, result = {}, isError = false) => ({
    kind: 'tool', id: 'x', tool: name, input, result, finished: true, isError,
  })
  const read = describeTool(tool('read_skill', {}, { text: '…' }), NAMES)
  assert.deepEqual([read.verb, read.target], ['read', 'how you want papers summarized'])
  assert.deepEqual(read.open, { kind: 'skill' })

  const learned = describeTool(
    tool('write_skill', { text: '…', learned: 'Summaries lead with the identification strategy.' }, { ok: true }),
    NAMES,
  )
  assert.deepEqual(
    [learned.verb, learned.tone, learned.target],
    ['learned', 'ok', 'Summaries lead with the identification strategy.'],
  )
  assert.deepEqual(learned.open, { kind: 'skill' })
  const refused = describeTool(
    tool('write_skill', { text: '…', learned: 'x' }, { ok: false, message: 'Read it again.' }, true),
    NAMES,
  )
  assert.deepEqual([refused.verb, refused.detail], ['learned — refused', 'Read it again.'])

  // The change it made is listed under the turn as what it is, not as a note.
  const turn = foldEvent(
    turnFromRecord({ run_id: 'run-9', status: 'running', kind: 'chat', events: [] }),
    { seq: 1, type: 'file_changed', run_id: 'run-9', change_id: 'chg-9', target_kind: 'skill', target_id: 'summary', summary: 'Learned: shorter.' },
  )
  const change = turn.entries.find((entry) => entry.kind === 'change')
  assert.equal(change.targetKind, 'skill')
  const described = describeChange(change, NAMES)
  assert.deepEqual(
    [described.verb, described.target, described.detail],
    ['learned', 'how you want papers summarized', 'Learned: shorter.'],
  )
  assert.deepEqual(described.open, { kind: 'skill' })
})

test('an edit says who made it, and whether that was from outside', () => {
  assert.deepEqual(
    [describeOrigin('user').label, describeOrigin('agent').label],
    ['you', 'Litmark'],
  )
  const outside = describeOrigin('mcp:claude-code')
  assert.equal(outside.label, 'claude-code')
  assert.equal(outside.outside, true)
  assert.match(outside.title, /over MCP/)
  assert.equal(describeOrigin('user').outside, false)
})

test('a request to download waits in the turn, then shows how it was settled', () => {
  let turns = []
  const run = { run_id: 'run-ask', conversation_id: 'conv-1' }
  for (const event of [
    durable('run_started', { ...run }),
    durable('tool_started', {
      ...run,
      tool: 'download_paper',
      tool_use_id: 't1',
      input: { url: 'https://arxiv.org/pdf/2401.01234' },
    }),
    durable('permission_requested', {
      ...run,
      request_id: 'ask-1',
      url: 'https://arxiv.org/pdf/2401.01234',
      host: 'arxiv.org',
    }),
  ]) {
    turns = applyEvent(turns, event)
  }
  const waiting = turns[0].entries.at(-1)
  assert.equal(waiting.kind, 'permission')
  assert.equal(waiting.answer, null)
  assert.equal(describeTool(turns[0].entries[0], NAMES).verb, 'downloading')

  turns = applyEvent(turns, durable('permission_resolved', { ...run, request_id: 'ask-1', answer: 'deny' }))
  assert.equal(turns[0].entries.at(-1).answer, 'deny')
  // An answer to a request this turn never made changes nothing.
  const same = applyEvent(turns, durable('permission_resolved', { ...run, request_id: 'ask-9', answer: 'allow' }))
  assert.equal(same[0].entries.at(-1).answer, 'deny')
})
