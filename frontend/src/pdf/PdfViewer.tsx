/**
 * The source panel: Mozilla's PDF.js rendering a continuously scrolling
 * document, with highlight overlays for every reference in it.
 *
 * Coordinate contract — stored rectangles are `[x0, y0, x1, y1]` in [0,1],
 * relative to the visible page after its native rotation and crop box have
 * been applied, origin top-left. PDF.js builds its viewport from that same
 * visible box, so the conversion below is an explicit multiply by the
 * viewport's width and height. CSS pixel values are never stored, and the
 * overlay is recomputed on every zoom change rather than scaled.
 *
 * Pages are laid out continuously, so a paper reads the way it would in any
 * other viewer. Only pages near the viewport are rasterised; the rest keep
 * correctly-sized placeholders, which keeps the scrollbar honest and memory
 * bounded on a long document.
 *
 * Which pages are drawn is worked out from where the pages are, every time
 * the view moves — not remembered from events about pages coming and going.
 * A page near the view is drawn; that is the whole rule, so there is no
 * sequence of scrolls, jumps and zooms that can leave a page in view blank.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// Bundled locally by Vite — nothing is fetched from a CDN at runtime.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { api, type DocumentRecord } from '../api'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3]
// Breathing room so a page is not flush against the panel edges.
const PAGE_MARGIN = 24
// Draw pages this far outside the viewport, so they are ready when scrolled to.
const RENDER_MARGIN_PX = 600
// Keep a drawn page until it is this far away; between the two distances a
// page stays as it is, so scrolling back and forth does not redraw it.
const DISCARD_MARGIN_PX = 3000
// Sharper than this buys nothing a reader can see, and costs memory fourfold.
const MAX_DEVICE_PIXEL_RATIO = 2
// A canvas past this many pixels fails to allocate in some browsers, and
// draws nothing without saying so. Zoomed far in, resolution gives way first.
const MAX_CANVAS_PIXELS = 4096 * 4096
// How long the panel's width must hold still before pages are redrawn to fit.
const FIT_SETTLE_MS = 90
// Above this many pages, assume a uniform size rather than measuring each one.
const MEASURE_LIMIT = 300

/** Where a mark comes from, which decides how it is drawn. */
export type MarkTone = 'active' | 'current-note' | 'other-note' | 'uncited'

export interface PdfMark {
  referenceId: string
  pageNumber: number
  rects: number[][]
  tone: MarkTone
  label: string
}

export interface PdfSelection {
  documentId: string
  pageNumber: number
  quote: string
  prefix: string
  suffix: string
}

export interface PdfViewerProps {
  document: DocumentRecord
  /** Every mark in this document, not only the one just opened. */
  marks: PdfMark[]
  /** Scroll target, used when a citation is opened from the editor. */
  gotoPage: number | null
  /** Changing this re-scrolls, even to the page already shown. */
  gotoNonce?: number
  onSelection: (selection: PdfSelection | null) => void
  onActivateMark?: (referenceId: string) => void
  onClose?: () => void
}

interface PageSize {
  width: number
  height: number
}

