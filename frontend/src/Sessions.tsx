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
 *
 * A session is named after the first thing asked in it, which is not always
 * what it turns out to be about. Double-clicking a tab (or F2 on it) puts the
 * name up to be typed over, there in the tab.
 */

import { useLayoutEffect, useRef, useState } from 'preact/hooks'

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
  /** Give a session a name of the reader's choosing. Rejects with the reason. */
  onRename: (id: string, title: string) => Promise<void>
}

/** A tab's name, up to be typed over. Enter keeps it; Escape leaves it as it was. */
function SessionName(props: {
  label: string
  onKeep: (title: string) => Promise<void>
  onDone: () => void
}) {
  const [title, setTitle] = useState(props.label)
  const [problem, setProblem] = useState<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  // Settled once: Enter is followed by the field losing focus, which must not
  // keep the name a second time, and Escape by a blur that must not keep it.
  const settled = useRef(false)
  // Before the tab is drawn, not after: what is typed next belongs to the field.
  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const keep = async (): Promise<void> => {
    if (settled.current) return
    // What the field holds now, not what was last drawn: Enter can come
    // straight after the last letter.
    const wanted = (input.current?.value ?? title).trim()
    // Emptied, or left as it was: nothing to say to the server.
    if (!wanted || wanted === props.label) {
      settled.current = true
      props.onDone()
      return
    }
    settled.current = true
    try {
      await props.onKeep(wanted)
      props.onDone()
    } catch (error) {
      settled.current = false
      setProblem(error instanceof Error ? error.message : 'That did not work.')
      input.current?.focus()
    }
  }

  return (
    <input
      ref={input}
      class="session-name"
      type="text"
      value={title}
      maxLength={200}
      aria-label="Session name"
      aria-invalid={problem !== null}
      title={problem ?? 'Enter to keep the name, Escape to leave it as it was'}
      onInput={(event) => {
        setTitle((event.target as HTMLInputElement).value)
        setProblem(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void keep()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          // Its own, not the page's: Escape here only gives up the renaming.
          event.stopPropagation()
          settled.current = true
          props.onDone()
        }
      }}
      onBlur={() => void keep()}
    />
  )
}

export function Sessions(props: SessionsProps) {
  const sessions = openSessions(props.conversations, props.currentId)
  const [renaming, setRenaming] = useState<string | null>(null)
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
            {renaming === id ? (
              <SessionName
                label={label}
                onKeep={(title) => props.onRename(id, title)}
                onDone={() => setRenaming(null)}
              />
            ) : (
            <>
            {/* A link, so it can be opened in a window of its own. */}
            <a
              href={addressOf(id)}
              aria-current={current ? 'page' : undefined}
              title={
                working
                  ? `${label} — the agent is working here`
                  : answered
                    ? `${label} — answered since you looked`
                    : `${label} — double-click to rename`
              }
              onDblClick={(event) => {
                event.preventDefault()
                setRenaming(id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'F2') return
                event.preventDefault()
                setRenaming(id)
              }}
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
            </>
            )}
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
