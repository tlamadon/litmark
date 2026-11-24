/**
 * A deliberately limited Markdown live-preview extension for CodeMirror 6.
 *
 * Markdown source stays authoritative: every decoration either styles the
 * existing text or hides syntax that the cursor is not currently inside. No
 * document conversion happens, so whitespace and syntax outside the user's
 * edits are preserved byte-for-byte, and cursor movement, selection, copy,
 * undo, and redo all operate on the underlying text.
 *
 * CodeMirror gives us decorations and a Markdown syntax tree; the behaviour
 * below — revealing delimiters around the active range and hiding them again —
 * is this file's own work.
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  EditorSelection,
  type EditorState,
  Range,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import katex from 'katex'

import { findTables, renderInline, type TableBlock } from '../markdown'
import type { KnownPaper } from '../papers'

/** Toggles the Source-mode view, which shows the complete Markdown text. */
export const setSourceMode = StateEffect.define<boolean>()

export const sourceMode = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSourceMode)) return effect.value
    }
    return value
  },
})

/**
 * Which citations to pick out: those of the passage on show in the paper, and
 * among them the one the reader was just taken to.
 *
 * Kept apart from the selection on purpose. Going from a highlight in the PDF
 * to the sentence that cites it should show where that is — not put the cursor
 * there, open the link's syntax for editing, and start a session of typing.
 */
export interface ActiveCitation {
  referenceId: string | null
  /** Where the citation gone to starts, when one was. */
  at: number | null
}

/** Names the reference whose citations are picked out; a new one forgets `at`. */
export const setActiveReference = StateEffect.define<string | null>()
/** Marks the one citation the reader was taken to. */
export const setRevealedCitation = StateEffect.define<number | null>()

export const activeCitation = StateField.define<ActiveCitation>({
  create: () => ({ referenceId: null, at: null }),
  update(value, transaction) {
    let next = value
    if (transaction.docChanged && next.at !== null) {
      next = { ...next, at: transaction.changes.mapPos(next.at) }
    }
    for (const effect of transaction.effects) {
      if (effect.is(setActiveReference) && effect.value !== next.referenceId) {
        next = { referenceId: effect.value, at: null }
      } else if (effect.is(setRevealedCitation)) {
        next = { ...next, at: effect.value }
      }
    }
    return next
  },
})

/**
 * The papers in the library, so a `paper:` link can say what it names — or
 * that the paper it names is no longer there.
 */
export const setKnownPapers = StateEffect.define<readonly KnownPaper[]>()

export const knownPapers = StateField.define<readonly KnownPaper[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setKnownPapers)) return effect.value
    }
    return value
  },
})

/** How a citation is shown: of the passage on show, or of some other. */
type CitationTone = 'active' | 'other'

function citationClass(tone: CitationTone, revealed: boolean): string {
  return `cm-citation ${tone}${revealed ? ' revealed' : ''}`
}

/**
 * Reading or editing.
 *
 * Most time with a summary or a note is spent reading it. Reading, the text is
 * shown fully rendered and stays that way: a click does not put a cursor down
 * and open the Markdown under it, and a click on a citation simply opens what
 * it cites. Editing is the mode this file was first written for, in which the
 * syntax around the cursor is revealed.
 */
export const setReadingMode = StateEffect.define<boolean>()

export const readingMode = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setReadingMode)) return effect.value
    }
    return value
  },
})

export interface LivePreviewOptions {
  /**
   * Invoked for a click on a `source:` link while reading, for Cmd/Ctrl-click
   * on one while editing, and by the toolbar action.
   */
  onOpenSource?: (referenceId: string) => void
  /**
   * Invoked for a `paper:` link: on a click while reading, and on
   * Cmd/Ctrl-click while editing.
   */
  onOpenPaper?: (documentId: string) => void
  onOpenLink?: (href: string) => void
  /** Whether the buffer opens for reading rather than editing. */
  reading?: boolean
}

