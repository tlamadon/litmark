/**
 * The note and summary editor.
 *
 * Save behaviour: debounced autosave, a visible indicator, Cmd/Ctrl-S for an
 * immediate save, the buffer preserved after a failed save, and an explicit
 * conflict prompt when the file changed underneath a dirty buffer.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { search, searchKeymap } from '@codemirror/search'
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import { useEffect, useRef, useState } from 'preact/hooks'

import { ApiError } from '../api'
import { headingsOf } from '../outline'
import type { KnownPaper } from '../papers'
import {
  citationsOf,
  livePreview,
  readingMode,
  setActiveReference,
  setKnownPapers,
  setReadingMode,
  setRevealedCitation,
  setSourceMode,
  sourceReferenceAt,
} from './livePreview'

export type SaveState =
  | { kind: 'clean' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; message: string; theirs: string | null }

export interface MarkdownEditorProps {
  /** Identity of the buffer; changing it loads a different document. */
  docKey: string
  text: string
  revision: string | null
  readOnly?: boolean
  /**
   * Open for editing rather than reading. Reading is the usual way in — a
   * note just created is the exception: it is there to be written.
   */
  startEditing?: boolean
  placeholder?: string
  save: (text: string, expectedRevision: string | null) => Promise<{ revision: string }>
  onOpenSource?: (referenceId: string) => void
  /** The papers of the library, so a `paper:` link can say what it names. */
  papers?: readonly KnownPaper[]
  onOpenPaper?: (documentId: string) => void
  onSelectionChange?: (selection: string) => void
  onDirtyChange?: (dirty: boolean) => void
  registerInsert?: (insert: (markdown: string) => void) => void
  /** The reference on show in the paper; its citations here are picked out. */
  activeReference?: string | null
  /** Edits that could not be saved after the buffer was left. */
  onSaveLost?: (message: string) => void
  /**
   * Hands out a way to show where a reference is cited in this buffer: it is
   * brought to the middle of the view and marked, and the cursor is left where
   * it was. Called again for the same reference, it shows the next place.
   */
  registerReveal?: (reveal: (referenceId: string) => RevealResult) => void
  /**
   * Hands out a way to go to a heading, by its place among the headings of
   * the text as it now stands: brought to the top of the view, cursor left be.
   */
  registerGoto?: (goto: (headingIndex: number) => void) => void
  /** What is open, named in the bar itself rather than on a line of its own. */
  title?: string
}

export interface RevealResult {
  /** The reference is cited in this buffer, and the view is now there. */
  found: boolean
  /** Every citation here has been visited; this one is the first again. */
  wrapped: boolean
}

const AUTOSAVE_DELAY_MS = 900

/** Marks a change that brings in what the file now holds, not what was typed. */
const fromDisk = Annotation.define<boolean>()

