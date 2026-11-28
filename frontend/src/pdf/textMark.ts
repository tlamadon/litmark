/**
 * The text highlighter's reading of a page: which words a pen is over.
 *
 * The words of a page are in its text layer — the transparent text PDF.js
 * lays over the picture of the page, piece by piece, each where the PDF puts
 * it. A pen dragged from one place to another marks what lies between them
 * in the order the text is read, as a selection would: this works out which
 * pieces those are, where each is, and what they say.
 *
 * Done here, from where the pieces are, rather than by asking the browser
 * for the caret under the pen: with a tool in hand the ink is over the text
 * and the text is not selectable, and what a browser then answers differs
 * from one to the next.
 *
 * The geometry that needs no page is in `ink.ts`; this is the part that
 * reads one.
 */

import { nearestBox, type Point, type Rect } from './ink'

/** A piece of the page's text, and where it is in the window. */
export interface TextRun {
  node: Text
  /** In the window's pixels: left, top, right, bottom. */
  box: Rect
}

/** A place in the text: a piece, and how many characters into it. */
export interface TextPlace {
  run: number
  offset: number
}

const boxOf = (rect: DOMRect): Rect => [rect.left, rect.top, rect.right, rect.bottom]

/**
 * The pieces of text on a page, in the order they are read. Read once as the
 * pen comes down: nothing on the page moves while it is on the glass.
 */
export function runsOf(textLayer: Element | null): TextRun[] {
  if (!textLayer) return []
  const runs: TextRun[] = []
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
  const range = textLayer.ownerDocument.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (text.data.length === 0) continue
    range.selectNodeContents(text)
    const rect = range.getBoundingClientRect()
    // A piece that takes up no room on the page is not one a pen can be over.
    if (rect.width < 0.5 || rect.height < 0.5) continue
    runs.push({ node: text, box: boxOf(rect) })
  }
  return runs
}

/** Where in the text a place in the window is: between which two characters. */
export function placeAt(runs: readonly TextRun[], at: Point): TextPlace | null {
  const index = nearestBox(
    runs.map((run) => run.box),
    at,
  )
  const run = runs[index]
  if (!run) return null
  const [left, , right] = run.box
  const length = run.node.data.length
  if (at[0] <= left) return { run: index, offset: 0 }
  if (at[0] >= right) return { run: index, offset: length }
  // The first character whose middle is past the pen: the pen is before it.
  const range = run.node.ownerDocument.createRange()
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >> 1
    range.setStart(run.node, middle)
    range.setEnd(run.node, middle + 1)
    const rect = range.getBoundingClientRect()
    if (at[0] < rect.left + rect.width / 2) high = middle
    else low = middle + 1
  }
  return { run: index, offset: low }
}

/**
 * What lies between two places in the text, whichever was given first: the
 * box of each piece of it, in the window's pixels and in reading order, and
 * the words of each.
 */
export function between(
  runs: readonly TextRun[],
  one: TextPlace,
  other: TextPlace,
): { boxes: Rect[]; pieces: string[] } {
  const forwards = one.run < other.run || (one.run === other.run && one.offset <= other.offset)
  const [from, to] = forwards ? [one, other] : [other, one]
  const boxes: Rect[] = []
  const pieces: string[] = []
  const range = runs[from.run]?.node.ownerDocument.createRange()
  if (!range) return { boxes, pieces }
  for (let index = from.run; index <= to.run; index += 1) {
    const run = runs[index]
    if (!run) continue
    const length = run.node.data.length
    const start = index === from.run ? Math.min(from.offset, length) : 0
    const end = index === to.run ? Math.min(to.offset, length) : length
    if (end <= start) continue
    const words = run.node.data.slice(start, end)
    pieces.push(words)
    // A piece that is only the space between two words marks nothing itself.
    if (!words.trim()) continue
    if (start === 0 && end === length) {
      boxes.push(run.box)
      continue
    }
    range.setStart(run.node, start)
    range.setEnd(run.node, end)
    const rect = range.getBoundingClientRect()
    if (rect.width >= 0.5 && rect.height >= 0.5) boxes.push(boxOf(rect))
  }
  return { boxes, pieces }
}
