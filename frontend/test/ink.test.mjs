/**
 * Ink without a page: what a stroke is made of once the pen lifts, what the
 * eraser touches, what undo gives back, and what happens to a window's
 * strokes when another window saved first.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyChange,
  erasedBy,
  joinText,
  lineRects,
  MAX_MARK_RECTS,
  MAX_MARK_TEXT,
  MAX_STROKE_POINTS,
  nearestBox,
  newStrokeId,
  NO_HISTORY,
  rebase,
  record,
  rectsPath,
  redo,
  sameStrokes,
  simplify,
  strokePath,
  tidy,
  tidyRects,
  touches,
  undo,
} from './bundle/pdf/ink.mjs'

const stroke = (id, points = [[0.1, 0.1], [0.3, 0.1]], more = {}) => ({
  id,
  page: 1,
  tool: 'pen',
  color: '#1f4fd8',
  width: 0.0025,
  points,
  ...more,
})
const ids = (strokes) => strokes.map((item) => item.id)

// ---------------------------------------------------------------- points

test('points on the line between their neighbours are left out', () => {
  const line = Array.from({ length: 50 }, (_unused, index) => [index / 100, 0.2])
  assert.deepEqual(simplify(line, 0.001), [[0, 0.2], [0.49, 0.2]])
})

test('a corner is kept, and a wobble smaller than the tolerance is not', () => {
  const corner = [[0, 0], [0.1, 0.0002], [0.2, 0], [0.2, 0.1], [0.2, 0.2]]
  assert.deepEqual(simplify(corner, 0.001), [[0, 0], [0.2, 0], [0.2, 0.2]])
  // The same wobble is kept when it is what was asked to be kept.
  assert.equal(simplify(corner, 0.0001).length, 4)
})

test('a distance down the page counts for more than the same across it', () => {
  // 0.001 of the height of a page 1.4 times as tall as wide is 0.0014 widths.
  const bump = [[0, 0.5], [0.1, 0.501], [0.2, 0.5]]
  assert.equal(simplify(bump, 0.0012, 1).length, 2)
  assert.equal(simplify(bump, 0.0012, 1.4).length, 3)
})

test('a very long stroke is simplified without running out of stack', () => {
  const spiral = Array.from({ length: 60000 }, (_unused, index) => [
    0.5 + 0.4 * Math.cos(index / 50) * (index / 60000),
    0.5 + 0.4 * Math.sin(index / 50) * (index / 60000),
  ])
  const kept = simplify(spiral, 0.0005)
  assert.ok(kept.length > 100 && kept.length < 20000, `kept ${kept.length}`)
  // And is stored in no more points than the server takes for one stroke.
  const stored = tidy(spiral, 0.0005)
  assert.ok(stored.length > 100 && stored.length <= MAX_STROKE_POINTS, `stored ${stored.length}`)
})

test('what is stored is on the page, to four places, each point once', () => {
  assert.deepEqual(
    tidy([[-0.2, 0.123456], [0.5, 0.5], [0.50001, 0.50001], [1.4, 2]], 0),
    [[0, 0.1235], [0.5, 0.5], [1, 1]],
  )
  // A tap: one point, which is drawn as a dot.
  assert.deepEqual(tidy([[0.25, 0.25], [0.25, 0.25]], 0.001), [[0.25, 0.25]])
})

test('a new stroke has a name the server takes, and its own', () => {
  const made = new Set(Array.from({ length: 200 }, newStrokeId))
  assert.equal(made.size, 200)
  for (const id of made) assert.match(id, /^ink-[0-9a-f]{16}$/)
})

// --------------------------------------------------------------- drawing

test('a path is the points times the size of the page, whatever the zoom', () => {
  const points = [[0.1, 0.2], [0.5, 0.2]]
  assert.equal(strokePath(points, 600, 800), 'M60 160L300 160')
  assert.equal(strokePath(points, 1200, 1600), 'M120 320L600 320')
  // A dot is a line of no length; round caps draw it.
  assert.equal(strokePath([[0.5, 0.5]], 600, 800), 'M300 400L300 400')
  assert.equal(strokePath([], 600, 800), '')
})

test('points close together are joined in one smooth line', () => {
  // Nearer each other than the bend is long: each curve runs from the middle
  // of one segment to the middle of the next, and no straight is left between.
  const path = strokePath([[0, 0], [0.004, 0], [0.004, 0.004], [0.008, 0.004]], 1000, 1000)
  assert.equal(path, 'M0 0L2 0Q4 0 4 2Q4 4 6 4L8 4')
})

test('a corner between two long sides stays a corner', () => {
  // The sides of a box: straight to within three thousandths of the page's
  // width of the corner, and only there rounded.
  const path = strokePath([[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]], 1000, 1000)
  assert.equal(path, 'M100 100L497 100Q500 100 500 103L500 500')
})

// ------------------------------------------------------------ text marks

const mark = (id, rects = [[0.1, 0.2, 0.9, 0.22], [0.1, 0.23, 0.4, 0.25]]) => ({
  id,
  page: 1,
  tool: 'text',
  color: '#ffd60a',
  rects,
  text: 'what the two lines say',
})

test('a pen on a piece of text means that piece', () => {
  // Two lines of one column, and a line of the column beside it.
  const boxes = [
    [100, 100, 300, 112],
    [100, 116, 300, 128],
    [340, 100, 540, 112],
  ]
  assert.equal(nearestBox(boxes, [150, 105]), 0)
  assert.equal(nearestBox(boxes, [150, 120]), 1)
  assert.equal(nearestBox(boxes, [400, 105]), 2)
})

test('a pen beside a line means that line, and between two lines the nearer', () => {
  const boxes = [
    [100, 100, 300, 112],
    [100, 116, 300, 128],
    [340, 100, 540, 112],
  ]
  // In the margin, level with the second line.
  assert.equal(nearestBox(boxes, [40, 120]), 1)
  // In the gutter, level with the first line of both columns: the nearer across.
  assert.equal(nearestBox(boxes, [310, 105]), 0)
  assert.equal(nearestBox(boxes, [332, 105]), 2)
  // In the gap between the lines, nearer the second.
  assert.equal(nearestBox(boxes, [150, 115]), 1)
  // Past the end of the column: its last line.
  assert.equal(nearestBox(boxes, [150, 400]), 1)
  assert.equal(nearestBox([], [150, 400]), -1)
})

test('the pieces of one line are one band, and the next line another', () => {
  const lines = lineRects([
    [0.1, 0.2, 0.3, 0.22],
    [0.305, 0.201, 0.5, 0.221],
    [0.1, 0.23, 0.4, 0.25],
  ])
  assert.deepEqual(lines, [
    [0.1, 0.2, 0.5, 0.221],
    [0.1, 0.23, 0.4, 0.25],
  ])
})

test('two columns on the same line are not joined across the gutter', () => {
  const lines = lineRects([
    [0.1, 0.2, 0.45, 0.22],
    [0.55, 0.2, 0.9, 0.22],
  ])
  assert.equal(lines.length, 2)
  // How tall a line is is measured in page widths: on a tall page the same
  // gap is no wider than the line is tall, and is a space between words.
  assert.equal(lineRects([[0.1, 0.2, 0.45, 0.22], [0.475, 0.2, 0.9, 0.22]], 1).length, 2)
  assert.equal(lineRects([[0.1, 0.2, 0.45, 0.22], [0.475, 0.2, 0.9, 0.22]], 1.4).length, 1)
})

test('a small raised piece is of its line; the line below is not', () => {
  // A footnote mark: short, and set high, but mostly within the line.
  assert.equal(lineRects([[0.1, 0.2, 0.3, 0.22], [0.3, 0.196, 0.31, 0.208]]).length, 1)
  assert.equal(lineRects([[0.1, 0.2, 0.3, 0.22], [0.3, 0.215, 0.5, 0.235]]).length, 2)
})

test('what is stored of a mark is on the page, to four places, and has a size', () => {
  assert.deepEqual(
    tidyRects([
      [0.9, 0.22, 0.1, 0.2],
      [-0.2, 0.123456, 1.7, 0.2],
      [0.3, 0.2, 0.3, 0.4],
      [0.30001, 0.2, 0.30004, 0.4],
    ]),
    [
      [0.1, 0.2, 0.9, 0.22],
      [0, 0.1235, 1, 0.2],
    ],
  )
  const many = Array.from({ length: MAX_MARK_RECTS + 5 }, (_, i) => [0.1, i / 4000, 0.2, (i + 1) / 4000])
  assert.equal(tidyRects(many).length, MAX_MARK_RECTS)
})

test('a mark is drawn as its rectangles times the size of the page', () => {
  assert.equal(rectsPath(mark('ink-m').rects.slice(0, 1), 1000, 1000), 'M100 200H900V220H100Z')
  assert.equal(
    rectsPath([[0.1, 0.2, 0.9, 0.22]], 500, 1000),
    'M50 200H450V220H50Z',
  )
  assert.equal(rectsPath([], 500, 1000), '')
})

test('the words of the pieces are one run of text', () => {
  assert.equal(joinText(['Job value is', 'unobserved, so ', 'the authors']), 'Job value is unobserved, so the authors')
  assert.equal(joinText(['  spaced\n', '  out  ']), 'spaced out')
  assert.equal(joinText([]), '')
  assert.equal(joinText(['x'.repeat(MAX_MARK_TEXT + 50)]).length, MAX_MARK_TEXT)
})

test('the eraser rubs out a mark it is on or at the edge of, whole', () => {
  const marked = mark('ink-m')
  assert.ok(touches(marked, [0.5, 0.21], 0.01))
  assert.ok(touches(marked, [0.2, 0.24], 0.01), 'on its second line')
  assert.ok(touches(marked, [0.905, 0.21], 0.01), 'within reach of its edge')
  // Beside the short second line, and between the two.
  assert.ok(!touches(marked, [0.6, 0.24], 0.01))
  assert.ok(!touches(marked, [0.5, 0.26], 0.005))
  // Down the page counts for more than across it.
  assert.ok(touches(marked, [0.5, 0.228], 0.01, 1))
  assert.ok(!touches(marked, [0.5, 0.228], 0.01, 1.4))
  assert.deepEqual(erasedBy([marked, stroke('ink-a')], [0.5, 0.5], [0.5, 0.21], 0.01), ['ink-m'])
})

test('a mark is undone, redone and merged as any stroke is', () => {
  const marked = mark('ink-m')
  const done = record(NO_HISTORY, { add: [marked], remove: [] })
  const back = undo([marked], done)
  assert.deepEqual(back.strokes, [])
  assert.deepEqual(ids(redo(back.strokes, back.history).strokes), ['ink-m'])
  assert.deepEqual(ids(rebase([], [marked], [stroke('ink-theirs')])), ['ink-theirs', 'ink-m'])
})

// ---------------------------------------------------------------- eraser

test('the eraser touches a stroke it is on, and not one it is beside', () => {
  const line = stroke('ink-a', [[0.2, 0.5], [0.8, 0.5]], { width: 0.01 })
  assert.ok(touches(line, [0.5, 0.5], 0.01))
  assert.ok(touches(line, [0.5, 0.512], 0.01), 'within its reach and half the line')
  assert.ok(!touches(line, [0.5, 0.53], 0.01))
  // Past the end of the line is beside it too.
  assert.ok(!touches(line, [0.85, 0.5], 0.01))
  // A dot can be rubbed out.
  assert.ok(touches(stroke('ink-dot', [[0.3, 0.3]]), [0.305, 0.3], 0.01))
})

test('how near is near is measured in page widths, down as across', () => {
  const line = stroke('ink-a', [[0.2, 0.5], [0.8, 0.5]], { width: 0 })
  // 0.008 of the height below the line: 0.0112 widths on a tall page.
  assert.ok(touches(line, [0.5, 0.508], 0.01, 1))
  assert.ok(!touches(line, [0.5, 0.508], 0.01, 1.4))
})

test('an eraser moved fast rubs out what it crossed on the way', () => {
  const strokes = [
    stroke('ink-crossed', [[0.5, 0.1], [0.5, 0.9]]),
    stroke('ink-far', [[0.1, 0.9], [0.9, 0.9]]),
    stroke('ink-other-page', [[0.5, 0.1], [0.5, 0.9]]),
  ]
  // From one side of the vertical line to the other, in a single report.
  assert.deepEqual(erasedBy(strokes.slice(0, 2), [0.2, 0.4], [0.8, 0.4], 0.01), ['ink-crossed'])
  assert.deepEqual(erasedBy(strokes.slice(0, 2), [0.2, 0.4], [0.2, 0.4], 0.01), [])
})

// ------------------------------------------------------------ undo, redo

test('undo takes back the last thing done, and redo does it again', () => {
  const a = stroke('ink-a')
  const b = stroke('ink-b')
  let strokes = []
  let history = NO_HISTORY
  for (const drawn of [a, b]) {
    const change = { add: [drawn], remove: [] }
    strokes = applyChange(strokes, change)
    history = record(history, change)
  }
  assert.deepEqual(ids(strokes), ['ink-a', 'ink-b'])

  let stepped = undo(strokes, history)
  assert.deepEqual(ids(stepped.strokes), ['ink-a'])
  stepped = undo(stepped.strokes, stepped.history)
  assert.deepEqual(ids(stepped.strokes), [])
  assert.equal(undo(stepped.strokes, stepped.history), null, 'nothing more to take back')

  stepped = redo(stepped.strokes, stepped.history)
  stepped = redo(stepped.strokes, stepped.history)
  assert.deepEqual(ids(stepped.strokes), ['ink-a', 'ink-b'])
  assert.equal(redo(stepped.strokes, stepped.history), null)
})

test('a rubbing-out of several strokes is undone as one', () => {
  const all = [stroke('ink-a'), stroke('ink-b'), stroke('ink-c')]
  const rubbing = { add: [], remove: [all[0], all[2]] }
  const strokes = applyChange(all, rubbing)
  const history = record(NO_HISTORY, rubbing)
  assert.deepEqual(ids(strokes), ['ink-b'])
  const back = undo(strokes, history)
  assert.deepEqual(ids(back.strokes).sort(), ['ink-a', 'ink-b', 'ink-c'])
  assert.deepEqual(ids(redo(back.strokes, back.history).strokes), ['ink-b'])
})

test('doing something new forgets what had been undone', () => {
  const first = { add: [stroke('ink-a')], remove: [] }
  let history = record(NO_HISTORY, first)
  const stepped = undo(applyChange([], first), history)
  history = record(stepped.history, { add: [stroke('ink-b')], remove: [] })
  assert.equal(history.redo.length, 0)
  assert.equal(history.undo.length, 1)
})

test('a change is by id: nothing is drawn twice or removed twice', () => {
  const a = stroke('ink-a')
  assert.deepEqual(ids(applyChange([a], { add: [a], remove: [] })), ['ink-a'])
  assert.deepEqual(ids(applyChange([], { add: [], remove: [a] })), [])
})

// ---------------------------------------------------------------- saving

test('strokes are the same when they are the same ones in the same order', () => {
  const a = stroke('ink-a')
  const b = stroke('ink-b')
  assert.ok(sameStrokes([a, b], [a, b]))
  assert.ok(!sameStrokes([a, b], [b, a]))
  assert.ok(!sameStrokes([a], [a, b]))
  assert.ok(sameStrokes([], []))
})

test('when another window saved first, both windows\' strokes are kept', () => {
  const base = [stroke('ink-a')]
  const mine = [...base, stroke('ink-mine')]
  const theirs = [...base, stroke('ink-theirs')]
  assert.deepEqual(ids(rebase(base, mine, theirs)), ['ink-a', 'ink-theirs', 'ink-mine'])
})

test('what either window rubbed out stays rubbed out', () => {
  const base = [stroke('ink-a'), stroke('ink-b'), stroke('ink-c')]
  // Here: b rubbed out, and a stroke drawn. There: c rubbed out, and one drawn.
  const mine = [base[0], base[2], stroke('ink-mine')]
  const theirs = [base[0], base[1], stroke('ink-theirs')]
  assert.deepEqual(ids(rebase(base, mine, theirs)), ['ink-a', 'ink-theirs', 'ink-mine'])
})

test('with nothing done here, what the other window saved is simply taken', () => {
  const base = [stroke('ink-a')]
  const theirs = [stroke('ink-theirs'), stroke('ink-a')]
  assert.deepEqual(ids(rebase(base, base, theirs)), ['ink-theirs', 'ink-a'])
  // And a stroke both hold is not doubled when the save crossed its own echo.
  const mine = [...base, stroke('ink-mine')]
  assert.deepEqual(ids(rebase(base, mine, mine)), ['ink-a', 'ink-mine'])
})

test('a stroke undone after it was saved is not brought back by a refused save', () => {
  // Saved with a stroke, which was then undone here; meanwhile theirs arrived.
  const saved = [stroke('ink-a'), stroke('ink-regretted')]
  const mine = [saved[0]]
  const theirs = [...saved, stroke('ink-theirs')]
  assert.deepEqual(ids(rebase(saved, mine, theirs)), ['ink-a', 'ink-theirs'])
})