export function PdfViewer(props: PdfViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [error, setError] = useState<string | null>(null)
  const [zoomIndex, setZoomIndex] = useState(4)
  const [fitWidth, setFitWidth] = useState(true)
  const [available, setAvailable] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [rendered, setRendered] = useState<Set<number>>(() => new Set())

  const scroller = useRef<HTMLDivElement | null>(null)
  const pageNodes = useRef<Map<number, HTMLDivElement>>(new Map())

  /**
   * Report the page occupying most of the viewport.
   *
   * Deliberately measured from element rectangles rather than the observer's
   * `intersectionRatio`: the observer uses a generous `rootMargin` so pages
   * are rasterised before they scroll into view, and that margin inflates the
   * ratio — every nearby page reports 1.0, and the reader is told they are on
   * page 1 no matter where they have scrolled to.
   */
  const reportCurrentPage = useCallback(() => {
    const root = scroller.current
    if (!root) return
    const view = root.getBoundingClientRect()
    let best = 0
    let bestVisible = 0
    for (const [page, node] of pageNodes.current) {
      const box = node.getBoundingClientRect()
      const visible = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)
      if (visible > bestVisible + 0.5) {
        best = page
        bestVisible = visible
      }
    }
    if (best) {
      setCurrentPage(best)
      setPageInput(String(best))
    }
  }, [])

  /**
   * Decide which pages are drawn, from where they are now.
   *
   * A page within reach of the viewport is drawn; a drawn page is kept until
   * it is far away. Nothing is carried over but the set itself, so whatever
   * moved the view — a scroll, a jump to a cited page, a zoom, a resize — the
   * pages in view end up drawn.
   */
  const refresh = useCallback(() => {
    const root = scroller.current
    if (!root) return
    const view = root.getBoundingClientRect()
    if (view.height === 0) return
    const near = new Set<number>()
    const far = new Set<number>()
    for (const [page, node] of pageNodes.current) {
      const box = node.getBoundingClientRect()
      const distance = Math.max(view.top - box.bottom, box.top - view.bottom)
      if (distance < RENDER_MARGIN_PX) near.add(page)
      else if (distance > DISCARD_MARGIN_PX) far.add(page)
    }
    setRendered((previous) => {
      const next = new Set(near)
      for (const page of previous) if (!far.has(page)) next.add(page)
      if (next.size === previous.size && [...next].every((page) => previous.has(page))) {
        return previous
      }
      return next
    })
    reportCurrentPage()
  }, [reportCurrentPage])

  /** Once per frame at most, and after layout: positions are read, not guessed. */
  const refreshFrame = useRef(0)
  const scheduleRefresh = useCallback(() => {
    if (refreshFrame.current) return
    refreshFrame.current = window.requestAnimationFrame(() => {
      refreshFrame.current = 0
      refresh()
    })
  }, [refresh])

  const url = useMemo(
    () => api.pdfUrl(props.document.document_id),
    [props.document.document_id],
  )
  const total = sizes.length || props.document.page_count || 1

  // ------------------------------------------------------------------ load

  useEffect(() => {
    let cancelled = false
    setError(null)
    setPdf(null)
    setSizes([])
    setRendered(new Set())
    setCurrentPage(1)
    setPageInput('1')

    const task = pdfjs.getDocument({ url, isEvalSupported: false })
    task.promise.then(
      async (loaded) => {
        if (cancelled) {
          void loaded.destroy()
          return
        }
        setPdf(loaded)
        // Placeholders need each page's unscaled size so the scrollbar is
        // correct before anything has been rasterised.
        const count = loaded.numPages
        try {
          const measured =
            count <= MEASURE_LIMIT
              ? await Promise.all(
                  Array.from({ length: count }, async (_unused, index) => {
                    const page = await loaded.getPage(index + 1)
                    const viewport = page.getViewport({ scale: 1 })
                    page.cleanup()
                    return { width: viewport.width, height: viewport.height }
                  }),
                )
              : await (async () => {
                  const first = await loaded.getPage(1)
                  const viewport = first.getViewport({ scale: 1 })
                  first.cleanup()
                  return Array.from({ length: count }, () => ({
                    width: viewport.width,
                    height: viewport.height,
                  }))
                })()
          if (!cancelled) setSizes(measured)
        } catch {
          if (!cancelled) setSizes([])
        }
      },
      (reason: unknown) => {
        if (cancelled) return
        setError(
          reason instanceof Error
            ? `This PDF could not be displayed: ${reason.message}`
            : 'This PDF could not be displayed.',
        )
      },
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url])

  // ---------------------------------------------------------------- sizing

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    setAvailable(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    // Dragging a panel edge changes the width at every frame. Redrawing every
    // page to fit each of those widths starts renders only to cancel them;
    // wait until the width holds still, then fit once.
    let timer = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setAvailable(node.clientWidth), FIT_SETTLE_MS)
      scheduleRefresh()
    })
    observer.observe(node)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [pdf])

  const scale = useMemo(() => {
    const base = sizes[0]
    if (fitWidth && available && base) {
      return Math.max(0.1, (available - PAGE_MARGIN) / base.width)
    }
    return ZOOM_STEPS[zoomIndex] ?? 1
  }, [fitWidth, available, sizes, zoomIndex])

  const zoomTo = useCallback((index: number) => {
    setFitWidth(false)
    setZoomIndex(Math.min(Math.max(0, index), ZOOM_STEPS.length - 1))
  }, [])

  // ------------------------------------------------- which pages to render

  // Recomputed whenever the layout can have changed: page sizes, zoom, and
  // the pages themselves appearing.
  useEffect(() => {
    scheduleRefresh()
  }, [sizes, scale, pdf])

  useEffect(() => {
    const root = scroller.current
    if (!root) return
    root.addEventListener('scroll', scheduleRefresh, { passive: true })
    return () => {
      root.removeEventListener('scroll', scheduleRefresh)
      if (refreshFrame.current) window.cancelAnimationFrame(refreshFrame.current)
      refreshFrame.current = 0
    }
  }, [pdf])

  // ------------------------------------------------------------- scrolling

  const scrollToPage = useCallback((page: number) => {
    pageNodes.current.get(page)?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [])

  useEffect(() => {
    const target = props.gotoPage
    if (!target || sizes.length === 0) return
    // A frame's grace so the placeholder exists at its final height.
    const timer = window.setTimeout(() => scrollToPage(target), 60)
    return () => window.clearTimeout(timer)
  }, [props.gotoPage, props.gotoNonce, sizes.length, scrollToPage])

  const go = (next: number): void => {
    const clamped = Math.min(Math.max(1, next), total)
    setPageInput(String(clamped))
    window.setTimeout(() => scrollToPage(clamped), 30)
  }

  // ----------------------------------------------------------------- marks

  const marksByPage = useMemo(() => {
    const grouped = new Map<number, PdfMark[]>()
    for (const mark of props.marks) {
      if (mark.rects.length === 0) continue
      const list = grouped.get(mark.pageNumber)
      if (list) list.push(mark)
      else grouped.set(mark.pageNumber, [mark])
    }
    return grouped
  }, [props.marks])

  const counts = useMemo(() => {
    const tally = { current: 0, other: 0, uncited: 0 }
    for (const mark of props.marks) {
      if (mark.rects.length === 0) continue
      if (mark.tone === 'current-note' || mark.tone === 'active') tally.current += 1
      else if (mark.tone === 'other-note') tally.other += 1
      else tally.uncited += 1
    }
    return tally
  }, [props.marks])

  const captureSelection = useCallback(
    (pageNumber: number, layer: HTMLDivElement | null): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !layer) {
        props.onSelection(null)
        return
      }
      if (!layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) {
        return
      }
      const quote = selection.toString().replace(/\s+/g, ' ').trim()
      if (quote.length < 3) {
        props.onSelection(null)
        return
      }
      const whole = (layer.textContent ?? '').replace(/\s+/g, ' ')
      const at = whole.indexOf(quote)
      props.onSelection({
        documentId: props.document.document_id,
        pageNumber,
        quote,
        prefix: at > 0 ? whole.slice(Math.max(0, at - 60), at) : '',
        suffix: at >= 0 ? whole.slice(at + quote.length, at + quote.length + 60) : '',
      })
    },
    [props.document.document_id, props.onSelection],
  )

  return (
    <section class="pdf" aria-label="Source panel">
      <header class="pdf-bar">
        <div class="pdf-title" title={props.document.original_filename}>
          <strong>{props.document.display_title}</strong>
          <span class="muted">{props.document.original_filename}</span>
        </div>
        {props.onClose && (
          <button
            type="button"
            class="ghost"
            onClick={props.onClose}
            title="Close the source panel"
          >
            ✕
          </button>
        )}
      </header>

      <div class="pdf-controls">
        <button type="button" onClick={() => go(currentPage - 1)} disabled={currentPage <= 1}>
          ‹
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = Number.parseInt(pageInput, 10)
            if (Number.isFinite(parsed)) go(parsed)
          }}
        >
          <input
            type="text"
            value={pageInput}
            onInput={(event) => setPageInput((event.target as HTMLInputElement).value)}
            aria-label="Page number"
            size={3}
          />
        </form>
        <span class="muted">of {total}</span>
        <button
          type="button"
          onClick={() => go(currentPage + 1)}
          disabled={currentPage >= total}
        >
          ›
        </button>
        <span class="spacer" />
        <button
          type="button"
          onClick={() => zoomTo(nearestZoomIndex(scale) - 1)}
          disabled={!fitWidth && zoomIndex === 0}
          title="Zoom out"
        >
          −
        </button>
        <span class="muted zoom">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          onClick={() => zoomTo(nearestZoomIndex(scale) + 1)}
          disabled={!fitWidth && zoomIndex === ZOOM_STEPS.length - 1}
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          class={fitWidth ? 'fit active' : 'fit'}
          onClick={() => setFitWidth(true)}
          title="Fit the page to the panel width"
        >
          Fit
        </button>
      </div>

      {(counts.current > 0 || counts.other > 0 || counts.uncited > 0) && (
        <div class="pdf-legend" aria-label="Highlight key">
          {counts.current > 0 && (
            <span class="key current-note">
              <i />
              this note ({counts.current})
            </span>
          )}
          {counts.other > 0 && (
            <span class="key other-note">
              <i />
              elsewhere ({counts.other})
            </span>
          )}
          {counts.uncited > 0 && (
            <span class="key uncited">
              <i />
              not cited yet ({counts.uncited})
            </span>
          )}
        </div>
      )}

      {error !== null && <p class="pdf-error">{error}</p>}
      {!pdf && !error && <p class="pdf-loading">Opening the PDF…</p>}

      <div class="pdf-scroll" ref={scroller}>
        {pdf &&
          sizes.map((size, index) => {
            const pageNumber = index + 1
            return (
              <PdfPage
                key={pageNumber}
                pdf={pdf}
                pageNumber={pageNumber}
                size={size}
                scale={scale}
                active={rendered.has(pageNumber)}
                marks={marksByPage.get(pageNumber) ?? []}
                onActivateMark={props.onActivateMark}
                onSelection={captureSelection}
                register={(node) => {
                  if (node) pageNodes.current.set(pageNumber, node)
                  else pageNodes.current.delete(pageNumber)
                  // A page that has just appeared may already be in view.
                  scheduleRefresh()
                }}
              />
            )
          })}
      </div>
    </section>
  )
}

