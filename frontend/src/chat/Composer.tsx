/**
 * Where a message is written, and what goes with it.
 *
 * What is attached is listed above the text, each piece removable: the note
 * that is open, a selection, the passage on screen, and whichever papers the
 * user picks as starting points. Papers are picked from a list that can be
 * filtered, because a project soon has more of them than fit in a row.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import type { AgentStatus, DocumentRecord, DownloadMode, MessageContext } from '../api'
import { MicButton, stopDictation } from '../speech'
import { AgentMenu, type AgentChoice } from './AgentMenu'
import { shorten, type Names } from './describe'

export interface ComposerProps {
  agent: AgentStatus
  documents: DocumentRecord[]
  names: Names
  context: MessageContext
  draft: string
  /** A run is going in this conversation; a new message waits its turn. */
  busy: boolean
  /** The conversation takes no messages (background work). */
  readOnly: boolean
  onDraft: (text: string) => void
  onContextChange: (context: MessageContext) => void
  onSend: () => void
  onStop: () => void
  downloads: DownloadMode
  onDownloads: (mode: DownloadMode) => void
  /** The model and effort this session is answered with, and the way to change them. */
  choice: AgentChoice
  onChoice: (choice: AgentChoice) => void
}

/** Past this many attached papers, the chips give way to a count. */
const MANY_PAPERS = 4

