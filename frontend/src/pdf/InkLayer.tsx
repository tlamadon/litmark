/**
 * The ink on one page, and the pen that puts it there.
 *
 * Two drawings over the page: highlighter strokes, which darken what is under
 * them as a highlighter does, and pen strokes over those. With no tool in
 * hand the layer lets everything through — text is selected and highlights
 * are clicked exactly as if it were not there. With one, it takes the pointer.
 *
 * A pen or a mouse draws; a finger does not, so that it can go on scrolling
 * the paper, and a palm resting on the glass leaves nothing. The stroke under
 * the pen is written straight to its path, and becomes one of the paper's
 * strokes when the pen lifts.
 *
 * A finger's scrolling is done here rather than left to the browser, which
 * would scroll for the pen as well; see `stylusGuard`.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import {
  erasedBy,
  HIGHLIGHTER_OPACITY,
  newStrokeId,
  strokePath,
  tidy,
  type InkTool,
  type Point,
  type Stroke,
} from './ink'

/** What is in hand: something that draws, or the eraser. */
export type InkMode = InkTool | 'eraser'

/** A stroke's width for each tool, as a fraction of the page's width. */
export const TOOL_WIDTH: Record<InkTool, number> = { pen: 0.0025, highlighter: 0.022 }

/** How far from its centre the eraser rubs out, in pixels on the screen. */
const ERASER_RADIUS_PX = 9
/** How far a simplified stroke may stray from the one drawn, in pixels on the screen. */
const SIMPLIFY_PX = 0.35

/**
 * How the pen is kept from scrolling the paper while a finger still can.
 *
 * `touch-action` — the page takes no panning from the browser at all while a
 * tool is in hand (`touch-action: none`), and a finger moves the paper
 * through this layer instead, without momentum. What is used, on every
 * browser: it asks nothing of the browser but to say which pointer is a pen.
 *
 * `touchstart` — Safari on an iPad says which touch is the Pencil
 * (`Touch.touchType`), so that touch alone could be refused its default and a
 * finger left to pan as the browser has it, momentum and all. It was the
 * first choice there, and did not hold on the iPad it was tried on (iPadOS,
 * November 2026): the Pencil drew only with the other way switched on. Kept
 * to be tried again, not used unasked.
 *
 * To try it on a device, open the application once with
 * `?inkguard=touchstart` on the address; it is remembered there until
 * `?inkguard=auto`.
 */
export type StylusGuard = 'touchstart' | 'touch-action'

const GUARD_KEY = 'litmark.inkguard'

function chooseGuard(): StylusGuard {
  try {
    const given = new URLSearchParams(window.location.search).get('inkguard')
    if (given === 'auto') window.localStorage.removeItem(GUARD_KEY)
    else if (given === 'touchstart' || given === 'touch-action') {
      window.localStorage.setItem(GUARD_KEY, given)
    }
    if (window.localStorage.getItem(GUARD_KEY) === 'touchstart') return 'touchstart'
  } catch {
    /* No storage: the way that is used unasked. */
  }
  return 'touch-action'
}

// Chosen as the application loads: the address is rewritten soon after, and
// what was asked for on it would be gone by the time a pen is taken up.
const guard: StylusGuard = chooseGuard()
export const stylusGuard = (): StylusGuard => guard

export interface InkLayerProps {
  pageNumber: number
  /** The page's size on screen, in pixels. */
  width: number
  height: number
  /** The strokes on this page. */
  strokes: Stroke[]
  /** What is in hand; null when nothing is, and the layer is only a picture. */
  mode: InkMode | null
  /** The colour the tool in hand draws in. */
  color: string
  onDraw: (stroke: Stroke) => void
  onErase: (ids: string[]) => void
}

interface Gesture {
  pointer: number
  mode: InkMode
  /** Where the pointer has been, as fractions of the page. */
  points: Point[]
}

const NOTHING_ERASED: ReadonlySet<string> = new Set()

