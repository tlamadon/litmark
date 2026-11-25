/**
 * Tests for the read-only Markdown renderer used on chat surfaces.
 *
 * Agent output reaches this function, so the sanitization guarantees are the
 * point: no raw HTML survives, and no link destination outside the allowed
 * schemes becomes an anchor.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findTables, renderInline, renderMarkdown, renderMathText } from './bundle/markdown.mjs'

test('escapes raw HTML rather than rendering it', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">')
  assert.ok(!html.includes('<img'), html)
  assert.ok(html.includes('&lt;img'), html)
  assert.ok(!html.includes('onerror="'), html)
})

test('drops a javascript: link destination', () => {
  const html = renderMarkdown('[click me](javascript:alert(1))')
  assert.ok(!html.includes('<a'), html)
  // The text is left visible as ordinary escaped characters.
  assert.ok(html.includes('click me'), html)
})

test('drops a data: link destination', () => {
  const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
  assert.ok(!html.includes('<a'), html)
})

test('keeps http and mailto links, with safe rel attributes', () => {
  const html = renderMarkdown('[site](https://example.com/paper.pdf)')
  assert.ok(html.includes('href="https://example.com/paper.pdf"'), html)
  assert.ok(html.includes('rel="noopener noreferrer"'), html)
  assert.ok(html.includes('target="_blank"'), html)
})

test('renders a paper: link as a click target carrying the document id', () => {
  const html = renderMarkdown('This extends [Olley & Pakes (1996)](paper:doc-002).')
  assert.ok(html.includes('data-paper="doc-002"'), html)
  assert.ok(html.includes('>Olley &amp; Pakes (1996)</a>'), html)
  assert.ok(!html.includes('href='), html)
  // Nothing but an ID is taken for one.
  const odd = renderMarkdown('[bad](paper:../../x) [worse](paper:"onmouseover=)')
  assert.ok(!odd.includes('data-paper'), odd)
})

test('renders a source: citation as a click target carrying its reference id', () => {
  const html = renderMarkdown('See [Assumption 2, p. 12](source:ref-001) for the claim.')
  assert.ok(html.includes('data-source-ref="ref-001"'), html)
  assert.ok(html.includes('Assumption 2, p. 12'), html)
  assert.ok(!html.includes('href='), 'a citation is not a navigable href')
})

test('rejects a malformed reference id instead of making a link', () => {
  const html = renderMarkdown('[bad](source:../../etc/passwd)')
  assert.ok(!html.includes('data-source-ref'), html)
})

test('renders headings, lists, quotes, and code', () => {
  const html = renderMarkdown(
    ['## Findings', '', '- first', '- second', '', '> quoted line', '', '`inline()`'].join('\n'),
  )
  assert.ok(html.includes('<h2>Findings</h2>'), html)
  assert.ok(html.includes('<ul>'), html)
  assert.ok(html.includes('<li>first</li>'), html)
  assert.ok(html.includes('<blockquote>quoted line</blockquote>'), html)
  assert.ok(html.includes('<code>inline()</code>'), html)
})

test('leaves fenced code contents unformatted', () => {
  const html = renderMarkdown(['```', '**not bold** and [not a link](https://x.test)', '```'].join('\n'))
  assert.ok(html.includes('<pre><code>'), html)
  assert.ok(!html.includes('<strong>'), html)
  assert.ok(!html.includes('<a href'), html)
})

test('does not treat prose text as a code-span placeholder', () => {
  // The placeholder is NUL-delimited, so a bare number cannot collide with it.
  const html = renderMarkdown('We estimate 3 models and `code` here.')
  assert.ok(html.includes('We estimate 3 models'), html)
  assert.ok(html.includes('<code>code</code>'), html)
})

test('renders inline and display math', () => {
  const inline = renderMarkdown('The estimator is $\\hat{\\beta}$ here.')
  assert.ok(inline.includes('katex'), inline)
  const display = renderMarkdown('$$\\sum_{i=1}^{n} x_i$$')
  assert.ok(display.includes('katex-display'), display)
})

test('invalid math is reported, not thrown', () => {
  const html = renderMarkdown('broken $\\frac{1}$ math')
  assert.ok(typeof html === 'string' && html.length > 0)
  // KaTeX flags the error inline; the surrounding prose survives.
  assert.ok(html.includes('broken') && html.includes('math'), html)
})

test('a bare dollar amount is not math', () => {
  const html = renderMarkdown('It cost $5 and then $7 later.')
  assert.ok(!html.includes('katex'), html)
  assert.ok(html.includes('$5'), html)
})

test('a pipe table becomes a table, with its cells rendered inline', () => {
  const html = renderMarkdown(
    ['| Paper | Claim |', '| --- | :---: |', '| **One** | restricts [p. 2](source:ref-001) |', '| Two | a \\| b |'].join('\n'),
  )
  assert.match(html, /<table>/)
  // The colons in the rule say how a column is set.
  assert.match(html, /<th>Paper<\/th><th style="text-align:center">Claim<\/th>/)
  assert.match(html, /<td><strong>One<\/strong><\/td>/)
  assert.match(html, /data-source-ref="ref-001"/)
  assert.match(html, /<td style="text-align:center">a \| b<\/td>/)
})

test('the tables of a text are found where they are, and not in code', () => {
  const lines = [
    'Before.',
    '',
    '| Paper | N | Share |',
    '|:------|--:|:-----:|',
    '| One | 12 | 0.4 |',
    '| Two | 7 |',
    '',
    '```',
    '| not | a table |',
    '| --- | --- |',
    '```',
    '',
    'a | b',
    '--- | ---',
    '1 | 2',
    'After a | bar, but no rule.',
  ]
  assert.deepEqual(findTables(lines), [
    {
      fromLine: 2,
      toLine: 5,
      header: ['Paper', 'N', 'Share'],
      align: ['left', 'right', 'center'],
      rows: [
        ['One', '12', '0.4'],
        ['Two', '7'],
      ],
    },
    // Without the bars at the edges, and running on until a blank line.
    {
      fromLine: 12,
      toLine: 15,
      header: ['a', 'b'],
      align: [null, null],
      rows: [
        ['1', '2'],
        ['After a', 'bar, but no rule.'],
      ],
    },
  ])
  assert.deepEqual(findTables(['| a |', 'not a rule']), [])
  // One dash is rule enough, as it is elsewhere Markdown is read.
  assert.equal(findTables(['| a | b |', '|:-:|-|', '| 1 | 2 |']).length, 1)
  // A bar in a line, and a rule across the page under it, are not a table.
  assert.deepEqual(findTables(['Either a | or b.', '---', 'More.']), [])
})

test('a cell is rendered as inline text, escaped like the rest', () => {
  assert.equal(renderInline('**x** `y` <b>'), '<strong>x</strong> <code>y</code> &lt;b&gt;')
})

test('a line with a bar but no rule under it stays a paragraph', () => {
  const html = renderMarkdown('Either a | or b, it depends.\n\nNext paragraph.')
  assert.doesNotMatch(html, /<table>/)
  assert.match(html, /<p>Either a \| or b, it depends\.<\/p>/)
})

test('markup inside a table cell cannot escape it', () => {
  const html = renderMarkdown('| a |\n| --- |\n| <img src=x onerror=alert(1)> |')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('a number set as math is math, and a range of prices is not', () => {
  const html = renderMarkdown('The slope is $0.758$ here; tickets are $5-$7.')
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1, html)
  assert.ok(html.includes('$5-$7'), html)
})

test('a citation whose quotation holds brackets is a citation in chat too', () => {
  const html = renderMarkdown(
    'Kills it — [a function of f, E[g ∆f|G, f] = 0 by (A17).](source:ref-430) — and [E\\[˜ϵ ˜ϵ |G\\] = 0](source:ref-385); an interval [0, 1] is not one.',
  )
  assert.ok(html.includes('data-source-ref="ref-430" title="ref-430">a function of f, E[g ∆f|G, f] = 0 by (A17).</a>'), html)
  assert.ok(html.includes('data-source-ref="ref-385" title="ref-385">E[˜ϵ ˜ϵ |G] = 0</a>'), html)
  assert.ok(html.includes('an interval [0, 1] is not one.'), html)
  assert.ok(!html.includes('](source:'), html)
})

test('a list item that runs on to the next line is one item, and a citation broken there one link', () => {
  const html = renderMarkdown(
    ['- AKM fits alike — [the fit of the AKM model—is', 'similar in both samples.](source:ref-455)', '- Next item', '', 'After.'].join('\n'),
  )
  assert.equal((html.match(/<li>/g) ?? []).length, 2, html)
  assert.ok(html.includes('>the fit of the AKM model—is similar in both samples.</a></li>'), html)
  assert.ok(html.includes('<p>After.</p>'), html)
})

test('a heading is listed with its math drawn and the rest of it as text', () => {
  const html = renderMathText('The lagged gap $Z^A_{t-1}$ & <b>more</b>')
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1, html)
  assert.ok(html.includes('&amp; &lt;b&gt;more&lt;/b&gt;'), html)
})