/**
 * The `source:` reference the cursor sits in, if any.
 *
 * Cmd/Ctrl-click is a shortcut, not the only way in: the editor toolbar uses
 * this to offer a visible "Open source" action, which is what a reader who
 * never learns the shortcut will actually find.
 */
export function sourceReferenceAt(
  state: EditorState,
  position: number,
  // The tree the editor has parsed so far, which may stop short of the end of
  // a long note; a caller that has parsed further passes what it got.
  tree: Tree = syntaxTree(state),
): string | null {
  for (const bias of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(position, bias)
    while (node) {
      if (node.name === 'Link') {
        const url = node.getChild('URL')
        if (url) {
          const href = state.doc.sliceString(url.from, url.to)
          if (href.startsWith('source:')) return href.slice('source:'.length)
        }
      }
      node = node.parent
    }
  }
  return null
}

/** Where a reference is cited in a document: each `[…](source:id)` that is a real link. */
export function citationsOf(state: EditorState, referenceId: string): { from: number; to: number }[] {
  const escaped = referenceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\[[^\\]\\n]*\\]\\(source:${escaped}\\)`, 'g')
  // Parsed to the end, so a citation far down a long note is recognised too.
  // The editor itself parses only as far as it has shown, and a note opened in
  // order to go to a citation has shown nothing yet.
  const tree = ensureSyntaxTree(state, state.doc.length, 500)
  const spots: { from: number; to: number }[] = []
  for (const match of state.doc.toString().matchAll(pattern)) {
    const from = match.index ?? 0
    const to = from + match[0].length
    // The same text inside a code block is an example of the syntax, not a
    // citation; the syntax tree knows the difference.
    if (!tree || sourceReferenceAt(state, to - 1, tree) === referenceId) spots.push({ from, to })
  }
  return spots
}

// ------------------------------------------------------------------ widgets

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly href: string,
    readonly from: number,
    readonly options: LivePreviewOptions,
    /** For a citation: whether it is of the passage on show, and the one gone to. */
    readonly tone: CitationTone = 'other',
    readonly revealed = false,
    /** Reading: a click follows the link rather than opening it for editing. */
    readonly reading = false,
    /** For a `paper:` link: the paper's title, or null if it is not in the library. */
    readonly paper: string | null = null,
  ) {
    super()
  }

  eq(other: LinkWidget): boolean {
    return (
      other.label === this.label &&
      other.href === this.href &&
      other.from === this.from &&
      other.tone === this.tone &&
      other.revealed === this.revealed &&
      other.reading === this.reading &&
      other.paper === this.paper
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const anchor = document.createElement('span')
    const isSource = this.href.startsWith('source:')
    const isPaper = this.href.startsWith(PAPER_SCHEME)
    anchor.className = isSource
      ? `cm-source-link ${citationClass(this.tone, this.revealed)}`
      : isPaper
        ? `cm-paper-link${this.paper === null ? ' missing' : ''}`
        : 'cm-link'
    anchor.textContent = this.label
    anchor.title = isSource
      ? this.reading
        ? `${this.href} — open the cited page`
        : `${this.href} — Cmd/Ctrl-click to open the cited page`
      : isPaper
        ? this.paper === null
          ? 'This paper is not in the library (any more)'
          : `${this.paper} — ${this.reading ? 'open' : 'Cmd/Ctrl-click to open'} the paper`
        : this.href
    anchor.setAttribute('role', 'link')
    anchor.setAttribute('tabindex', '0')
    const open = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (isSource) this.options.onOpenSource?.(this.href.slice('source:'.length))
      else if (isPaper) {
        if (this.paper !== null) this.options.onOpenPaper?.(this.href.slice(PAPER_SCHEME.length))
      } else this.options.onOpenLink?.(this.href)
    }
    anchor.addEventListener('mousedown', (event) => {
      // Reading, a link is a link: one click goes where it points.
      if (this.reading || event.metaKey || event.ctrlKey) {
        open(event)
        return
      }
      // A rendered link is an atomic range, so a plain click would otherwise
      // land beside it and leave the toolbar's "Open source" disabled — which
      // reads as the citation being dead. Move the cursor into the link
      // instead: that reveals its Markdown syntax for editing and arms the
      // visible action, keeping the shortcut optional rather than required.
      event.preventDefault()
      view.dispatch({ selection: { anchor: this.from + 1 } })
      view.focus()
    })
    anchor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') open(event)
    })
    return anchor
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'keydown'
  }
}

const PAPER_SCHEME = 'paper:'

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }

  toDOM(): HTMLElement {
    const host = document.createElement('span')
    host.className = this.display ? 'cm-math cm-math-display' : 'cm-math'
    try {
      // `throwOnError: false` renders invalid math as flagged output rather
      // than throwing, and the source is still revealed when the cursor enters.
      host.innerHTML = katex.renderToString(this.tex, {
        displayMode: this.display,
        throwOnError: false,
        errorColor: 'var(--danger)',
        output: 'html',
      })
    } catch {
      host.classList.add('cm-math-error')
      host.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`
    }
    return host
  }
}

