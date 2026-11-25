/**
 * The editor draws a note, whatever is in it.
 *
 * A note is written by agents as well as by hand, and a citation's label is a
 * quotation from a paper: it runs over line breaks where the paper's lines
 * break, and holds brackets where the paper's formulas do. Each of these once
 * left the note blank, or the citation shown as the characters it is written
 * with. The editor is mounted here for real, in a DOM, because the failure was
 * thrown while drawing, not while deciding what to draw.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

let EditorState
let EditorView
let preview
let ViewPlugin
let Decoration
let mountResilientEditor

const GLOBALS = [
  'window',
  'document',
  'MutationObserver',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]
const previous = {}

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true,
  })
  for (const key of GLOBALS) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
  }
  previous.navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  // CodeMirror looks at the browser it is in as it loads: after the DOM is there.
  ;({ EditorState } = await import('@codemirror/state'))
  ;({ EditorView, ViewPlugin, Decoration } = await import('@codemirror/view'))
  ;({ mountResilientEditor } = await import('./bundle/editor/mount.mjs'))
  preview = await import('./bundle/editor/livePreview.mjs')
})

after(() => {
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

/** Mount a note for reading, hand it to `check`, and take it down again. */
function reading(doc, check) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [preview.noteMarkdown(), preview.livePreview({ reading: true })],
    }),
    parent: document.getElementById('host'),
  })
  try {
    return check(view)
  } finally {
    view.destroy()
  }
}

const citations = (view) =>
  [...view.contentDOM.querySelectorAll('.cm-source-link')].map((link) => link.textContent)

test('a citation whose quotation runs over a line break is drawn as one link', () => {
  const doc =
    'AKM fits them alike — [the fit of the AKM model—is\nsimilar in the all-mover sample.](source:ref-455) So.\n'
  reading(doc, (view) => {
    assert.deepEqual(citations(view), ['the fit of the AKM model—is similar in the all-mover sample.'])
    assert.equal(
      view.contentDOM.textContent,
      'AKM fits them alike — the fit of the AKM model—is similar in the all-mover sample. So.',
    )
    // And the text as written is still all there, to be shown as source.
    view.dispatch({ effects: preview.setSourceMode.of(true) })
    assert.equal(view.state.doc.toString(), doc)
    assert.match(view.contentDOM.textContent, /\]\(source:ref-455\)/)
  })
})

test('an equation set over several lines is drawn, and so is inline math broken over two', () => {
  reading('Before\n\n$$\na = b\n$$\n\nAfter, inline $c +\nd$ too.\n', (view) => {
    assert.equal(view.contentDOM.querySelectorAll('.cm-math-display .katex').length, 1)
    assert.equal(view.contentDOM.querySelectorAll('.cm-math .katex').length, 2)
    assert.doesNotMatch(view.contentDOM.textContent, /\$/)
  })
})

test('a citation whose quotation holds brackets is still a link', () => {
  const doc = [
    'Kills the term — [a function of f, E[g ∆f|G, f] = ∆fE[g |G, f] = 0 by (A17).](source:ref-430) — and',
    'the assumption [E\\[˜ϵ ˜ϵ |G, α\\] = 0, for all ℓ ≥ 1.](source:ref-385) holds; see [Table 2](source:ref-001).',
  ].join('\n')
  reading(doc, (view) => {
    assert.deepEqual(citations(view), [
      'a function of f, E[g ∆f|G, f] = ∆fE[g |G, f] = 0 by (A17).',
      'E[˜ϵ ˜ϵ |G, α] = 0, for all ℓ ≥ 1.',
      'Table 2',
    ])
    assert.doesNotMatch(view.contentDOM.textContent, /source:/)
    for (const id of ['ref-430', 'ref-385', 'ref-001']) {
      assert.equal(preview.citationsOf(view.state, id).length, 1, `${id} was not found where it is cited`)
    }
  })
})

test('brackets that are not a link stay text, and the links beside them stay links', () => {
  reading('An interval [0, 1] and a set [a] beside [p. 2](source:ref-001) and [site](https://example.org).\n', (view) => {
    assert.equal(view.contentDOM.textContent, 'An interval [0, 1] and a set [a] beside p. 2 and site.')
    assert.deepEqual(citations(view), ['p. 2'])
    assert.equal(view.contentDOM.querySelectorAll('.cm-link').length, 1)
  })
})

