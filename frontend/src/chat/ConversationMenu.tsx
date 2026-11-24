/**
 * Which conversation the panel is in, and the others it could be.
 *
 * The header button names the current conversation; its menu lists every one
 * kept for this project and switches to any of them, or starts a new one.
 * Switching is free: each conversation keeps its own thread with the agent, a
 * run in one carries on while another is open, and the list says which are
 * working and which have answered since they were last looked at.
 */

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
  const others = props.conversations.filter((c) => c.conversation_id !== props.currentId)
  const chats = others.filter((c) => c.kind === 'chat')
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
        {conversation.title}
      </span>
      <span class="menu-note">{conversationMeta(conversation)}</span>
    </button>
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
            ? `In “${current.title}”. Click to switch, rename or start another.`
            : 'Choose a conversation'
        }
        onClick={() => (open ? close() : setOpen(true))}
      >
        {current && <StatusDot conversation={current} unread={props.unread} />}
        <span class="conv-label">{current?.title ?? 'Conversations'}</span>
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
          {current && (
            <div class="conv-current">
              <div class="menu-kicker">{current.kind === 'chat' ? 'Talking in' : 'Looking at'}</div>
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
                <div class="conv-title">{current.title}</div>
              )}
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
            <span class="menu-label">＋ New conversation</span>
            <span class="menu-note">
              The agent starts fresh; this one stays here to come back to.
            </span>
          </button>

          {chats.length > 0 && <div class="menu-section">Earlier conversations</div>}
          <div class="conv-list">{chats.map(item)}</div>

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
