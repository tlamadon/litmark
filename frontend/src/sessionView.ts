/**
 * What a session is, apart from how it is drawn: its saved view, its address,
 * and which sessions are in the row. See `Sessions.tsx`.
 */

import type { ConversationSummary } from './api'

/** Where the main area is: mirrors the shell's own notion of what is open. */
export type SessionTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'summary'; documentId: string }
  | { kind: 'skill' }
  | { kind: 'empty' }

/** What was on screen with a conversation, as it is kept between visits. */
export interface SessionView {
  target: SessionTarget
  /** The paper on show beside it, and the page it was at. */
  documentId: string | null
  page: number | null
  /** Papers attached to what is asked next. */
  attached: string[]
  /** Whether the library was laid over it. */
  library: boolean
  /**
   * The texts and the papers opened in the session and not closed since, in
   * the order they were opened: what is on show is one of each, and the rest
   * are a press away. See `opened`.
   */
  texts: readonly SessionTarget[]
  papers: readonly string[]
}

export const EMPTY_VIEW: SessionView = {
  target: { kind: 'empty' },
  documentId: null,
  page: null,
  attached: [],
  library: false,
  texts: [],
  papers: [],
}

/** No more than this many of a kind are kept open; the one opened longest ago gives way. */
export const MAX_OPEN = 12

/** What tells one text from another: the note, the paper summarized, or the skill. */
export function targetKey(target: SessionTarget): string {
  return target.kind === 'note'
    ? `note:${target.noteId}`
    : target.kind === 'summary'
      ? `summary:${target.documentId}`
      : target.kind === 'skill'
        ? 'skill:summary'
        : 'empty'
}

/**
 * The list of what is open, after something is opened. One already there
 * stays where it is — going back to it is not opening it again, and the list
 * does not shuffle under the reader. A new one goes at the end.
 */
export function opened<T>(open: readonly T[], item: T, keyOf: (item: T) => string): readonly T[] {
  const key = keyOf(item)
  if (open.some((own) => keyOf(own) === key)) return open
  return [...open, item].slice(-MAX_OPEN)
}

/** The same list, with one of them closed. */
export function closed<T>(open: readonly T[], key: string, keyOf: (item: T) => string): readonly T[] {
  return open.some((own) => keyOf(own) === key) ? open.filter((own) => keyOf(own) !== key) : open
}

/**
 * Where to go when the one on show is closed: the one opened after it, or
 * failing that the one before — its neighbour in the list, as with tabs.
 */
export function besideClosed<T>(open: readonly T[], key: string, keyOf: (item: T) => string): T | null {
  const at = open.findIndex((own) => keyOf(own) === key)
  if (at < 0) return null
  return open[at + 1] ?? open[at - 1] ?? null
}

function readTarget(raw: unknown): SessionTarget {
  const from = (raw ?? {}) as Record<string, unknown>
  if (from.kind === 'note' && typeof from.noteId === 'string') {
    return { kind: 'note', noteId: from.noteId }
  }
  if (from.kind === 'summary' && typeof from.documentId === 'string') {
    return { kind: 'summary', documentId: from.documentId }
  }
  if (from.kind === 'skill') return { kind: 'skill' }
  return { kind: 'empty' }
}

/** A saved view read back, trusting none of it: it came through storage. */
export function readView(saved: unknown): SessionView {
  if (!saved || typeof saved !== 'object') return EMPTY_VIEW
  const raw = saved as Record<string, unknown>
  const target = readTarget(raw.target)
  // A view kept before there was a list of what is open has what was on show.
  const texts = Array.isArray(raw.texts)
    ? raw.texts.map(readTarget).filter((text) => text.kind !== 'empty')
    : []
  const papers = Array.isArray(raw.papers)
    ? raw.papers.filter((id): id is string => typeof id === 'string')
    : []
  return {
    target,
    documentId: typeof raw.documentId === 'string' ? raw.documentId : null,
    page: typeof raw.page === 'number' && raw.page >= 1 ? Math.floor(raw.page) : null,
    attached: Array.isArray(raw.attached)
      ? raw.attached.filter((id): id is string => typeof id === 'string')
      : [],
    library: raw.library === true,
    texts: texts.slice(-MAX_OPEN),
    papers: papers.slice(-MAX_OPEN),
  }
}

/** Nothing open, nothing attached: a session nobody has done anything in. */
export function isUntouched(conversation: ConversationSummary): boolean {
  if (conversation.turn_count > 0) return false
  const view = readView(conversation.view)
  return view.target.kind === 'empty' && view.documentId === null && view.attached.length === 0
}

const SESSION_PATH = /^\/s\/([A-Za-z0-9-]+)\/?$/

/** The session an address names, if it names one. */
export function sessionInAddress(pathname: string): string | null {
  return SESSION_PATH.exec(pathname)?.[1] ?? null
}

export const addressOf = (conversationId: string): string => `/s/${conversationId}`

/** How many conversations from before there were sessions are shown at first. */
const SHOWN_UNSEEN = 4

/**
 * The sessions in the row: those not put away, in the order they were begun,
 * so a tab does not move when something happens in it.
 *
 * A conversation from before there were sessions has no view and was never
 * closed; showing every one would bury the row, so only the most recently
 * used of those are shown. The one on screen is always among them.
 */
export function openSessions(
  conversations: ConversationSummary[],
  currentId: string | null,
): ConversationSummary[] {
  const chats = conversations.filter((conversation) => conversation.kind === 'chat')
  // The list arrives most recently used first.
  const recent = new Set(chats.slice(0, SHOWN_UNSEEN).map((c) => c.conversation_id))
  return chats
    .filter(
      (c) =>
        c.conversation_id === currentId ||
        (!c.closed && (c.view != null || recent.has(c.conversation_id))),
    )
    .sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.conversation_id.localeCompare(b.conversation_id),
    )
}
