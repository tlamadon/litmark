/**
 * Which conversation the panel is in, and the others it could be.
 *
 * The header button names the current conversation; its menu lists every one
 * kept for this project and switches to any of them, or starts a new one.
 * Switching is free: each conversation keeps its own thread with the agent, a
 * run in one carries on while another is open, and the list says which are
 * working and which have answered since they were last looked at.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import { api, type ConversationSummary } from '../api'

/** "3 min ago", "yesterday", "12 Mar" — when a conversation was last used. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const then = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(then)) return ''
  const minutes = Math.round((now - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** One line of facts about a conversation: how long it is, and when. */
export function conversationMeta(conversation: ConversationSummary): string {
  const bits: string[] = []
  if (conversation.status === 'running') bits.push('working…')
  else if (conversation.status === 'queued') bits.push('queued')
  if (conversation.turn_count) {
    bits.push(`${conversation.turn_count} turn${conversation.turn_count === 1 ? '' : 's'}`)
  }
  const when = ago(conversation.updated_at)
  if (when) bits.push(when)
  return bits.join(' · ') || 'nothing asked yet'
}

export interface ConversationMenuProps {
  conversations: ConversationSummary[]
  currentId: string | null
  /** Conversations that finished a run while another was open. */
  unread: ReadonlySet<string>
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /**
   * What a conversation goes by, where its own title says nothing yet: the
   * shell's name for a session, by what is open in it. Left out, the title.
   */
  labelFor?: (conversation: ConversationSummary) => string
  /**
   * The menu stands in for the row of sessions — on a phone, in the top bar —
   * and speaks of sessions: each is its conversation and its view.
   */
  sessions?: boolean
  /**
   * What each session holds besides its conversation — the text and the paper
   * open in it — drawn under its name: going to one changes those too.
   */
  holds?: (conversation: ConversationSummary) => ComponentChildren
  /** The project these belong to, said at the head of the menu. */
  project?: { name: string; root: string }
  /**
   * The sessions that are open, in the order of their row — the one on screen
   * among them. Given, the menu lists those first, each with a way to put it
   * away, and the ones put away after them.
   */
  row?: ConversationSummary[]
  /** Put a session away. Nothing is deleted; it stays in the menu, further down. */
  onPutAway?: (id: string) => void
  /** Drawn at the head of the button: on a phone, the mark of sessions and how many are open. */
  lead?: ComponentChildren
}

