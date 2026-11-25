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
}

export const EMPTY_VIEW: SessionView = {
  target: { kind: 'empty' },
  documentId: null,
  page: null,
  attached: [],
  library: false,
}

/** A saved view read back, trusting none of it: it came through storage. */
export function readView(saved: unknown): SessionView {
  if (!saved || typeof saved !== 'object') return EMPTY_VIEW
  const raw = saved as Record<string, unknown>
  const from = (raw.target ?? {}) as Record<string, unknown>
  let target: SessionTarget = { kind: 'empty' }
  if (from.kind === 'note' && typeof from.noteId === 'string') {
    target = { kind: 'note', noteId: from.noteId }
  } else if (from.kind === 'summary' && typeof from.documentId === 'string') {
    target = { kind: 'summary', documentId: from.documentId }
  } else if (from.kind === 'skill') {
    target = { kind: 'skill' }
  }
  return {
    target,
    documentId: typeof raw.documentId === 'string' ? raw.documentId : null,
    page: typeof raw.page === 'number' && raw.page >= 1 ? Math.floor(raw.page) : null,
    attached: Array.isArray(raw.attached)
      ? raw.attached.filter((id): id is string => typeof id === 'string')
      : [],
    library: raw.library === true,
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