interface PdfPageProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  size: PageSize
  scale: number
  active: boolean
  marks: PdfMark[]
  onActivateMark?: (referenceId: string) => void
  onSelection: (pageNumber: number, layer: HTMLDivElement | null) => void
  register: (node: HTMLDivElement | null) => void
}

function PdfPage(props: PdfPageProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const textLayer = useRef<HTMLDivElement | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const width = Math.floor(props.size.width * props.scale)
  const height = Math.floor(props.size.height * props.scale)

  useEffect(() => {
    props.register(host.current)
    return () => props.register(null)
  }, [])

  // Not near the view: drop the bitmap. The sized placeholder keeps the
  // layout, and the scrollbar, exactly as they were.
  useEffect(() => {
    if (props.active) return
    surface.current?.replaceChildren()
    textLayer.current?.replaceChildren()
    setDrawn(false)
    setFailure(null)
  }, [props.active])

  useEffect(() => {
    if (!props.active) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    let text: { cancel: () => void } | null = null
    setFailure(null)

    void (async () => {
      try {
        const page = await props.pdf.getPage(props.pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale: props.scale })

        let ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
        const pixels = viewport.width * viewport.height * ratio * ratio
        if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels)

        // A canvas of its own for every render. PDF.js refuses to draw twice
        // on one canvas at a time, and a render being cancelled may not have
        // let go of it yet; a fresh one cannot collide. It also means the
        // picture already on the page stays there, stretched to the new size,
        // until the sharp one is ready — a zoom never flashes blank.
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('This browser gave no canvas to draw on.')

        const render = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        task = render
        await render.promise
        if (cancelled) return
        surface.current?.replaceChildren(canvas)
        setDrawn(true)

        // PDF.js's own text layer, so selections line up with the glyphs.
        const layer = textLayer.current
        if (layer) {
          layer.replaceChildren()
          const built = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container: layer,
            viewport,
          })
          text = built
          await built.render()
        }
      } catch (error) {
        // Superseded by a newer render, or the page was released: expected.
        if (cancelled || (error as { name?: string })?.name === 'RenderingCancelledException') {
          return
        }
        // Anything else is a page that is blank for a reason. Say so on the
        // page, where it can be tried again, instead of leaving it empty.
        console.error(`Page ${props.pageNumber} could not be drawn`, error)
        setFailure(error instanceof Error ? error.message : 'Unknown error')
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
      text?.cancel()
    }
  }, [props.pdf, props.pageNumber, props.scale, props.active, attempt])

  return (
    <div
      class="pdf-page"
      ref={host}
      data-page={props.pageNumber}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        // PDF.js sizes the spans of its text layer from these. Without them
        // every span falls back to the page's font size: the text one selects
        // is then far larger than the text one sees, and off to the side.
        '--scale-factor': String(props.scale),
        '--total-scale-factor': String(props.scale),
      }}
      onMouseUp={() => props.onSelection(props.pageNumber, textLayer.current)}
      onTouchEnd={() => props.onSelection(props.pageNumber, textLayer.current)}
    >
      <div class="pdf-surface" ref={surface} />
      <div class="pdf-text-layer" ref={textLayer} />
      <div class="pdf-overlay" style={{ width: `${width}px`, height: `${height}px` }}>
        {props.marks.map((mark) =>
          mark.rects.map((rect, index) => {
            const [x0, y0, x1, y1] = rect as [number, number, number, number]
            return (
              <div
                key={`${mark.referenceId}-${index}`}
                class={`pdf-highlight ${mark.tone}`}
                data-reference={mark.referenceId}
                data-tone={mark.tone}
                title={mark.label}
                role={props.onActivateMark ? 'button' : undefined}
                onClick={() => props.onActivateMark?.(mark.referenceId)}
                style={{
                  left: `${x0 * width}px`,
                  top: `${y0 * height}px`,
                  width: `${Math.max(1, (x1 - x0) * width)}px`,
                  height: `${Math.max(1, (y1 - y0) * height)}px`,
                }}
              />
            )
          }),
        )}
      </div>
      {failure !== null ? (
        <div class="pdf-placeholder failed" role="alert">
          <span>Page {props.pageNumber} could not be drawn.</span>
          <span class="muted">{failure}</span>
          <button type="button" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </button>
        </div>
      ) : (
        !drawn && <span class="pdf-placeholder muted">{props.pageNumber}</span>
      )}
    </div>
  )
}

/** The zoom step closest to an arbitrary scale, so Fit hands over smoothly. */
function nearestZoomIndex(scale: number): number {
  let best = 0
  for (let index = 1; index < ZOOM_STEPS.length; index += 1) {
    if (Math.abs(ZOOM_STEPS[index]! - scale) < Math.abs(ZOOM_STEPS[best]! - scale)) {
      best = index
    }
  }
  return best
}