export function ConversationMenu(props: ConversationMenuProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'list' | 'rename' | 'delete'>('list')
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (mode === 'rename') nameInput.current?.select()
  }, [mode])

  const current = props.conversations.find((c) => c.conversation_id === props.currentId) ?? null
  const nameOf = (conversation: ConversationSummary): string =>
    conversation.kind === 'chat' && props.labelFor
      ? props.labelFor(conversation)
      : conversation.title
  const others = props.conversations.filter((c) => c.conversation_id !== props.currentId)
  const chats = others.filter((c) => c.kind === 'chat')
  // With the row given: the sessions open besides this one, as the row has
  // them, and then the rest, most recently used first.
  const inRow = new Set((props.row ?? []).map((c) => c.conversation_id))
  const openOnes = (props.row ?? []).filter((c) => c.conversation_id !== props.currentId)
  const earlier = props.row ? chats.filter((c) => !inRow.has(c.conversation_id)) : chats
  const background = others.filter((c) => c.kind !== 'chat')
  // What is going on elsewhere, said on the button so the menu need not be open.
  const working = others.filter((c) => c.status !== 'idle').length
  const answered = others.filter((c) => props.unread.has(c.conversation_id)).length

  const close = (): void => {
    setOpen(false)
    setMode('list')
    setProblem(null)
  }

  // Click-away and Escape close it, as any menu does.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
      close()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.')
    }
  }

  const item = (conversation: ConversationSummary) => (
    <button
      key={conversation.conversation_id}
      type="button"
      class="menu-item"
      role="menuitem"
      onClick={() => {
        props.onSelect(conversation.conversation_id)
        close()
      }}
    >
      <span class="menu-label">
        <StatusDot conversation={conversation} unread={props.unread} />
        {nameOf(conversation)}
      </span>
      {conversation.kind === 'chat' && props.holds?.(conversation)}
      <span class="menu-note">{conversationMeta(conversation)}</span>
    </button>
  )

  /** A session that is open: the way to it, and beside it the way to put it away. */
  const openItem = (conversation: ConversationSummary) => (
    <div key={conversation.conversation_id} class="menu-row">
      {item(conversation)}
      {props.onPutAway && (
        <button
          type="button"
          class="menu-put-away"
          aria-label={`Put away ${nameOf(conversation)}`}
          title="Put this session away. Nothing is deleted; it stays in this menu."
          onClick={() => props.onPutAway?.(conversation.conversation_id)}
        >
          ×
        </button>
      )}
    </div>
  )

  return (
    <div class="conv-wrap" ref={wrap}>
      <button
        type="button"
        class={open ? 'conv-button on' : 'conv-button'}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          current
            ? `In “${nameOf(current)}”. Click to switch, rename or start another.`
            : 'Choose a conversation'
        }
        onClick={() => (open ? close() : setOpen(true))}
      >
        {props.lead}
        {current && <StatusDot conversation={current} unread={props.unread} />}
        <span class="conv-label">{current ? nameOf(current) : 'Conversations'}</span>
        {(working > 0 || answered > 0) && (
          <span
            class={answered > 0 ? 'conv-elsewhere answered' : 'conv-elsewhere'}
            title={[
              working > 0 ? `${working} other conversation${working === 1 ? ' is' : 's are'} working` : '',
              answered > 0 ? `${answered} ha${answered === 1 ? 's' : 've'} answered` : '',
            ]
              .filter(Boolean)
              .join('; ')}
          >
            {answered > 0 ? `${answered} new` : `${working} working`}
          </span>
        )}
        <span class="conv-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div class="conv-menu" role="menu">
          {props.project && (
            <div class="menu-project" title={props.project.root}>
              {props.project.name}
            </div>
          )}
          {current && (
            <div class="conv-current">
              <div class="menu-kicker">
                {current.kind !== 'chat' ? 'Looking at' : props.sessions ? 'This session' : 'Talking in'}
              </div>
              {mode === 'rename' ? (
                <form
                  class="conv-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void attempt(() => props.onRename(current.conversation_id, title))
                  }}
                >
                  <input
                    value={title}
                    maxLength={200}
                    aria-label="Conversation name"
                    ref={nameInput}
                    onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
                  />
                  <button type="submit" disabled={title.trim() === ''}>
                    Save
                  </button>
                </form>
              ) : (
                <div class="conv-title">{nameOf(current)}</div>
              )}
              {current.kind === 'chat' && props.holds?.(current)}
              <div class="menu-note">{conversationMeta(current)}</div>

              {mode === 'delete' ? (
                <div class="conv-confirm">
                  <span>
                    Delete this conversation? Notes and summaries it wrote are files and stay.
                  </span>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => void attempt(() => props.onDelete(current.conversation_id))}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setMode('list')}>
                    Keep
                  </button>
                </div>
              ) : (
                <div class="conv-actions">
                  {current.kind === 'chat' && (
                    <button
                      type="button"
                      class="link"
                      onClick={() => {
                        setTitle(current.title)
                        setMode('rename')
                      }}
                    >
                      Rename
                    </button>
                  )}
                  <a class="link" href={api.exportUrl(current.conversation_id, 'markdown')} download>
                    Export
                  </a>
                  {current.kind === 'chat' && props.onPutAway && (
                    <button
                      type="button"
                      class="link"
                      data-action="put-away"
                      title="Put this session away. Nothing is deleted; it stays in this menu."
                      onClick={() => {
                        props.onPutAway?.(current.conversation_id)
                        close()
                      }}
                    >
                      Put away
                    </button>
                  )}
                  {current.kind === 'chat' && (
                    <button
                      type="button"
                      class="link"
                      disabled={current.status !== 'idle'}
                      title={
                        current.status !== 'idle' ? 'Stop the run before deleting' : undefined
                      }
                      onClick={() => setMode('delete')}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
              {problem !== null && (
                <div class="conv-problem" role="alert">
                  {problem}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={() => {
              props.onNew()
              close()
            }}
          >
            <span class="menu-label">{props.sessions ? '＋ New session' : '＋ New conversation'}</span>
            <span class="menu-note">
              {props.sessions
                ? 'Its own text, paper and conversation; this one stays here to come back to.'
                : 'The agent starts fresh; this one stays here to come back to.'}
            </span>
          </button>

          {openOnes.length > 0 && (
            <>
              <div class="menu-section">Open sessions</div>
              <div class="conv-list">{openOnes.map(openItem)}</div>
            </>
          )}
          {earlier.length > 0 && (
            <div class="menu-section">
              {props.row ? 'Put away' : props.sessions ? 'Other sessions' : 'Earlier conversations'}
            </div>
          )}
          <div class="conv-list">{earlier.map(item)}</div>

          {background.length > 0 && (
            <>
              <div class="menu-section" title="Work the application started itself">
                Background
              </div>
              <div class="conv-list">{background.map(item)}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function StatusDot({
  conversation,
  unread,
}: {
  conversation: ConversationSummary
  unread: ReadonlySet<string>
}) {
  if (conversation.status !== 'idle') {
    return <span class="dot working" title="The agent is working here" />
  }
  if (unread.has(conversation.conversation_id)) {
    const failed = conversation.last_run_status === 'failed'
    return (
      <span
        class={failed ? 'dot failed' : 'dot answered'}
        title={failed ? 'The last run failed' : 'Answered since you last looked'}
      />
    )
  }
  return null
}
