/**
 * Ink on a page: what a stroke is, and everything about strokes that can be
 * worked out without a page to draw on.
 *
 * A stroke is a line through points given as fractions of the displayed page,
 * origin top-left — the coordinates a reference's rectangles are in — so it
 * is multiplied by the page's size to be drawn, and never stored in pixels.
 * Its width is a fraction of the page's width.
 *
 * Distances are another matter: a page is taller than it is wide, so a step
 * of 0.01 down is longer than one of 0.01 across. Wherever a distance is
 * measured here, y is first multiplied by `aspect`, the page's height over
 * its width, which puts both in units of the page's width.
 *
 * Not everything put on a page is a line. Text marked with the text
 * highlighter is the words themselves picked out: the rectangle of each line
 * of them, in the same fractions of the page, and the words. It is kept with
 * the strokes and is one of them in every way that matters here — it has an
 * id, it is rubbed out whole, undone, saved and exported — so it is a kind of
 * stroke, told apart by its tool.
 *
 * Kept free of the DOM and of the API, so it is tested as it is.
 */

/** What draws a line. */
export type LineTool = 'pen' | 'highlighter'

/** What puts something on a page: a line, or — `text` — a mark over words. */
export type InkTool = LineTool | 'text'

export type Point = [number, number]

/** `[x0, y0, x1, y1]`, as fractions of the page: its left, top, right and bottom. */
export type Rect = [number, number, number, number]

interface OnPage {
  id: string
  /** The page it is on, from 1. */
  page: number
  /** `#rrggbb`. */
  color: string
}

/** A line drawn by hand. */
export interface LineStroke extends OnPage {
  tool: LineTool
  /** A fraction of the page's width. */
  width: number
  points: Point[]
}

/** Words marked: where each line of them is, and what they say. */
export interface TextMark extends OnPage {
  tool: 'text'
  /** One rectangle to a line of the text, in reading order. */
  rects: Rect[]
  /** The words, as the PDF gives them: what was marked, said in the file itself. */
  text: string
}

export type Stroke = LineStroke | TextMark

/** How much of what is under a highlighter stroke shows through. As in the export. */
export const HIGHLIGHTER_OPACITY = 0.4