export function InkLayer(props: InkLayerProps) {
  const { width, height, mode } = props
  const layer = useRef<HTMLDivElement | null>(null)
  const livePen = useRef<SVGPathElement | null>(null)
  const liveMarker = useRef<SVGPathElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  /** A finger moving the paper, where the browser has been told not to: its last place. */
  const panning = useRef<{ pointer: number; x: number; y: number } | null>(null)
  // Rubbed out under the eraser so far; gone from the paper when it lifts.
  // In state to be drawn without, and in a ref because the pen can lift
  // before the page has been drawn again.
  const [erased, setErased] = useState<ReadonlySet<string>>(NOTHING_ERASED)
  const rubbed = useRef<Set<string>>(new Set())
  const latest = useRef(props)
  latest.current = props

  const paths = useMemo(
    () =>
      props.strokes.map((stroke) => ({
        stroke,
        d: strokePath(stroke.points, width, height),
      })),
    [props.strokes, width, height],
  )

  // Refusing a touch its default has to be said on a listener that is not
  // passive, which is not how handlers given as props are attached.
  useEffect(() => {
    const node = layer.current
    if (!node || mode === null || stylusGuard() !== 'touchstart') return
    const refuseStylus = (event: TouchEvent): void => {
      for (const touch of Array.from(event.changedTouches)) {
        if ((touch as Touch & { touchType?: string }).touchType === 'stylus') {
          event.preventDefault()
          return
        }
      }
    }
    node.addEventListener('touchstart', refuseStylus, { passive: false })
    node.addEventListener('touchmove', refuseStylus, { passive: false })
    return () => {
      node.removeEventListener('touchstart', refuseStylus)
      node.removeEventListener('touchmove', refuseStylus)
    }
  }, [mode === null])

  // The tool was put down, or changed, with a stroke half made: it is let go.
  // Only a stroke of the tool that was in hand — this runs a moment after the
  // change, when the next tool may already be on the page.
  useEffect(() => {
    return () => {
      if (gesture.current?.mode !== mode) return
      gesture.current = null
      livePen.current?.removeAttribute('d')
      liveMarker.current?.removeAttribute('d')
      rubbed.current = new Set()
      setErased(NOTHING_ERASED)
    }
  }, [mode])

  // With no tool in hand there is no finger to move the paper for.
  useEffect(() => {
    if (mode === null) panning.current = null
  }, [mode === null])

  /** Where on the page a pointer is, as fractions of it. */
  const place = (event: PointerEvent, box = layer.current!.getBoundingClientRect()): Point => [
    (event.clientX - box.left) / box.width,
    (event.clientY - box.top) / box.height,
  ]

  const liveOf = (tool: InkMode): SVGPathElement | null =>
    tool === 'highlighter' ? liveMarker.current : tool === 'pen' ? livePen.current : null

  const rub = (from: Point, to: Point): void => {
    const { strokes } = latest.current
    const hit = erasedBy(strokes, from, to, ERASER_RADIUS_PX / width, height / width)
    if (hit.every((id) => rubbed.current.has(id))) return
    for (const id of hit) rubbed.current.add(id)
    setErased(new Set(rubbed.current))
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (mode === null) return
    if (event.pointerType === 'touch') {
      // A finger does not draw. Where the browser pans for it, there is
      // nothing to do; where it has been told not to, the paper is moved here.
      if (stylusGuard() === 'touch-action' && panning.current === null) {
        panning.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
      }
      return
    }
    if (gesture.current !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // No selection started under the stroke, no focus moved, and no mouse
    // events made of it for whatever listens for those.
    event.preventDefault()
    try {
      layer.current?.setPointerCapture(event.pointerId)
    } catch {
      /* A pointer the browser does not know: the stroke is drawn without. */
    }
    const at = place(event)
    gesture.current = { pointer: event.pointerId, mode, points: [at] }
    if (mode === 'eraser') rub(at, at)
    else liveOf(mode)?.setAttribute('d', strokePath([at], width, height))
  }

  const onPointerMove = (event: PointerEvent): void => {
    const pan = panning.current
    if (pan && pan.pointer === event.pointerId) {
      layer.current
        ?.closest('.pdf-scroll')
        ?.scrollBy(pan.x - event.clientX, pan.y - event.clientY)
      panning.current = { pointer: pan.pointer, x: event.clientX, y: event.clientY }
      return
    }
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    event.preventDefault()
    // Every place the pen was since the last frame, not only the latest.
    const reports = event.getCoalescedEvents?.() ?? []
    const steps = reports.length > 0 ? reports : [event]
    const box = layer.current!.getBoundingClientRect()
    for (const report of steps) {
      const at = place(report, box)
      if (current.mode === 'eraser') rub(current.points[current.points.length - 1]!, at)
      current.points.push(at)
    }
    if (current.mode === 'eraser') current.points = current.points.slice(-1)
    else liveOf(current.mode)?.setAttribute('d', strokePath(current.points, width, height))
  }

  const finish = (event: PointerEvent, keep: boolean): void => {
    if (panning.current?.pointer === event.pointerId) panning.current = null
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    gesture.current = null
    if (current.mode === 'eraser') {
      // Rubbed out so far, kept or not: a rubbing cut short is still meant.
      if (rubbed.current.size > 0) latest.current.onErase([...rubbed.current])
      rubbed.current = new Set()
      setErased(NOTHING_ERASED)
      return
    }
    liveOf(current.mode)?.removeAttribute('d')
    // Cut short by the browser — it took the gesture for a scroll — the
    // stroke is not one the hand finished, and is not kept.
    if (!keep) return
    const points = tidy(current.points, SIMPLIFY_PX / width, height / width)
    if (points.length === 0) return
    latest.current.onDraw({
      id: newStrokeId(),
      page: latest.current.pageNumber,
      tool: current.mode,
      color: latest.current.color,
      width: TOOL_WIDTH[current.mode],
      points,
    })
  }

  const classes = ['pdf-ink']
  if (mode !== null) classes.push('drawing', mode, `guard-${stylusGuard()}`)

  return (
    <div
      ref={layer}
      class={classes.join(' ')}
      style={{ width: `${width}px`, height: `${height}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
    >
      {(['highlighter', 'pen'] as const).map((tool) => (
        <svg
          key={tool}
          class={tool}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
        >
          {paths.map(
            ({ stroke, d }) =>
              stroke.tool === tool &&
              !erased.has(stroke.id) && (
                <path
                  key={stroke.id}
                  data-stroke={stroke.id}
                  d={d}
                  stroke={stroke.color}
                  stroke-width={Math.max(0.5, stroke.width * width)}
                  stroke-opacity={tool === 'highlighter' ? HIGHLIGHTER_OPACITY : undefined}
                />
              ),
          )}
          {/* The stroke under the pen. Its path is written by hand as the pen moves. */}
          <path
            ref={tool === 'pen' ? livePen : liveMarker}
            class="live"
            stroke={props.color}
            stroke-width={Math.max(0.5, TOOL_WIDTH[tool] * width)}
            stroke-opacity={tool === 'highlighter' ? HIGHLIGHTER_OPACITY : undefined}
          />
        </svg>
      ))}
    </div>
  )
}
