/**
 * A peek: what a link leads to, opened over what is being read rather than in
 * its place. An experiment — see `peeks.ts` for what it is for.
 *
 * It takes half of the window — at the side, or at the foot — so that what is
 * being read stays in sight in the other half, and a press there puts the peek
 * away (see the stylesheet for which half, and when).
 *
 * The dialog is the same whatever is in it: a line at its top that says what
 * this is, with the way back to the peek it was come to from, the way to go
 * there for good, and the way to put it away; and under it the thing itself —
 * a paper at a passage, a note, the conversation.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import { ApiError, api } from './api'
import { Prose } from './chat/TurnView'
import type { Peek, PeekText as PeekTextTarget } from './peeks'

export interface PeekDialogProps {
  kind: Peek['kind']
  /** What is being looked at. */
  title: string
  /** Back to the peek this one was come to from; left out when it is the first. */
  onBack?: () => void
  /** Go there: it takes the place of what was being read. */
  onOpen: () => void
  /** What going there is called: "Open the paper", "Open the chat". */
  openLabel: string
  /** Put it away, and whatever it was come to from with it. */
  onClose: () => void
  children: ComponentChildren
}

export function PeekDialog(props: PeekDialogProps) {
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Escape in a box being typed in is about the box: the request about a
      // passage, the message to the chat.
      const target = event.target
      if (target instanceof Element && target.closest('.ask-box, .conv-menu')) return
      close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      class="peek-backdrop"
      onClick={(event) => {
        // A press on what is behind, not one inside the dialog that bubbled.
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <section
        class={`peek peek-${props.kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header class="peek-head">
          {props.onBack && (
            <button
              type="button"
              class="ghost icon"
              data-action="peek-back"
              aria-label="Back"
              title="Back to what this was opened from"
              onClick={props.onBack}
            >
              ←
            </button>
          )}
          <span class="peek-title" title={props.title}>
            {props.title}
          </span>
          <button
            type="button"
            class="peek-open"
            data-action="peek-open"
            title={`${props.openLabel}, in place of what is being read`}
            onClick={props.onOpen}
          >
            {props.openLabel}
          </button>
          <button
            type="button"
            class="ghost icon"
            data-action="peek-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={props.onClose}
          >
            ✕
          </button>
        </header>
        <div class="peek-body">{props.children}</div>
      </section>
    </div>
  )
}

export interface PeekTextProps {
  target: PeekTextTarget
  /** A citation to show in it: where the passage it was come to from is cited. */
  referenceId: string | null
  /** Bumped when a file changes under the reader: it is read again. */
  fileTick: number
  onOpenSource: (referenceId: string) => void
  onOpenPaper: (documentId: string) => void
  onOpenNote: (noteId: string) => void
}

/**
 * A note or a summary, to be read and not written in: the text as it is
 * saved, drawn as the chat draws what it is told. Its links work, and lead to
 * further peeks.
 */
export function PeekText(props: PeekTextProps) {
  const { target } = props
  const key =
    target.kind === 'note'
      ? `note:${target.noteId}`
      : target.kind === 'summary'
        ? `summary:${target.documentId}`
        : 'skill'
  const [read, setRead] = useState<{ key: string; text: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const body = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setProblem(null)
    const asked: Promise<string> =
      target.kind === 'note'
        ? api.readNote(target.noteId).then((note) => note.text)
        : target.kind === 'summary'
          ? api.summary(target.documentId).then((summary) => summary.text ?? '')
          : api.skill().then((skill) => skill.text)
    asked.then(
      (text) => {
        if (!cancelled) setRead({ key, text })
      },
      (error: unknown) => {
        if (cancelled) return
        setProblem(error instanceof ApiError ? error.body.message : 'That could not be opened.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, props.fileTick])

  const text = read && read.key === key ? read.text : null

  // Come to from a passage: to where it is cited, and that citation marked.
  useEffect(() => {
    const node = body.current
    if (text === null || !node) return
    for (const marked of node.querySelectorAll('.peek-cited')) marked.classList.remove('peek-cited')
    if (!props.referenceId) {
      node.scrollTop = 0
      return
    }
    const cited = Array.from(node.querySelectorAll<HTMLElement>('[data-source-ref]')).filter(
      (link) => link.dataset.sourceRef === props.referenceId,
    )
    for (const link of cited) link.classList.add('peek-cited')
    cited[0]?.scrollIntoView({ block: 'center' })
  }, [text, key, props.referenceId])

  if (problem !== null) {
    return (
      <div class="peek-prose">
        <p class="muted">{problem}</p>
      </div>
    )
  }
  if (text === null) {
    return (
      <div class="peek-prose">
        <p class="muted">Opening…</p>
      </div>
    )
  }
  return (
    <div class="peek-prose" ref={body}>
      {text.trim() ? (
        <Prose
          text={text}
          onOpenSource={props.onOpenSource}
          onOpenPaper={props.onOpenPaper}
          onOpenNote={props.onOpenNote}
        />
      ) : (
        <p class="muted">Nothing has been written here yet.</p>
      )}
    </div>
  )
}