test('editing, the cursor inside a citation over two lines shows it as written', () => {
  const doc = 'See [first line\nsecond line](source:ref-002) here.\n'
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 8 },
      extensions: [preview.noteMarkdown(), preview.livePreview({ reading: false })],
    }),
    parent: document.getElementById('host'),
  })
  try {
    assert.match(view.contentDOM.textContent, /\[first line/)
    assert.equal(preview.sourceReferenceAt(view.state, 8), 'ref-002')
    // Moved away, it is a link again.
    view.dispatch({ selection: { anchor: doc.length } })
    assert.deepEqual(citations(view), ['first line second line'])
  } finally {
    view.destroy()
  }
})

test('a number set as math is drawn as math, and money stays money', () => {
  reading('The slope is $0.758$ for movers, $N = 3.4$m.\n\nIt cost $5 and then $7 later, or $5-$7.\n', (view) => {
    assert.equal(view.contentDOM.querySelectorAll('.cm-math .katex').length, 2)
    const text = view.contentDOM.textContent
    assert.match(text, /It cost \$5 and then \$7 later, or \$5-\$7\./)
    assert.doesNotMatch(text, /\$0\.758\$/)
  })
})

test('whatever a note holds, wherever it holds it, the editor draws it and keeps the text', () => {
  // What agents and people actually write, each piece put where Markdown lets
  // it be put, and each next to every other. None of it may blank the note.
  const pieces = [
    '[a quotation that\nruns on](source:ref-001)',
    '[E[g|G, f] = 0 by (A17).](source:ref-002)',
    '[E\\[x\\] = 0, for all ℓ ≥ 1.](source:ref-003)',
    '[unclosed [bracket](source:ref-004)',
    '[closed] bracket](source:ref-005)',
    '[](source:ref-006)',
    '[a paper](paper:doc-001)',
    '[**bold** and $x_i$ inside](source:ref-007)',
    '$a +\nb$',
    '$$\n\\frac{a}{b}\n$$',
    '$$x$$',
    '$0.758$',
    '$5 and then $7',
    '$\\broken{',
    '**strong\nover two lines**',
    '*em* `code [x](source:ref-008)` ~~gone~~',
    '`code\nover lines`',
    '![image](https://example.org/x.png)',
    '<span>html</span>',
    'a | b\n--- | ---\n[q\nr](source:ref-009) | $y$',
    '\\$ not math \\[ not a link \\]',
    ']( stray ) [ $',
  ]
  const contexts = [
    (text) => text,
    (text) => `Before ${text} after.`,
    (text) => `- item ${text}\n- next`,
    (text) => `  1. numbered ${text}\n     continued`,
    (text) => `> quoted ${text}`,
    (text) => `## Heading ${text}`,
    (text) => `| a | b |\n| --- | --- |\n| ${text.replace(/\n/g, ' ')} | c |`,
    (text) => '```\n' + text + '\n```',
  ]
  let mounted = 0
  for (const context of contexts) {
    for (const [index, piece] of pieces.entries()) {
      // Each piece with its neighbour, so what one leaves open meets the next.
      const doc = `# Note\n\n${context(piece)}\n\n${context(pieces[(index + 1) % pieces.length])}\n`
      for (const isReading of [true, false]) {
        const view = new EditorView({
          state: EditorState.create({
            doc,
            extensions: [preview.noteMarkdown(), preview.livePreview({ reading: isReading })],
          }),
          parent: document.getElementById('host'),
        })
        try {
          // The cursor walked through it, which opens each piece up in turn.
          for (let at = 0; at <= doc.length; at += 3) view.dispatch({ selection: { anchor: at } })
          view.dispatch({ effects: preview.setSourceMode.of(true) })
          assert.equal(view.state.doc.toString(), doc)
          assert.ok(view.contentDOM.textContent.length > 0, `nothing drawn for ${JSON.stringify(doc)}`)
          view.dispatch({ effects: preview.setSourceMode.of(false) })
          for (const id of ['ref-001', 'ref-002', 'ref-009']) preview.citationsOf(view.state, id)
          mounted += 1
        } catch (error) {
          assert.fail(`${error.message}\n— drawing ${JSON.stringify(doc)} (${isReading ? 'reading' : 'editing'})`)
        } finally {
          view.destroy()
        }
      }
    }
  }
  assert.equal(mounted, contexts.length * pieces.length * 2)
})