export function MarkdownEditor(props: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const revision = useRef<string | null>(props.revision)
  const timer = useRef<number | null>(null)
  const saving = useRef(false)
  // The save under way, so one that must follow it can wait its turn.
  const inFlight = useRef<Promise<void> | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'clean' })
  const [showSource, setShowSource] = useState(false)
  // Reading or editing. A different buffer is a different instance of this
  // component, so each opens in the mode it was asked to.
  const [reading, setReading] = useState(!props.startEditing || Boolean(props.readOnly))
  const editability = useRef(new Compartment())
  // Whether the reader has put the selection somewhere in this buffer: until
  // they have, "where the cursor is" means nothing.
  const placed = useRef(false)

  /** What may be done to the text in each mode. */
  const editable = (isReading: boolean): Extension => [
    EditorView.editable.of(!isReading && !props.readOnly),
    EditorState.readOnly.of(isReading || Boolean(props.readOnly)),
  ]
  // The citation the cursor is inside, if any. Drives the visible
  // "Open source" action, so the Cmd/Ctrl-click shortcut is not the only way in.
  const [sourceAtCursor, setSourceAtCursor] = useState<string | null>(null)
  // The citation last gone to, so asking again moves on to the next one.
  const revealed = useRef<{ referenceId: string; index: number } | null>(null)

  // Keep a stable reference to the latest props for use inside CodeMirror.
  const latest = useRef(props)
  latest.current = props

  const flush = (): Promise<void> => {
    const run = flushNow()
    inFlight.current = run
    return run
  }

  const flushNow = async (): Promise<void> => {
    const editor = view.current
    if (!editor || saving.current) return
    const text = editor.state.doc.toString()
    saving.current = true
    setState({ kind: 'saving' })
    try {
      const result = await latest.current.save(text, revision.current)
      revision.current = result.revision
      // A save that lands while the user keeps typing leaves the buffer dirty.
      const stillMatches = view.current?.state.doc.toString() === text
      setState(stillMatches ? { kind: 'saved', at: Date.now() } : { kind: 'dirty' })
      latest.current.onDirtyChange?.(!stillMatches)
      if (!stillMatches) schedule()
    } catch (error) {
      // The buffer is never discarded on a failed save.
      if (error instanceof ApiError && error.isConflict) {
        setState({
          kind: 'conflict',
          message: error.body.message,
          theirs: error.body.current_text ?? null,
        })
      } else {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Saving failed.',
        })
      }
    } finally {
      saving.current = false
    }
  }

  const schedule = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void flush()
    }, AUTOSAVE_DELAY_MS)
  }

  /** Save now what a pending autosave was waiting to save. */
  const flushPending = (): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
    void flush()
  }

  useEffect(() => {
    if (!host.current) return

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      search({ top: true }),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      livePreview({
        onOpenSource: (id) => latest.current.onOpenSource?.(id),
        onOpenPaper: (id) => latest.current.onOpenPaper?.(id),
        onOpenLink: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
        reading,
      }),
      EditorView.domEventHandlers({
        // Reading, a double-click on the text is "let me change this": edit,
        // with the cursor where the click was.
        dblclick: (event, target) => {
          if (!target.state.field(readingMode, false)) return false
          // On a link, the two clicks were two openings of the link.
          if (
            (event.target as HTMLElement | null)?.closest?.(
              '.cm-source-link, .cm-link, .cm-paper-link',
            )
          ) {
            return false
          }
          const at = target.posAtCoords({ x: event.clientX, y: event.clientY })
          setModeRef.current(false, at ?? undefined)
          return true
        },
      }),
      // Focusable while reading too, so find and copy work from the keyboard.
      EditorView.contentAttributes.of({ tabindex: '0' }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            if (timer.current !== null) window.clearTimeout(timer.current)
            timer.current = null
            void flush()
            return true
          },
        },
        ...searchKeymap,
        {
          // Done editing. After the search bindings, so Escape closes an open
          // search panel first.
          key: 'Escape',
          run: (target) => {
            if (target.state.field(readingMode, false)) return false
            setModeRef.current(true)
            return true
          },
        },
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        // Text put in because the file changed elsewhere is not an edit made
        // here: saving it back would write what was just read, and record a
        // save by the user that never happened.
        const reloaded = update.transactions.some((tr) => tr.annotation(fromDisk))
        if (update.docChanged && !reloaded) {
          setState({ kind: 'dirty' })
          latest.current.onDirtyChange?.(true)
          schedule()
        }
        if (update.selectionSet) placed.current = true
        if (update.selectionSet || update.docChanged) {
          const { from, to, head } = update.state.selection.main
          if (latest.current.onSelectionChange) {
            latest.current.onSelectionChange(
              from === to ? '' : update.state.doc.sliceString(from, to),
            )
          }
          setSourceAtCursor(sourceReferenceAt(update.state, head))
        }
      }),
      editability.current.of(editable(reading)),
    ]

    const editor = new EditorView({
      state: EditorState.create({ doc: props.text, extensions }),
      parent: host.current,
    })
    view.current = editor
    revision.current = props.revision
    setState({ kind: 'clean' })

    props.registerInsert?.((snippet: string) => {
      const target = view.current
      if (!target) return
      // At the cursor, when there is one the reader put there. A note opened
      // and only read has none: its end is where a new reference belongs,
      // not the top of its first line.
      const at = placed.current ? target.state.selection.main.to : target.state.doc.length
      const text =
        !placed.current && at > 0 && !snippet.startsWith('\n')
          ? `\n\n${snippet.trimStart()}`
          : snippet
      // An insertion is an edit: the buffer is opened for editing, with the
      // cursor after what was put in, and that place brought into view.
      setModeRef.current(false)
      target.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        effects: EditorView.scrollIntoView(at + text.length, { y: 'center' }),
      })
      target.focus()
    })

    revealed.current = null
    props.registerReveal?.((referenceId: string): RevealResult => {
      const target = view.current
      if (!target) return { found: false, wrapped: false }
      const spots = citationsOf(target.state, referenceId)
      if (spots.length === 0) return { found: false, wrapped: false }

      const last = revealed.current
      const again = last !== null && last.referenceId === referenceId
      const index = again ? (last.index + 1) % spots.length : 0
      revealed.current = { referenceId, index }
      const spot = spots[index]!
      // Shown, not entered: brought to the middle of the view and marked, with
      // the cursor and the keyboard focus left where they were. Looking up
      // where a passage is cited is reading, not the start of an edit.
      target.dispatch({
        effects: [
          setActiveReference.of(referenceId),
          setRevealedCitation.of(spot.from),
          EditorView.scrollIntoView(spot.from, { y: 'center' }),
        ],
      })
      return { found: true, wrapped: again && index === 0 }
    })

    props.registerGoto?.((headingIndex: number): void => {
      const target = view.current
      if (!target) return
      const heading = headingsOf(target.state.doc.toString())[headingIndex]
      if (!heading) return
      const line = target.state.doc.line(Math.min(heading.line, target.state.doc.lines))
      target.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 8 }) })
    })

    // A tab put away is often a tab about to be closed: save without waiting
    // out the delay.
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') flushPending()
    }
    document.addEventListener('visibilitychange', onHidden)

    // Bound to this buffer: by the time it is left, `props.save` is the next one's.
    const saveThisBuffer = props.save
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      // Leaving within the autosave delay must not drop what was just typed.
      // The timer is the mark of edits not yet sent; a save already under way
      // goes first, so this one is checked against the revision it produced.
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
        const text = editor.state.doc.toString()
        const lost = latest.current.onSaveLost
        void (inFlight.current ?? Promise.resolve())
          .then(() => saveThisBuffer(text, revision.current))
          .catch((error: unknown) => {
            lost?.(error instanceof Error ? error.message : 'Saving failed.')
          })
      }
      editor.destroy()
      view.current = null
    }
    // Rebuilding on docKey is intentional: a different note is a different buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey])

  // The passage on show in the paper names which citations to pick out.
  useEffect(() => {
    view.current?.dispatch({ effects: setActiveReference.of(props.activeReference ?? null) })
  }, [props.activeReference, props.docKey])

  useEffect(() => {
    view.current?.dispatch({ effects: setKnownPapers.of(props.papers ?? []) })
  }, [props.papers, props.docKey])

  // Reload a clean buffer when the file changed on disk; keep a dirty one.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    if (state.kind === 'dirty' || state.kind === 'saving' || state.kind === 'conflict') return
    if (props.revision === revision.current) return
    if (editor.state.doc.toString() === props.text) {
      revision.current = props.revision
      return
    }
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.text },
      annotations: fromDisk.of(true),
    })
    revision.current = props.revision
    setState({ kind: 'clean' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text, props.revision])

  /**
   * Switch between reading and editing; into editing, optionally with the
   * cursor at a position — where a double-click landed.
   */
  const setMode = (toReading: boolean, at?: number): void => {
    const editor = view.current
    if (!editor || props.readOnly) return
    if (toReading) flushPending()
    editor.dispatch({
      effects: [
        setReadingMode.of(toReading),
        editability.current.reconfigure(editable(toReading)),
        // The raw text is something one edits; reading shows it rendered.
        ...(toReading ? [setSourceMode.of(false)] : []),
      ],
      ...(at === undefined ? {} : { selection: { anchor: at } }),
    })
    if (toReading) {
      setShowSource(false)
      editor.contentDOM.blur()
    } else {
      editor.focus()
    }
    setReading(toReading)
  }
  const setModeRef = useRef(setMode)
  setModeRef.current = setMode

  const toggleSource = (): void => {
    const next = !showSource
    setShowSource(next)
    view.current?.dispatch({ effects: setSourceMode.of(next) })
    view.current?.focus()
  }

  const keepMine = (): void => {
    // Re-save against the revision the server reports as current.
    void (async () => {
      const editor = view.current
      if (!editor) return
      try {
        const current = await latest.current.save(editor.state.doc.toString(), null)
        revision.current = current.revision
        setState({ kind: 'saved', at: Date.now() })
      } catch (error) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Saving failed.',
        })
      }
    })()
  }

  const takeTheirs = (): void => {
    if (state.kind !== 'conflict' || state.theirs === null) return
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: state.theirs },
    })
    setState({ kind: 'clean' })
    void flush()
  }

  return (
    <div class={reading ? 'editor reading' : 'editor'}>
      <div class="editor-bar">
        {props.title && (
          <h2 class="editor-title" title={props.title}>
            {props.title}
          </h2>
        )}
        <SaveIndicator state={state} />
        {reading && !props.readOnly && (
          <span class="mode-hint">Double-click the text to edit it</span>
        )}
        <div class="editor-actions">
          {!props.readOnly && (
            <div class="mode-tabs" role="group" aria-label="Read or edit">
              <button
                type="button"
                class={reading ? 'on' : ''}
                aria-pressed={reading}
                data-mode="read"
                title="Read: a click opens a citation's source, and nothing is edited"
                onClick={() => setMode(true)}
              >
                Read
              </button>
              <button
                type="button"
                class={reading ? '' : 'on'}
                aria-pressed={!reading}
                data-mode="edit"
                title="Edit the Markdown (double-clicking the text does this too; Escape returns)"
                onClick={() => setMode(false)}
              >
                Edit
              </button>
            </div>
          )}
          {!reading && (
          <button
            type="button"
            class="toggle open-source"
            data-action="open-source"
            disabled={sourceAtCursor === null}
            onClick={() => {
              if (sourceAtCursor) latest.current.onOpenSource?.(sourceAtCursor)
            }}
            title={
              sourceAtCursor
                ? `Open ${sourceAtCursor} — the cited page, with the passage highlighted`
                : 'Put the cursor in a citation to open its source (or Cmd/Ctrl-click it)'
            }
          >
            {sourceAtCursor ? `Open source · ${sourceAtCursor}` : 'Open source'}
          </button>
          )}
          {!reading && (
          <button
            type="button"
            class={showSource ? 'toggle active' : 'toggle'}
            onClick={toggleSource}
            title="Show the complete Markdown text without presentation decorations"
          >
            Source
          </button>
          )}
        </div>
      </div>

      {state.kind === 'conflict' && (
        <div class="conflict" role="alert">
          <strong>This file changed while you were editing it.</strong>
          <p>{state.message}</p>
          <p class="hint">
            Both versions are intact. Choose which one to keep — nothing is merged
            automatically.
          </p>
          <div class="conflict-actions">
            <button type="button" onClick={keepMine}>
              Keep my version
            </button>
            <button type="button" onClick={takeTheirs} disabled={state.theirs === null}>
              Use the version on disk
            </button>
          </div>
          {state.theirs !== null && (
            <details>
              <summary>Compare</summary>
              <div class="conflict-compare">
                <section>
                  <h4>On disk</h4>
                  <pre>{state.theirs}</pre>
                </section>
                <section>
                  <h4>Mine</h4>
                  <pre>{view.current?.state.doc.toString() ?? ''}</pre>
                </section>
              </div>
            </details>
          )}
        </div>
      )}

      <div class="editor-surface" ref={host} />
    </div>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  switch (state.kind) {
    case 'clean':
      return <span class="save-state">Saved</span>
    case 'dirty':
      return <span class="save-state working">Unsaved changes…</span>
    case 'saving':
      return <span class="save-state working">Saving…</span>
    case 'saved':
      return <span class="save-state ok">Saved</span>
    case 'error':
      return (
        <span class="save-state error" title={state.message}>
          Not saved — {state.message}
        </span>
      )
    case 'conflict':
      return <span class="save-state error">Conflict</span>
  }
}
