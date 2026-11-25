/**
 * Sessions: the conversations under way, each with what was on screen for it.
 *
 * Several lines of work go on at once — a paper being read for one thing, a
 * note being written for another — and each has its own conversation with the
 * agent. A session is that conversation together with its view: the note or
 * paper that was open, the page, what was attached. Going to another session
 * and coming back is coming back to the work, not only to the transcript.
 *
 * They sit in a row in the top bar. Each has an address of its own, so one can
 * be opened in another window and kept there. Closing one puts it away; it is
 * not deleted, and the list in the chat drawer brings it back.
 */

import type { ConversationSummary } from './api'
import { addressOf, openSessions } from './sessionView'

export * from './sessionView'

export interface SessionsProps {
  conversations: ConversationSummary[]
  currentId: string | null
  /** Sessions that finished a run while another was on screen. */
  unread: ReadonlySet<string>
  /** What a session goes by: its title, or failing one, what is open in it. */
  labelFor: (conversation: ConversationSummary) => string
  onSelect: (id: string) => void
  onNew: () => void
  onClose: (id: string) => void
}

export function Sessions(props: SessionsProps) {
  const sessions = openSessions(props.conversations, props.currentId)
  return (
    <nav class="sessions" aria-label="Sessions">
      {sessions.map((session) => {
        const id = session.conversation_id
        const current = id === props.currentId
        const working = session.status !== 'idle'
        const label = props.labelFor(session)
        const answered = !current && props.unread.has(id)
        return (
          <div
            key={id}
            class={current ? 'session on' : 'session'}
            data-session={id}
            data-state={working ? 'working' : answered ? 'answered' : 'idle'}
          >
            {/* A link, so it can be opened in a window of its own. */}
            <a
              href={addressOf(id)}
              aria-current={current ? 'page' : undefined}
              title={
                working
                  ? `${label} — the agent is working here`
                  : answered
                    ? `${label} — answered since you looked`
                    : label
              }
              onClick={(event) => {
                // With a modifier it is the browser's: a new tab, a new window.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                if (!current) props.onSelect(id)
              }}
            >
              {working && <span class="dot working" />}
              {answered && !working && (
                <span class={session.last_run_status === 'failed' ? 'dot failed' : 'dot answered'} />
              )}
              <span class="session-title">{label}</span>
            </a>
            <button
              type="button"
              class="session-close"
              title="Put this session away. Nothing is deleted; the chat's list brings it back."
              aria-label={`Close the session ${label}`}
              onClick={() => props.onClose(id)}
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        type="button"
        class="session-new"
        data-action="new-session"
        title="A new session: its own conversation, and its own view"
        aria-label="New session"
        onClick={props.onNew}
      >
        +
      </button>
    </nav>
  )
}
