/**
 * Focus, apart from how it is drawn: an experiment in how a paper is read.
 *
 * With it on, a window shows one thing at a time, whatever its width — the
 * layout a phone has — and what is being read stays where it is. A link that
 * would take the reader somewhere else — a citation, a paper or a note named
 * in passing, the answer to a question about a passage — is opened over it
 * instead, in a dialog: a peek. Put away, it leaves the reader where they
 * were, at the line they were on. See `Peek.tsx` for the dialog, and `App.tsx`
 * for what is peeked at and what is gone to.
 *
 * A peek can lead to another: the answer cites a passage, the passage is in a
 * paper. They are kept in the order they were come to, so each can be stepped
 * back from, and the whole of it put away at once.
 */

import type { ReferenceRecord } from './api'
import type { SessionTarget } from './sessionView'

/** A text that can be peeked at: anything the main area can hold, but nothing. */
export type PeekText = Exclude<SessionTarget, { kind: 'empty' }>

export type Peek =
  /** A paper at a page — and, come to by a citation, the passage cited. */
  | { kind: 'paper'; documentId: string; page: number; reference: ReferenceRecord | null }
  /** A note or a summary — and, come to from a passage, where it is cited there. */
  | { kind: 'text'; target: PeekText; referenceId: string | null }
  /** The conversation: where the answer to what was asked is read. */
  | { kind: 'chat' }

/** What tells one peek from another: the thing looked at, not the place in it. */
export function peekKey(peek: Peek): string {
  if (peek.kind === 'chat') return 'chat'
  if (peek.kind === 'paper') return `paper:${peek.documentId}`
  const { target } = peek
  return target.kind === 'note'
    ? `note:${target.noteId}`
    : target.kind === 'summary'
      ? `summary:${target.documentId}`
      : 'skill:summary'
}

/** No further than this many deep; the first come to is let go of. */
export const MAX_PEEKS = 12

/**
 * The peeks, after another is asked for.
 *
 * The same thing again — another passage of the paper already on top — takes
 * the place of the one there: it is a different place in it, not a step
 * further. Something already underneath is gone back to rather than piled on
 * again, so following an answer to a passage and the passage back to the
 * answer does not build a tower of the two.
 */
export function peeked(stack: readonly Peek[], next: Peek): readonly Peek[] {
  const key = peekKey(next)
  const at = stack.findIndex((own) => peekKey(own) === key)
  if (at >= 0) return [...stack.slice(0, at), next]
  return [...stack, next].slice(-MAX_PEEKS)
}

/** One step back: the peek this one was come to from, or none. */
export function steppedBack(stack: readonly Peek[]): readonly Peek[] {
  return stack.slice(0, -1)
}

const FOCUS_KEY = 'litmark:focus'

/** Whether this window was last left in focus. Its own business, like its widths. */
export function storedFocus(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(FOCUS_KEY) === '1'
  } catch {
    return false // Storage can be refused; the usual layout stands.
  }
}

export function rememberFocus(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  focus: boolean,
): void {
  try {
    if (focus) storage?.setItem(FOCUS_KEY, '1')
    else storage?.removeItem(FOCUS_KEY)
  } catch {
    /* it holds for this visit */
  }
}