/** A name for a new stroke, its own on whichever machine it is drawn. */
export function newStrokeId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `ink-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

// ----------------------------------------------------------------- points

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const round4 = (value: number): number => Math.round(value * 10000) / 10000

/** How far a point is from the segment between two others, in page widths. */
function distanceToSegment(point: Point, from: Point, to: Point, aspect: number): number {
  const px = point[0]
  const py = point[1] * aspect
  const ax = from[0]
  const ay = from[1] * aspect
  const bx = to[0]
  const by = to[1] * aspect
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const along = length === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length))
  return Math.hypot(px - (ax + along * dx), py - (ay + along * dy))
}

/**
 * The same line through fewer points (Ramer–Douglas–Peucker): a point is kept
 * only if leaving it out would move the line by more than `tolerance`.
 *
 * A pencil reports a point every few milliseconds, most of them on the
 * straight line between their neighbours. Without them the file — and each
 * diff of it in git — is a fraction of the size, and the stroke looks the same.
 */
export function simplify(points: Point[], tolerance: number, aspect = 1): Point[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  // Not recursive: a long stroke would go as deep as it is long.
  const spans: [number, number][] = [[0, points.length - 1]]
  while (spans.length > 0) {
    const [first, last] = spans.pop()!
    let farthest = -1
    let distance = tolerance
    for (let index = first + 1; index < last; index += 1) {
      const d = distanceToSegment(points[index]!, points[first]!, points[last]!, aspect)
      if (d > distance) {
        farthest = index
        distance = d
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1
      spans.push([first, farthest], [farthest, last])
    }
  }
  return points.filter((_point, index) => keep[index] === 1)
}

/** The server takes no stroke of more points than this (`MAX_POINTS` in `ink.py`), with room to spare. */
export const MAX_STROKE_POINTS = 4000

/**
 * A stroke's points as they are stored: on the page, simplified, rounded to
 * four places, and without a point said twice in a row.
 *
 * A stroke that is still too long for the server after that — minutes of
 * scribbling without lifting the pen — is simplified harder until it is not:
 * a save refused for one stroke would hold back every stroke after it.
 */
export function tidy(points: Point[], tolerance: number, aspect = 1): Point[] {
  for (let allowed = tolerance; ; allowed = Math.max(allowed * 2, 1e-5)) {
    const out: Point[] = []
    for (const [x, y] of simplify(points, allowed, aspect)) {
      const point: Point = [round4(clamp01(x)), round4(clamp01(y))]
      const previous = out[out.length - 1]
      if (previous && previous[0] === point[0] && previous[1] === point[1]) continue
      out.push(point)
    }
    if (out.length <= MAX_STROKE_POINTS) return out
  }
}

// ----------------------------------------------------------------- drawing

const px = (value: number): string => String(Math.round(value * 10) / 10)

/**
 * How far from a point of the stroke the line starts to bend toward the next
 * one, as a fraction of the page's width (`CORNER` in `ink.py` is the same).
 */
export const CORNER = 0.003

/**
 * The SVG path of a stroke on a page `width` by `height` pixels.
 *
 * Straight from point to point, with each point rounded off: the line leaves
 * the straight a little before the point and bends past it. Where the points
 * are close together — a curve, as simplifying leaves it — that is the whole
 * of each segment, and the stroke is one smooth line; where they are far
 * apart — the sides of a box, the stem of an arrow — the corner between them
 * stays a corner. `_path_operators` in `ink.py` draws the exported stroke
 * the same way.
 */
export function strokePath(points: Point[], width: number, height: number): string {
  const first = points[0]
  if (!first) return ''
  const places = points.map(([x, y]): Point => [x * width, y * height])
  const at = (point: Point): string => `${px(point[0])} ${px(point[1])}`
  const last = places[places.length - 1]!
  // A single point is a line of no length, which round caps make a dot.
  if (places.length < 3) return `M${at(places[0]!)}L${at(last)}`
  const reach = CORNER * width
  /** The place on the way from one point to another where the bend begins or ends. */
  const toward = (from: Point, to: Point): Point => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const part = length === 0 ? 0 : Math.min(0.5, reach / length)
    return [from[0] + (to[0] - from[0]) * part, from[1] + (to[1] - from[1]) * part]
  }
  let path = `M${at(places[0]!)}`
  let pen = at(places[0]!)
  for (let index = 1; index < places.length - 1; index += 1) {
    const bend = places[index]!
    const enter = at(toward(bend, places[index - 1]!))
    const leave = at(toward(bend, places[index + 1]!))
    if (enter !== pen) path += `L${enter}`
    path += `Q${at(bend)} ${leave}`
    pen = leave
  }
  return `${path}L${at(last)}`
}

// --------------------------------------------------------------- text marks

/** The server takes no mark of more rectangles than this (`MAX_RECTS` in `ink.py`). */
export const MAX_MARK_RECTS = 1500
/** Nor one that says more than this (`MAX_TEXT` in `ink.py`); a longer one is cut short. */
export const MAX_MARK_TEXT = 8000

/**
 * Which piece of text a place on the page belongs to: the index of its box.
 *
 * The one the place is in. Outside all of them, the piece on the line the
 * place is level with that is nearest across — a pen in the margin, or between
 * two columns, means the line beside it — and level with no line, the piece
 * nearest up or down, then across: a pen in the gap between two lines, or
 * past the end of a paragraph. In any units, as long as they are the same.
 */
export function nearestBox(boxes: readonly Rect[], at: Point): number {
  const [x, y] = at
  let best = -1
  let bestDown = Infinity
  let bestAcross = Infinity
  boxes.forEach(([x0, y0, x1, y1], index) => {
    const down = Math.max(y0 - y, 0, y - y1)
    const across = Math.max(x0 - x, 0, x - x1)
    if (down < bestDown || (down === bestDown && across < bestAcross)) {
      best = index
      bestDown = down
      bestAcross = across
    }
  })
  return best
}

/**
 * The pieces of text marked, as one rectangle to a line.
 *
 * A PDF gives a line in pieces — a word here, the rest there, each with a box
 * of its own. Pieces that follow one another on the same line are joined into
 * one rectangle, so a mark is a band across the line and not a row of tiles.
 * Two pieces are on the same line when they overlap by half the height of
 * the shorter, and are joined when the gap between them is no wider than the
 * line is tall: a space between words is, the gutter between two columns is
 * not. `aspect` is the page's height over its width.
 */
export function lineRects(boxes: readonly Rect[], aspect = 1): Rect[] {
  const lines: Rect[] = []
  for (const box of boxes) {
    const last = lines[lines.length - 1]
    if (last) {
      const overlap = Math.min(last[3], box[3]) - Math.max(last[1], box[1])
      const shorter = Math.min(last[3] - last[1], box[3] - box[1])
      const tall = Math.max(last[3] - last[1], box[3] - box[1]) * aspect
      const gap = Math.max(box[0] - last[2], last[0] - box[2])
      if (shorter > 0 && overlap >= shorter / 2 && gap <= tall) {
        lines[lines.length - 1] = [
          Math.min(last[0], box[0]),
          Math.min(last[1], box[1]),
          Math.max(last[2], box[2]),
          Math.max(last[3], box[3]),
        ]
        continue
      }
    }
    lines.push([box[0], box[1], box[2], box[3]])
  }
  return lines
}

/**
 * A mark's rectangles as they are stored: on the page, to four places, and
 * none of no size — as `ink.py` would have them, so that what is drawn is
 * what is saved.
 */
export function tidyRects(rects: readonly Rect[]): Rect[] {
  const out: Rect[] = []
  for (const [x0, y0, x1, y1] of rects) {
    const rect: Rect = [
      round4(clamp01(Math.min(x0, x1))),
      round4(clamp01(Math.min(y0, y1))),
      round4(clamp01(Math.max(x0, x1))),
      round4(clamp01(Math.max(y0, y1))),
    ]
    if (rect[2] > rect[0] && rect[3] > rect[1]) out.push(rect)
  }
  return out.slice(0, MAX_MARK_RECTS)
}

/** The SVG path of a mark's rectangles on a page `width` by `height` pixels. */
export function rectsPath(rects: readonly Rect[], width: number, height: number): string {
  return rects
    .map(
      ([x0, y0, x1, y1]) =>
        `M${px(x0 * width)} ${px(y0 * height)}H${px(x1 * width)}V${px(y1 * height)}H${px(x0 * width)}Z`,
    )
    .join('')
}

/**
 * The words of the pieces marked, as one run of text: a space between two
 * pieces that have none, and never two together.
 */
export function joinText(pieces: readonly string[]): string {
  let out = ''
  for (const piece of pieces) {
    if (out && piece && !/\s$/.test(out) && !/^\s/.test(piece)) out += ' '
    out += piece
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_MARK_TEXT)
}

// ------------------------------------------------------------------ eraser

/** Whether an eraser of `radius` at `at` touches a stroke. All in page widths. */
export function touches(stroke: Stroke, at: Point, radius: number, aspect = 1): boolean {
  if (stroke.tool === 'text') {
    // On the mark, or within the eraser's reach of its edge.
    return stroke.rects.some(([x0, y0, x1, y1]) => {
      const dx = Math.max(x0 - at[0], 0, at[0] - x1)
      const dy = Math.max(y0 - at[1], 0, at[1] - y1) * aspect
      return Math.hypot(dx, dy) <= radius
    })
  }
  const reach = radius + stroke.width / 2
  const { points } = stroke
  if (points.length === 1) return distanceToSegment(at, points[0]!, points[0]!, aspect) <= reach
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(at, points[index - 1]!, points[index]!, aspect) <= reach) return true
  }
  return false
}

/** The strokes an eraser touches on its way from one place to the next. */
export function erasedBy(
  strokes: Stroke[],
  from: Point,
  to: Point,
  radius: number,
  aspect = 1,
): string[] {
  // A fast hand moves further between two reports than the eraser is wide:
  // step along the way, so nothing in between is jumped over.
  const length = Math.hypot(to[0] - from[0], (to[1] - from[1]) * aspect)
  const steps = Math.max(1, Math.ceil(length / Math.max(radius, 1e-6)))
  const hit: string[] = []
  for (const stroke of strokes) {
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const at: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
      if (touches(stroke, at, radius, aspect)) {
        hit.push(stroke.id)
        break
      }
    }
  }
  return hit
}

// --------------------------------------------------------------- undo, redo

/** One thing done to the ink: strokes drawn, strokes rubbed out. */
export interface InkChange {
  add: Stroke[]
  remove: Stroke[]
}

export interface InkHistory {
  undo: InkChange[]
  redo: InkChange[]
}

export const NO_HISTORY: InkHistory = { undo: [], redo: [] }

/** More than anyone steps back through; it bounds what a long sitting holds on to. */
const MAX_UNDO = 200

/**
 * The strokes after a change. By id, so a change still means something once
 * the ink under it has moved on: a stroke already gone is not removed twice,
 * one already there is not drawn twice.
 */
export function applyChange(strokes: Stroke[], change: InkChange): Stroke[] {
  const gone = new Set(change.remove.map((stroke) => stroke.id))
  const kept = strokes.filter((stroke) => !gone.has(stroke.id))
  const present = new Set(kept.map((stroke) => stroke.id))
  return [...kept, ...change.add.filter((stroke) => !present.has(stroke.id))]
}

const inverse = (change: InkChange): InkChange => ({ add: change.remove, remove: change.add })

/** Do something new: it can be undone, and what was undone before cannot be redone. */
export function record(history: InkHistory, change: InkChange): InkHistory {
  return { undo: [...history.undo, change].slice(-MAX_UNDO), redo: [] }
}

export function undo(
  strokes: Stroke[],
  history: InkHistory,
): { strokes: Stroke[]; history: InkHistory } | null {
  const last = history.undo[history.undo.length - 1]
  if (!last) return null
  return {
    strokes: applyChange(strokes, inverse(last)),
    history: { undo: history.undo.slice(0, -1), redo: [...history.redo, last] },
  }
}

export function redo(
  strokes: Stroke[],
  history: InkHistory,
): { strokes: Stroke[]; history: InkHistory } | null {
  const last = history.redo[history.redo.length - 1]
  if (!last) return null
  return {
    strokes: applyChange(strokes, last),
    history: { undo: [...history.undo, last], redo: history.redo.slice(0, -1) },
  }
}

// ----------------------------------------------------------------- saving

/** The same strokes in the same order. A stroke never changes once drawn, so its id says it all. */
export function sameStrokes(a: Stroke[], b: Stroke[]): boolean {
  return a.length === b.length && a.every((stroke, index) => stroke.id === b[index]!.id)
}

/**
 * What this window's ink becomes when another window has saved in the meantime.
 *
 * `saved` is what both started from, `local` what this window has made of it,
 * `theirs` what is now on the server. What was done here since `saved` — the
 * strokes drawn, the strokes rubbed out — is done again on `theirs`, by id.
 * So neither window's strokes are lost, and a stroke either of them erased
 * stays erased.
 */
export function rebase(saved: Stroke[], local: Stroke[], theirs: Stroke[]): Stroke[] {
  const before = new Set(saved.map((stroke) => stroke.id))
  const now = new Set(local.map((stroke) => stroke.id))
  return applyChange(theirs, {
    add: local.filter((stroke) => !before.has(stroke.id)),
    remove: saved.filter((stroke) => !now.has(stroke.id)),
  })
}
