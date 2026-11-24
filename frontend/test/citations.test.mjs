/**
 * Where a reference is cited in a note: what a click on a highlight goes to.
 *
 * The syntax tree decides what is a citation. The same text inside a code
 * block is an example of the syntax, and a note opened in order to go to a
 * citation has not been parsed to its end by the editor yet — which is the
 * case that once made a citation far down a long note unfindable.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'

import { citationsOf } from './bundle/editor/livePreview.mjs'

const stateOf = (doc) =>
  EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, codeLanguages: [] })] })

const textAt = (state, spots) => spots.map((spot) => state.doc.sliceString(spot.from, spot.to))

test('every citation of a reference is found, in order, and no other', () => {
  const state = stateOf(
    [
      '# Findings',
      '',
      'A claim [p. 2](source:ref-001) and another [p. 9](source:ref-002).',
      '',
      'Later, the first again [Assumption 2, p. 2](source:ref-001), and [a near miss](source:ref-0011).',
    ].join('\n'),
  )
  assert.deepEqual(textAt(state, citationsOf(state, 'ref-001')), [
    '[p. 2](source:ref-001)',
    '[Assumption 2, p. 2](source:ref-001)',
  ])
  assert.deepEqual(textAt(state, citationsOf(state, 'ref-002')), ['[p. 9](source:ref-002)'])
  assert.deepEqual(citationsOf(state, 'ref-404'), [])
})

test('the syntax shown as an example in a code block is not a citation', () => {
  const state = stateOf(
    ['Like this:', '', '```markdown', '[example](source:ref-001)', '```', '', 'Really: [p. 2](source:ref-001).'].join('\n'),
  )
  assert.deepEqual(textAt(state, citationsOf(state, 'ref-001')), ['[p. 2](source:ref-001)'])
  assert.deepEqual(textAt(state, citationsOf(stateOf('Inline `[x](source:ref-001)` only.'), 'ref-001')), [])
})

test('a citation far down a long note is found before the editor has parsed that far', () => {
  const filler = Array.from({ length: 4000 }, (_unused, i) => `Paragraph ${i} of ordinary prose.`).join('\n\n')
  const state = stateOf(`# Long\n\n${filler}\n\nAt the very end [p. 2](source:ref-001).\n`)
  const [spot] = citationsOf(state, 'ref-001')
  assert.ok(spot, 'the citation at the end of a long note was not found')
  assert.ok(spot.from > 100000, `expected a position far into the note, got ${spot.from}`)
  assert.equal(state.doc.sliceString(spot.from, spot.to), '[p. 2](source:ref-001)')
})
