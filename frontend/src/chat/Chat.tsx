/**
 * The chat drawer.
 *
 * Two views over one stream of events. "Chat" shows each turn as a card: what
 * was asked, the agent's prose in full, and one line per step. "Transcript"
 * shows the same turns verbatim, the way a terminal session would — every
 * tool call with its arguments. Both are drawn from the same folded turns, so
 * the transcript cannot show a step the chat quietly dropped.
 *
 * Several conversations can be going at once. The header names the one on
 * screen and its menu switches between them; each keeps its own draft.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'

import {
  api,
  type AgentStatus,
  type ChangeRecord,
  type ConversationSummary,
  type DocumentRecord,
  type DownloadMode,
  type MessageContext,
  type NoteSummary,
} from '../api'
import type { EventStream } from '../events'
import type { AgentChoice } from './AgentMenu'
import { Composer } from './Composer'
import { ConversationMenu } from './ConversationMenu'
import { transcriptOf, type Names, type OpenTarget } from './describe'
import { TurnView } from './TurnView'
import { isFinished, type Turn } from './turns'
import { useConversation } from './useConversation'

export interface ChatProps {
  conversations: ConversationSummary[]
  currentId: string | null
  unread: ReadonlySet<string>
  stream: EventStream | null
  agent: AgentStatus
  documents: DocumentRecord[]
  notes: NoteSummary[]
  changes: ChangeRecord[]
  context: MessageContext
  onContextChange: (context: MessageContext) => void
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onOpen: (target: OpenTarget) => void
  onOpenSource: (referenceId: string) => void
  onUndo: (changeId: string) => void
  /** Fold the chat away, to a strip at the edge that brings it back. */
  onCollapse: () => void
  /**
   * The shell names the conversation and goes between them itself, and has no
   * edge to fold the chat to — a phone, where the top bar holds the menu.
   * There is then no header here at all: the room is the conversation's. The
   * message box folds to one line while the conversation is only being read.
   */
  bare?: boolean
  /** Whether the agent may fetch papers from the web, and the way to change it. */
  downloads: DownloadMode
  onDownloads: (mode: DownloadMode) => void
}

/** Close enough to the end that new text should keep the view there. */
const NEAR_BOTTOM = 80

const STARTERS = [
  'What is the research question of each paper, and how do they differ?',
  'Write a note comparing the identification strategies, with citations.',
  'Which assumptions does the attached paper rely on? Quote them.',
]