export function Composer(props: ComposerProps) {
  const { context } = props
  const [picking, setPicking] = useState(false)
  /** Why dictation stopped, said above the buttons until the next press. */
  const [micError, setMicError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const attached = context.document_ids ?? []

  // Grow with what is typed, up to a share of the panel; then scroll.
  useEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight + 2, window.innerHeight * 0.4)}px`
  }, [props.draft])

  const toggle = (id: string): void => {
    props.onContextChange({
      ...context,
      document_ids: attached.includes(id)
        ? attached.filter((item) => item !== id)
        : [...attached, id],
    })
  }

  if (props.readOnly) {
    return (
      <div class="composer read-only">
        Work the application started itself, such as summaries of imported papers. To ask
        about it, start a conversation of your own.
      </div>
    )
  }

  const canSend = props.agent.ready && props.draft.trim() !== ''
  // What was being dictated is part of the message; nothing more is to come.
  const send = (): void => {
    stopDictation()
    props.onSend()
  }

  return (
    <div class="composer">
      <div class="attached" aria-label="Sent with the message">
        {context.note_id && (
          <span class="chip" title="The agent is told which note is open">
            <span class="chip-kind">note</span>
            {shorten(props.names.note(context.note_id), 26)}
          </span>
        )}
        {context.selection && (
          <span class="chip" title={context.selection}>
            “{shorten(context.selection, 26)}”
            <button
              type="button"
              aria-label="Do not send the selection"
              onClick={() =>
                props.onContextChange({ ...context, selection: null, selection_in: null })
              }
            >
              ×
            </button>
          </span>
        )}
        {context.reference_id && (
          <span class="chip" title="The passage open in the source panel">
            <span class="chip-kind">passage</span>
            {context.reference_id}
            <button
              type="button"
              aria-label="Do not send the open passage"
              onClick={() =>
                props.onContextChange({ ...context, reference_id: null, page_number: null })
              }
            >
              ×
            </button>
          </span>
        )}
        {attached.length > MANY_PAPERS ? (
          // A whole collection attached: one chip that says how many, not forty.
          <span
            class="chip paper"
            title={attached.map((id) => props.names.document(id)).join('\n')}
          >
            {attached.length} papers
            <button
              type="button"
              aria-label="Detach all papers"
              onClick={() => props.onContextChange({ ...context, document_ids: [] })}
            >
              ×
            </button>
          </span>
        ) : (
          attached.map((id) => (
            <span key={id} class="chip paper" title="Attached as a starting point">
              {shorten(props.names.document(id), 26)}
              <button type="button" aria-label="Detach this paper" onClick={() => toggle(id)}>
                ×
              </button>
            </span>
          ))
        )}
        {props.documents.length > 0 && (
          <button
            type="button"
            class={picking ? 'chip add on' : 'chip add'}
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
          >
            ＋ Paper
          </button>
        )}
      </div>

      {picking && (
        <PaperPicker
          documents={props.documents}
          attached={attached}
          onToggle={toggle}
          onAttach={(ids) =>
            props.onContextChange({
              ...context,
              document_ids: Array.from(new Set([...attached, ...ids])),
            })
          }
          onClose={() => setPicking(false)}
        />
      )}

      <textarea
        ref={input}
        value={props.draft}
        rows={2}
        placeholder={
          props.agent.ready
            ? 'Ask about the papers, or ask for a note to be written…'
            : 'Configure an agent to use chat'
        }
        disabled={!props.agent.ready}
        onInput={(event) => props.onDraft((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          // Enter sends; Shift-Enter is a new line. Not while an input method
          // is composing: there, Enter picks a candidate.
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault()
            if (canSend) send()
          }
        }}
      />

      {micError && (
        <p class="composer-error" role="alert">
          {micError}
        </p>
      )}

      <div class="composer-actions">
        <span class="hint">
          {props.busy
            ? 'Working — a new message waits its turn'
            : 'Enter to send · Shift-Enter for a new line'}
        </span>
        <AgentMenu agent={props.agent} choice={props.choice} onChoice={props.onChoice} />
        <label
          class="downloads-setting"
          title="Whether the agent may download a paper from the web when you ask it to add one"
        >
          Downloads
          <select
            value={props.downloads}
            data-setting="downloads"
            onChange={(event) =>
              props.onDownloads((event.target as HTMLSelectElement).value as DownloadMode)
            }
          >
            <option value="ask">ask</option>
            <option value="always">always</option>
            <option value="never">never</option>
          </select>
        </label>
        {props.busy && (
          <button type="button" class="stop" onClick={props.onStop}>
            Stop
          </button>
        )}
        <MicButton
          input={input}
          onText={props.onDraft}
          onError={setMicError}
          disabled={!props.agent.ready}
        />
        <button type="button" class="primary" disabled={!canSend} onClick={send}>
          Send
        </button>
      </div>
    </div>
  )
}

function PaperPicker({
  documents,
  attached,
  onToggle,
  onAttach,
  onClose,
}: {
  documents: DocumentRecord[]
  attached: string[]
  onToggle: (id: string) => void
  onAttach: (ids: string[]) => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const search = useRef<HTMLInputElement | null>(null)
  useEffect(() => search.current?.focus(), [])
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return documents
    return documents.filter((document) => {
      // A tag is a way to say "these papers": typing one gathers them.
      const hay = `${document.display_title} ${document.authors ?? ''} ${document.year ?? ''} ${
        document.original_filename
      } ${document.tags.join(' ')}`.toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }, [documents, filter])

  return (
    <div
      class="paper-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {(documents.length > 6 || documents.some((document) => document.tags.length > 0)) && (
        <input
          type="search"
          value={filter}
          placeholder="Filter by title, author or tag…"
          aria-label="Filter papers"
          ref={search}
          onInput={(event) => setFilter((event.target as HTMLInputElement).value)}
        />
      )}
      <ul>
        {shown.map((document) => {
          const on = attached.includes(document.document_id)
          return (
            <li key={document.document_id}>
              <button
                type="button"
                class={on ? 'paper on' : 'paper'}
                aria-pressed={on}
                onClick={() => onToggle(document.document_id)}
              >
                <span class="check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span class="paper-title">{document.display_title}</span>
                <span class="muted">
                  {[document.authors, document.year, ...document.tags].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li class="muted empty">No paper matches.</li>}
      </ul>
      <div class="paper-picker-foot">
        <span class="muted">
          A starting point, not a promise that every page was read.
        </span>
        {filter.trim() !== '' && shown.length > 1 && (
          <button
            type="button"
            class="link"
            onClick={() => onAttach(shown.map((document) => document.document_id))}
          >
            Attach all {shown.length}
          </button>
        )}
        <button type="button" class="link" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
