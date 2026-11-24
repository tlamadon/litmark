/**
 * The headings of a note: what the panel lists as its contents, and what the
 * editor goes to. Both read them the same way, so they agree on which is which.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { headingsOf } from './bundle/outline.mjs'

test('headings are listed with their depth and the line they are on', () => {
  const text = ['# Findings', '', 'Prose.', '', '## Data ##', '### The *linked* [records](source:ref-001)', '', '#hashtag, not a heading'].join('\n')
  assert.deepEqual(headingsOf(text), [
    { level: 1, text: 'Findings', line: 1 },
    { level: 2, text: 'Data', line: 5 },
    { level: 3, text: 'The linked records', line: 6 },
  ])
  assert.deepEqual(headingsOf('No headings here.'), [])
})

test('a hash inside a code block is a comment, not a heading', () => {
  const text = ['# Real', '', '```python', '# a comment', '```', '', '~~~', '## also code', '~~~', '', '## After'].join('\n')
  assert.deepEqual(
    headingsOf(text).map((heading) => heading.text),
    ['Real', 'After'],
  )
})