export function Chat(props: ChatProps) {
  const view = useConversation(props.currentId, props.stream)
  const [mode, setMode] = useState<'chat' | 'transcript'>('chat')
  const [problem, setProblem] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ id: string; choice: AgentChoice } | null>(null)
  // What is being typed belongs to the conversation it was typed in.
  const drafts = useRef(new Map<string, string>())
  const [draft, setDraftState] = useState('')
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  const setDraft = useCallback(
    (text: string): void => {
      if (props.currentId) drafts.current.set(props.currentId, text)
      setDraftState(text)
    },
    [props.currentId],
  )

  useEffect(() => {
    setDraftState(props.currentId ? (drafts.current.get(props.currentId) ?? '') : '')
    setProblem(null)
    pinned.current = true
  }, [props.currentId])

  const names = useMemo<Names>(() => {
    const documents = new Map(props.documents.map((d) => [d.document_id, d.display_title]))
    const notes = new Map(props.notes.map((n) => [n.note_id, n.title]))
    return {
      document: (id) => documents.get(id) ?? id,
      note: (id) => notes.get(id) ?? id,
    }
  }, [props.documents, props.notes])

  // Follow the reply as it grows, unless the reader has scrolled away to read
  // something earlier — then leave them where they are.
  useLayoutEffect(() => {
    const node = scroller.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  }, [view.turns, view.loading, mode])

  // Where the message box folds and unfolds, the log changes height under the
  // reader: one who was at the end of it stays at the end.
  useEffect(() => {
    const node = scroller.current
    if (!props.bare || !node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [props.bare])

  const active = view.turns.filter((turn) => !isFinished(turn.status))
  const running = active.find((turn) => turn.status === 'running') ?? active[0] ?? null

  const send = async (prompt: string, context: MessageContext): Promise<boolean> => {
    if (!props.currentId || !prompt.trim()) return false
    setProblem(null)
    pinned.current = true
    try {
      await api.sendMessage(props.currentId, prompt.trim(), context)
      return true
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The message could not be sent.')
      return false
    }
  }

  const stop = async (runId: string): Promise<void> => {
    try {
      await api.cancelRun(runId)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Stopping failed.')
    }
  }

  // The session's choice of model and effort. What was just picked shows at
  // once; the list of conversations catches up when the server announces it.
  const current = props.conversations.find((c) => c.conversation_id === props.currentId)
  const saved: AgentChoice = { model: current?.model ?? null, effort: current?.effort ?? null }
  const choice = picked !== null && picked.id === props.currentId ? picked.choice : saved
  // Once the server's word arrives it stands, whichever window it came from.
  useEffect(() => setPicked(null), [props.currentId, saved.model, saved.effort])
  const choose = async (next: AgentChoice): Promise<void> => {
    const id = props.currentId
    if (!id) return
    setProblem(null)
    setPicked({ id, choice: next })
    try {
      await api.setAgentChoice(id, next.model, next.effort)
    } catch (error) {
      setPicked(null)
      setProblem(error instanceof Error ? error.message : 'The model could not be changed.')
    }
  }

  // The verbatim view has no way in where there is no header: there, it is
  // the conversation that is shown, whatever was chosen in a wider window.
  const shown = props.bare ? 'chat' : mode
  const background = view.kind !== 'chat'
  const empty = !view.loading && view.error === null && view.turns.length === 0

  return (
    <section class="chat" aria-label="Chat">
      {!props.bare && (
      <header class="chat-head">
        <ConversationMenu
          conversations={props.conversations}
          currentId={props.currentId}
          unread={props.unread}
          onSelect={props.onSelect}
          onNew={props.onNew}
          onRename={props.onRename}
          onDelete={props.onDelete}
        />
        <button
          type="button"
          class="ghost icon"
          title="Start a new conversation"
          aria-label="New conversation"
          onClick={props.onNew}
        >
          ＋
        </button>
        <div class="view-tabs" role="tablist" aria-label="How the conversation is shown">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'chat'}
            class={mode === 'chat' ? 'on' : ''}
            onClick={() => setMode('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'transcript'}
            class={mode === 'transcript' ? 'on' : ''}
            title="Every step, verbatim, as a terminal would show it"
            onClick={() => setMode('transcript')}
          >
            Transcript
          </button>
        </div>
        <button
          type="button"
          class="ghost icon"
          data-action="hide-chat"
          title="Hide the chat"
          aria-label="Hide the chat"
          onClick={props.onCollapse}
        >
          »
        </button>
      </header>
      )}

      {!props.agent.ready && (
        <div class="notice" role="status">
          <strong>No agent configured.</strong>
          <p>{props.agent.message}</p>
          <p class="hint">
            Notes and PDFs work without one. Summaries and chat need a configured
            provider.
          </p>
        </div>
      )}

      <div
        class="chat-log"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM
        }}
      >
        {view.loading && <p class="chat-placeholder">Opening the conversation…</p>}
        {view.error !== null && (
          <p class="chat-error" role="alert">
            {view.error}
          </p>
        )}

        {empty && !background && (
          <div class="chat-placeholder">
            <p>
              Ask about the papers, or ask for a note to be written. The agent searches
              and reads the pages it needs, and cites what it quotes.
            </p>
            {props.agent.ready && props.documents.length > 0 && (
              <ul class="starters">
                {STARTERS.map((starter) => (
                  <li key={starter}>
                    <button type="button" onClick={() => setDraft(starter)}>
                      {starter}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {empty && background && (
          <p class="chat-placeholder">No background work has run yet.</p>
        )}

        {shown === 'chat' ? (
          view.turns.map((turn) => (
            <TurnView
              key={turn.runId}
              turn={turn}
              names={names}
              changes={props.changes}
              onOpen={props.onOpen}
              onOpenSource={props.onOpenSource}
              onStop={(runId) => void stop(runId)}
              onRetry={(again: Turn) => void send(again.prompt ?? '', again.context ?? {})}
              onUndo={props.onUndo}
              onPermission={(requestId, answer) => {
                // The answer comes back as an event, which settles the card.
                void api.answerPermission(requestId, answer).catch((error: unknown) => {
                  setProblem(error instanceof Error ? error.message : String(error))
                })
              }}
            />
          ))
        ) : (
          <Transcript turns={view.turns} />
        )}

        {problem !== null && (
          <p class="chat-error" role="alert">
            {problem}
          </p>
        )}
      </div>

      <Composer
        folding={props.bare}
        agent={props.agent}
        documents={props.documents}
        names={names}
        context={props.context}
        draft={draft}
        busy={active.length > 0}
        readOnly={background}
        downloads={props.downloads}
        onDownloads={props.onDownloads}
        choice={choice}
        onChoice={(next) => void choose(next)}
        onDraft={setDraft}
        onContextChange={props.onContextChange}
        onSend={() => {
          const text = draft
          setDraft('')
          void send(text, props.context).then((sent) => {
            // Not taken: give the words back rather than lose them.
            if (!sent) setDraft(text)
          })
        }}
        onStop={() => {
          if (running) void stop(running.runId)
        }}
      />
    </section>
  )
}

function Transcript({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) return null
  return (
    <pre class="transcript">
      {turns.flatMap((turn) =>
        transcriptOf(turn).map((line, index) => (
          <span key={`${turn.runId}-${index}`} class={`t-${line.tone}`}>
            {line.text}
            {'\n'}
          </span>
        )),
      )}
    </pre>
  )
}