// ---------------------------------------------------------------- the fallback

/**
 * A preview that asks for what the editor refuses — a replacement across a
 * line break, from a plugin — wherever the text says REFUSED. This is the
 * failure that once left a note blank, kept here on purpose.
 */
const refusedPreview = () =>
  ViewPlugin.define(
    () => ({}),
    {
      decorations: (_plugin) => Decoration.none,
      provide: () =>
        EditorView.decorations.of((view) => {
          const at = view.state.doc.toString().indexOf('REFUSED\n')
          return at === -1
            ? Decoration.none
            : Decoration.set([Decoration.replace({}).range(at, at + 'REFUSED\n'.length + 1)])
        }),
    },
  )

function quietly(run) {
  const logged = console.error
  console.error = () => {}
  try {
    return run()
  } finally {
    console.error = logged
  }
}

test('a preview the editor refuses to draw leaves the text shown as written, not a blank', () => {
  const host = document.getElementById('host')
  const doc = 'First line.\nREFUSED\nLast line.\n'
  const failures = []
  const editor = quietly(() =>
    mountResilientEditor({
      parent: host,
      doc,
      extensions: (withPreview) => (withPreview ? [refusedPreview()] : []),
      onFallback: (error, applying) => failures.push({ error, applying }),
    }),
  )
  try {
    assert.equal(editor.plain, true)
    assert.equal(failures.length, 1)
    assert.match(failures[0].error.message, /replace line breaks/)
    assert.equal(editor.view.state.doc.toString(), doc)
    assert.match(editor.view.contentDOM.textContent, /First line\.REFUSEDLast line\./)
    // One editor in the page, and it works: what is typed goes in.
    assert.equal(host.querySelectorAll('.cm-editor').length, 1)
    editor.view.dispatch({ changes: { from: 0, insert: 'Typed. ' } })
    assert.match(editor.view.contentDOM.textContent, /^Typed\. First line\./)
  } finally {
    editor.destroy()
    host.replaceChildren()
  }
})

test('a preview that fails at a later change keeps the change, and falls back then', () => {
  const host = document.getElementById('host')
  const failures = []
  const editor = mountResilientEditor({
    parent: host,
    doc: 'First line.\nLast line.\n',
    extensions: (withPreview) => (withPreview ? [refusedPreview()] : []),
    onFallback: (error, applying) => failures.push({ error, applying }),
  })
  try {
    assert.equal(editor.plain, false)
    const before = editor.view
    quietly(() => before.dispatch({ changes: { from: 0, insert: 'REFUSED\n' } }))
    assert.equal(editor.plain, true)
    assert.notEqual(editor.view, before)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].applying.length, 1)
    assert.equal(failures[0].applying[0].docChanged, true)
    // What was typed is in the text that is now shown.
    assert.equal(editor.view.state.doc.toString(), 'REFUSED\nFirst line.\nLast line.\n')
    assert.match(editor.view.contentDOM.textContent, /REFUSEDFirst line\.Last line\./)
    assert.equal(host.querySelectorAll('.cm-editor').length, 1)
  } finally {
    editor.destroy()
    host.replaceChildren()
  }
})

test('a preview that draws is left alone', () => {
  const host = document.getElementById('host')
  const editor = mountResilientEditor({
    parent: host,
    doc: 'See [a quotation that\nruns on](source:ref-001).\n',
    extensions: (withPreview) => [
      preview.noteMarkdown(),
      ...(withPreview ? [preview.livePreview({ reading: true })] : []),
    ],
    onFallback: () => assert.fail('fell back though nothing failed'),
  })
  try {
    assert.equal(editor.plain, false)
    assert.deepEqual(citations(editor.view), ['a quotation that runs on'])
  } finally {
    editor.destroy()
    host.replaceChildren()
  }
})