/**
 * A table, drawn as one.
 *
 * Pipes and dashes are how a table is written, not how it is read. Until the
 * cursor is put inside it, the lines are replaced by the table they describe;
 * with the cursor there, they are shown as written, to be edited. The cells
 * are ordinary inline Markdown, and a citation or a paper named in one is a
 * link as it would be in a paragraph.
 */
class TableWidget extends WidgetType {
  constructor(
    /** The lines as written: two tables are the same when these are. */
    readonly source: string,
    readonly table: TableBlock,
    readonly from: number,
    readonly options: LivePreviewOptions,
    readonly activeReference: string | null,
    readonly papers: readonly KnownPaper[],
    readonly reading: boolean,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.from === this.from &&
      other.activeReference === this.activeReference &&
      other.papers === this.papers &&
      other.reading === this.reading
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const table = document.createElement('table')
    const { header, align, rows } = this.table
    const row = (cells: string[], tag: 'th' | 'td'): HTMLTableRowElement => {
      const line = document.createElement('tr')
      header.forEach((_unused, column) => {
        const cell = document.createElement(tag)
        // Escaped and limited to a fixed set of constructs in renderInline.
        cell.innerHTML = renderInline(cells[column] ?? '')
        if (align[column]) cell.style.textAlign = align[column]!
        line.append(cell)
      })
      return line
    }
    const head = document.createElement('thead')
    head.append(row(header, 'th'))
    const body = document.createElement('tbody')
    for (const cells of rows) body.append(row(cells, 'td'))
    table.append(head, body)
    wrap.append(table)

    // The links inside look and behave as they do in a paragraph.
    for (const link of wrap.querySelectorAll<HTMLElement>('[data-source-ref]')) {
      const tone: CitationTone = link.dataset.sourceRef === this.activeReference ? 'active' : 'other'
      link.className = `cm-source-link ${citationClass(tone, false)}`
    }
    for (const link of wrap.querySelectorAll<HTMLElement>('[data-paper]')) {
      const known = this.papers.find((paper) => paper.documentId === link.dataset.paper)
      link.className = known ? 'cm-paper-link' : 'cm-paper-link missing'
      link.title = known ? known.title : 'This paper is not in the library (any more)'
    }

    wrap.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement | null
      const follow = this.reading || event.metaKey || event.ctrlKey
      const cited = target?.closest<HTMLElement>('[data-source-ref]')?.dataset.sourceRef
      const paper = target?.closest<HTMLElement>('[data-paper]')
      if (follow && cited) {
        event.preventDefault()
        this.options.onOpenSource?.(cited)
        return
      }
      if (follow && paper) {
        event.preventDefault()
        if (!paper.classList.contains('missing')) this.options.onOpenPaper?.(paper.dataset.paper!)
        return
      }
      // An ordinary link opens as links do; and reading, a click is only a click.
      if (target?.closest('a[href]') || this.reading) return
      // Editing: the click is on the table to change it. Put the cursor in,
      // which shows it as written.
      event.preventDefault()
      view.dispatch({ selection: { anchor: this.from } })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown'
  }
}

const TABLE_SOURCE_LINE = Decoration.line({ class: 'cm-table-source' })

/**
 * Tables, as decorations. A table drawn in place of its lines changes the
 * height of what is shown, which only decorations held in the state may do —
 * so these are kept apart from the rest, in a field of their own.
 */
function tableDecorations(state: EditorState, options: LivePreviewOptions): DecorationSet {
  if (state.field(sourceMode, false)) return Decoration.none
  const doc = state.doc
  const reading = state.field(readingMode, false) ?? false
  const active = state.field(activeCitation, false)?.referenceId ?? null
  const papers = state.field(knownPapers, false) ?? []
  const lines = doc.toString().split('\n')
  const ranges: Range<Decoration>[] = []
  for (const table of findTables(lines)) {
    const from = doc.line(table.fromLine + 1).from
    const to = doc.line(table.toLine + 1).to
    if (!reading && touchesSelection(state.selection, from, to)) {
      // Being edited: as written, in a face where the columns line up.
      for (let line = table.fromLine + 1; line <= table.toLine + 1; line += 1) {
        ranges.push(TABLE_SOURCE_LINE.range(doc.line(line).from))
      }
      continue
    }
    const source = lines.slice(table.fromLine, table.toLine + 1).join('\n')
    ranges.push(
      Decoration.replace({
        widget: new TableWidget(source, table, from, options, active, papers, reading),
        block: true,
      }).range(from, to),
    )
  }
  return Decoration.set(ranges, true)
}

function tableField(options: LivePreviewOptions): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => tableDecorations(state, options),
    update(value, transaction) {
      const before = transaction.startState
      const after = transaction.state
      if (
        transaction.docChanged ||
        transaction.selection !== undefined ||
        before.field(sourceMode, false) !== after.field(sourceMode, false) ||
        before.field(readingMode, false) !== after.field(readingMode, false) ||
        before.field(knownPapers, false) !== after.field(knownPapers, false) ||
        before.field(activeCitation, false)?.referenceId !==
          after.field(activeCitation, false)?.referenceId
      ) {
        return tableDecorations(after, options)
      }
      return value
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}

class BulletWidget extends WidgetType {
  constructor(readonly marker: string) {
    super()
  }

  eq(other: BulletWidget): boolean {
    return other.marker === this.marker
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-list-bullet'
    span.textContent = this.marker
    return span
  }
}

// ------------------------------------------------------------- decorations

const hidden = Decoration.replace({})

const HEADING_LINE = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-heading cm-h${level}` }),
)
const QUOTE_LINE = Decoration.line({ class: 'cm-quote' })
const CODE_LINE = Decoration.line({ class: 'cm-codeblock' })
const EMPHASIS = Decoration.mark({ class: 'cm-emphasis' })
const STRONG = Decoration.mark({ class: 'cm-strong' })
const STRIKE = Decoration.mark({ class: 'cm-strike' })
const INLINE_CODE = Decoration.mark({ class: 'cm-inline-code' })

function touchesSelection(selection: EditorSelection, from: number, to: number): boolean {
  for (const range of selection.ranges) {
    if (range.from <= to && range.to >= from) return true
  }
  return false
}

interface MathRange {
  from: number
  to: number
  tex: string
  display: boolean
}

/**
 * Find `$…$` and `$$…$$` spans. Math is not part of the Markdown grammar, so
 * it is scanned directly; ranges inside code are dropped by the caller.
 */
function findMath(text: string): MathRange[] {
  const out: MathRange[] = []
  let index = 0
  while (index < text.length) {
    const dollar = text.indexOf('$', index)
    if (dollar === -1) break
    if (text[dollar - 1] === '\\') {
      index = dollar + 1
      continue
    }
    const display = text[dollar + 1] === '$'
    const fence = display ? '$$' : '$'
    const start = dollar + fence.length
    let end = -1
    let cursor = start
    while (cursor < text.length) {
      const candidate = text.indexOf(fence, cursor)
      if (candidate === -1) break
      if (text[candidate - 1] === '\\') {
        cursor = candidate + 1
        continue
      }
      end = candidate
      break
    }
    if (end === -1) break
    const tex = text.slice(start, end)
    // Inline math must not span a blank line. `$ x$` is not math, and neither
    // is `$5 and then $7` — requiring a non-digit after the opening `$` keeps
    // prose about money from rendering as equations.
    const spansBlankLine = /\n\s*\n/.test(tex)
    const plausible =
      tex.trim().length > 0 &&
      (display || (!/^[\s\d]/.test(tex) && !/\s$/.test(tex)))
    if (plausible && !spansBlankLine) {
      out.push({ from: dollar, to: end + fence.length, tex, display })
      index = end + fence.length
    } else {
      index = dollar + fence.length
    }
  }
  return out
}

function buildDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  if (view.state.field(sourceMode, false)) return Decoration.none

  const { state } = view
  const selection = state.selection
  const active = state.field(activeCitation, false) ?? { referenceId: null, at: null }
  // Reading, nothing is opened up around the selection: the text stays as
  // rendered wherever one clicks or selects.
  const reading = state.field(readingMode, false) ?? false
  const touched = (from: number, to: number): boolean =>
    !reading && touchesSelection(selection, from, to)
  const ranges: Range<Decoration>[] = []
  const codeRanges: [number, number][] = []
  const papers = state.field(knownPapers, false) ?? []
  const doc = state.doc

  const tree = syntaxTree(state)
  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      const name = node.name
      const from = node.from
      const to = node.to

      // ---- block level: the whole line reveals its own markers
      const headingMatch = /^ATXHeading(\d)$/.exec(name)
      if (headingMatch) {
        const level = Number(headingMatch[1])
        const line = doc.lineAt(from)
        ranges.push(HEADING_LINE[level - 1]!.range(line.from))
        if (!touched(line.from, line.to)) {
          const mark = node.node.getChild('HeaderMark')
          if (mark) {
            // Hide the hashes and the space that follows them.
            const after = doc.sliceString(mark.to, Math.min(mark.to + 1, doc.length))
            ranges.push(hidden.range(mark.from, mark.to + (after === ' ' ? 1 : 0)))
          }
        }
        return
      }

      if (name === 'Blockquote') {
        for (let position = from; position <= to; ) {
          const line = doc.lineAt(position)
          ranges.push(QUOTE_LINE.range(line.from))
          position = line.to + 1
        }
        return
      }

      if (name === 'QuoteMark') {
        const line = doc.lineAt(from)
        if (!touched(line.from, line.to)) {
          const after = doc.sliceString(to, Math.min(to + 1, doc.length))
          ranges.push(hidden.range(from, to + (after === ' ' ? 1 : 0)))
        }
        return
      }

      if (name === 'FencedCode' || name === 'CodeBlock') {
        codeRanges.push([from, to])
        for (let position = from; position <= to; ) {
          const line = doc.lineAt(position)
          ranges.push(CODE_LINE.range(line.from))
          position = line.to + 1
        }
        return
      }

      if (name === 'ListMark') {
        const line = doc.lineAt(from)
        const marker = doc.sliceString(from, to)
        // Ordered markers carry meaning, so only bullets are prettified.
        if (!touched(line.from, line.to) && /^[-*+]$/.test(marker)) {
          ranges.push(
            Decoration.replace({ widget: new BulletWidget('•') }).range(from, to),
          )
        }
        return
      }

      // ---- inline level: reveal delimiters only around the active range
      if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough') {
        const decoration =
          name === 'Emphasis' ? EMPHASIS : name === 'StrongEmphasis' ? STRONG : STRIKE
        ranges.push(decoration.range(from, to))
        if (!touched(from, to)) {
          for (const child of node.node.getChildren(
            name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark',
          )) {
            ranges.push(hidden.range(child.from, child.to))
          }
        }
        return
      }

      if (name === 'InlineCode') {
        ranges.push(INLINE_CODE.range(from, to))
        codeRanges.push([from, to])
        if (!touched(from, to)) {
          for (const child of node.node.getChildren('CodeMark')) {
            ranges.push(hidden.range(child.from, child.to))
          }
        }
        return
      }

      if (name === 'Link') {
        const url = node.node.getChild('URL')
        const marks = node.node.getChildren('LinkMark')
        if (!url) return
        // A citation is tinted the way its passage is in the paper: the one
        // on show in one colour, the rest in another.
        const target = doc.sliceString(url.from, url.to)
        const cited = target.startsWith('source:') ? target.slice('source:'.length) : null
        const tone: CitationTone = cited !== null && cited === active.referenceId ? 'active' : 'other'
        const revealed = tone === 'active' && active.at === from
        if (touched(from, to)) {
          // Being edited: the syntax is shown, and keeps its tint.
          if (cited !== null) {
            ranges.push(Decoration.mark({ class: citationClass(tone, revealed) }).range(from, to))
          }
          return
        }
        if (marks.length < 2) return
        // `[label](href)` → the label alone, as a readable link.
        const labelFrom = marks[0]!.to
        const labelTo = marks[1]!.from
        const label = doc.sliceString(labelFrom, labelTo)
        const href = doc.sliceString(url.from, url.to)
        if (!label) return
        const paper = href.startsWith(PAPER_SCHEME)
          ? (papers.find((known) => known.documentId === href.slice(PAPER_SCHEME.length))?.title ??
            null)
          : null
        ranges.push(
          Decoration.replace({
            widget: new LinkWidget(label, href, from, options, tone, revealed, reading, paper),
          }).range(from, to),
        )
        return
      }
    },
  })

  // ---- math, after code ranges are known
  const text = doc.toString()
  for (const math of findMath(text)) {
    const insideCode = codeRanges.some(([from, to]) => math.from >= from && math.to <= to)
    if (insideCode) continue
    if (touched(math.from, math.to)) continue
    ranges.push(
      Decoration.replace({
        widget: new MathWidget(math.tex, math.display),
      }).range(math.from, math.to),
    )
  }

  return Decoration.set(ranges, true)
}

// --------------------------------------------------------------- extension

class LivePreviewPlugin {
  decorations: DecorationSet
  /** Only the rendered widgets, which the cursor should step over. */
  atomic: DecorationSet

  constructor(
    view: EditorView,
    private readonly options: LivePreviewOptions,
  ) {
    const built = buildDecorations(view, options)
    this.decorations = built
    this.atomic = widgetsOnly(view, built)
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.startState.field(sourceMode, false) !== update.state.field(sourceMode, false) ||
      update.startState.field(activeCitation, false) !== update.state.field(activeCitation, false) ||
      update.startState.field(readingMode, false) !== update.state.field(readingMode, false) ||
      update.startState.field(knownPapers, false) !== update.state.field(knownPapers, false) ||
      // The parser works in the background and reaches the end of a long note
      // late; what it finds there has to be drawn when it does.
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.decorations = buildDecorations(update.view, this.options)
      this.atomic = widgetsOnly(update.view, this.decorations)
    }
  }
}

/**
 * Restrict a decoration set to widget replacements.
 *
 * Only these should be atomic: making a styling mark atomic would stop the
 * cursor moving through emphasised or quoted text, and hidden delimiters must
 * stay enterable so that touching them reveals the syntax.
 */
function widgetsOnly(view: EditorView, source: DecorationSet): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const cursor = source.iter()
  while (cursor.value) {
    const spec = cursor.value.spec as { widget?: WidgetType }
    if (spec.widget) ranges.push(cursor.value.range(cursor.from, cursor.to))
    cursor.next()
  }
  void view
  return Decoration.set(ranges, true)
}

export function livePreview(options: LivePreviewOptions = {}): Extension {
  const plugin = ViewPlugin.define((view) => new LivePreviewPlugin(view, options), {
    decorations: (instance) => instance.decorations,
  })
  return [
    sourceMode,
    activeCitation,
    readingMode.init(() => options.reading ?? false),
    knownPapers,
    tableField(options),
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    theme,
  ]
}

const theme = EditorView.baseTheme({
  '.cm-heading': { fontWeight: '600', lineHeight: '1.3' },
  '.cm-h1': { fontSize: '1.6em' },
  '.cm-h2': { fontSize: '1.35em' },
  '.cm-h3': { fontSize: '1.18em' },
  '.cm-h4': { fontSize: '1.06em' },
  '.cm-h5': { fontSize: '1em' },
  '.cm-h6': { fontSize: '0.95em', opacity: '0.8' },
  '.cm-strong': { fontWeight: '650' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strike': { textDecoration: 'line-through' },
  '.cm-quote': {
    borderLeft: '3px solid var(--rule)',
    paddingLeft: '0.7em',
    color: 'var(--muted-strong)',
  },
  '.cm-codeblock': {
    fontFamily: 'var(--mono)',
    fontSize: '0.92em',
    background: 'var(--code-bg)',
  },
  '.cm-inline-code': {
    fontFamily: 'var(--mono)',
    fontSize: '0.92em',
    background: 'var(--code-bg)',
    borderRadius: '3px',
    padding: '0.05em 0.25em',
  },
  '.cm-list-bullet': { color: 'var(--muted-strong)' },
  '.cm-source-link': {
    color: 'var(--accent)',
    borderBottom: '1px dotted var(--accent)',
    cursor: 'pointer',
  },
  // Citations carry the colours the paper's highlights do: the passage on
  // show in one, every other in another.
  '.cm-citation': {
    background: 'var(--mark-other)',
    borderRadius: '2px',
    padding: '0.05em 0.15em',
    transition: 'background 120ms ease',
  },
  '.cm-citation.active': { background: 'var(--mark-active)' },
  '.cm-citation.revealed': { boxShadow: 'inset 0 0 0 1px var(--mark-active-line)' },
  '.cm-link': { color: 'var(--accent)', cursor: 'pointer' },
  // A paper of the library, named in the text.
  '.cm-paper-link': {
    color: 'var(--accent)',
    borderBottom: '1px solid var(--accent)',
    cursor: 'pointer',
  },
  '.cm-paper-link.missing': {
    color: 'var(--muted-strong)',
    borderBottom: '1px dashed var(--muted-strong)',
    cursor: 'default',
  },
  '.cm-math-display': { display: 'inline-block', width: '100%', textAlign: 'center' },
  // A table wider than the note scrolls within itself. Padding, not margin:
  // the editor measures the block, and a margin would be left out of it.
  '.cm-table-wrap': {
    overflowX: 'auto',
    padding: '0.35em 0 0.35em 6px',
    // The editor wraps its lines anywhere, to keep long words inside the
    // page; in a cell that breaks "investment" in two to save a column.
    whiteSpace: 'normal',
    overflowWrap: 'normal',
    wordBreak: 'normal',
  },
  '.cm-table-wrap table': { borderCollapse: 'collapse', fontSize: '0.93em' },
  '.cm-table-wrap th, .cm-table-wrap td': {
    border: '1px solid var(--rule)',
    padding: '0.25em 0.6em',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.cm-table-wrap th': { background: 'var(--code-bg)', fontWeight: '600' },
  '.cm-table-wrap code': {
    fontFamily: 'var(--mono)',
    fontSize: '0.92em',
    background: 'var(--code-bg)',
    borderRadius: '3px',
    padding: '0.05em 0.25em',
  },
  '.cm-table-wrap a[href]': { color: 'var(--accent)' },
  // The same table as written, while it is being edited.
  '.cm-table-source': { fontFamily: 'var(--mono)', fontSize: '0.88em' },
})
