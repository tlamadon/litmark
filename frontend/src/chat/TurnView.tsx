/**
 * One turn of the conversation: the request, and what the agent did about it.
 *
 * Prose is shown in full. Everything else is one line per step — which paper
 * was read, which passage was cited, which note was edited — and each line
 * opens the thing it names. A run of steps that has been followed by prose is
 * folded to a count, so a long turn reads as its argument rather than its log;
 * the steps of the moment stay open while the agent is working.
 */

import { useMemo } from 'preact/hooks'

import type { ChangeRecord, MessageContext, PermissionAnswer } from '../api'
import { renderMarkdown } from '../markdown'
import {
  describeChange,
  describeTool,
  shorten,
  type Activity,
  type Names,
  type OpenTarget,
} from './describe'
import {
  isFinished,
  type ChangeEntry,
  type Entry,
  type PermissionEntry,
  type Turn,
} from './turns'

/** Steps beyond this many, once prose has followed them, fold to a count. */
const FOLD_ABOVE = 3

type Block =
  | { kind: 'text'; text: string; unfinished: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'permission'; entry: PermissionEntry }
  | { kind: 'steps'; steps: Step[] }

interface Step extends Activity {
  times: number
}

/** Prose and runs of steps, in the order they happened. */
function blocksOf(entries: Entry[], names: Names): Block[] {
  const blocks: Block[] = []
  for (const entry of entries) {
    if (entry.kind === 'text') {
      blocks.push({ kind: 'text', text: entry.text, unfinished: Boolean(entry.unfinished) })
      continue
    }
    if (entry.kind === 'notice') {
      blocks.push({ kind: 'notice', text: entry.text })
      continue
    }
    if (entry.kind === 'permission') {
      blocks.push({ kind: 'permission', entry })
      continue
    }
    // An edit is announced by the step that made it; the change itself is
    // listed once, under the turn, where it can be opened and undone.
    if (entry.kind === 'change') continue

    const activity = describeTool(entry, names)
    let last = blocks[blocks.length - 1]
    if (!last || last.kind !== 'steps') {
      last = { kind: 'steps', steps: [] }
      blocks.push(last)
    }
    const previous = last.steps[last.steps.length - 1]
    // The same step again (the same page read twice running): one line that
    // counts, not two that say nothing new.
    if (
      previous &&
      previous.verb === activity.verb &&
      previous.target === activity.target &&
      previous.tone === activity.tone
    ) {
      previous.times += 1
    } else {
      last.steps.push({ ...activity, times: 1 })
    }
  }
  return blocks
}

/** "read 3 · searched 2 · cited 4" — a folded run of steps, at a glance. */
function tally(steps: Step[]): string {
  const counts = new Map<string, number>()
  for (const step of steps) counts.set(step.verb, (counts.get(step.verb) ?? 0) + step.times)
  return Array.from(counts, ([verb, n]) => (n > 1 ? `${verb} ${n}` : verb)).join(' · ')
}

export interface TurnViewProps {
  turn: Turn
  names: Names
  changes: ChangeRecord[]
  onOpen: (target: OpenTarget) => void
  onOpenSource: (referenceId: string) => void
  onStop: (runId: string) => void
  onRetry: (turn: Turn) => void
  onUndo: (changeId: string) => void
  /** Answer the agent's request to download a paper. */
  onPermission: (requestId: string, answer: PermissionAnswer) => void
}

export function TurnView({ turn, names, ...actions }: TurnViewProps) {
  const blocks = useMemo(() => blocksOf(turn.entries, names), [turn.entries, names])
  const edits = turn.entries.filter((entry): entry is ChangeEntry => entry.kind === 'change')
  const live = !isFinished(turn.status)
  const lastSteps = blocks.length - 1
  // A paper named in a reply opens beside it, like a step that read one.
  const openPaper = (documentId: string): void =>
    actions.onOpen({ kind: 'document', documentId, page: 1 })

  return (
    <article class={`turn ${turn.status}`} data-run={turn.runId}>
      <header class={turn.prompt === null ? 'turn-ask background' : 'turn-ask'}>
        <div class="turn-prompt">{turn.prompt ?? turn.label ?? 'Background work'}</div>
        <AttachedContext context={turn.context} names={names} onOpen={actions.onOpen} />
        <div class="turn-state">
          <StatusBadge turn={turn} />
          {live && (
            <button type="button" class="link" onClick={() => actions.onStop(turn.runId)}>
              {turn.status === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          )}
          {!live && turn.status !== 'succeeded' && turn.prompt !== null && (
            <button
              type="button"
              class="link"
              title="Send the same request again"
              onClick={() => actions.onRetry(turn)}
            >
              Ask again
            </button>
          )}
        </div>
      </header>

      {(blocks.length > 0 || turn.streaming || turn.status === 'running') && (
        <div class="turn-body">
          {blocks.map((block, index) => {
            if (block.kind === 'text') {
              return (
                <Prose
                  key={index}
                  text={block.text}
                  unfinished={block.unfinished}
                  onOpenSource={actions.onOpenSource}
                  onOpenPaper={openPaper}
                />
              )
            }
            if (block.kind === 'notice') {
              return (
                <p key={index} class="turn-notice">
                  {block.text}
                </p>
              )
            }
            if (block.kind === 'permission') {
              return (
                <Permission
                  key={block.entry.requestId}
                  entry={block.entry}
                  live={live}
                  onAnswer={actions.onPermission}
                />
              )
            }
            // The steps of the moment stay open; earlier runs of them fold.
            const current = live && index === lastSteps && !turn.streaming
            return (
              <Steps
                key={index}
                steps={block.steps}
                folded={!current && block.steps.length > FOLD_ABOVE}
                onOpen={actions.onOpen}
              />
            )
          })}

          {turn.streaming && (
            <Prose
              text={turn.streaming}
              streaming
              onOpenSource={actions.onOpenSource}
              onOpenPaper={openPaper}
            />
          )}
          {turn.status === 'running' && !turn.streaming && (
            <div class="turn-working" role="status">
              <span class="dot working" />
              {turn.streamBroken ? 'writing…' : 'working…'}
            </div>
          )}
        </div>
      )}

      {(turn.error || edits.length > 0 || turn.usage) && (
        <footer class="turn-foot">
          {turn.error && <pre class="turn-error">{turn.error}</pre>}
          {edits.length > 0 && (
            <ul class="turn-changes">
              {edits.map((edit) => (
                <ChangeRow
                  key={edit.changeId}
                  edit={edit}
                  names={names}
                  record={actions.changes.find((c) => c.change_id === edit.changeId)}
                  onOpen={actions.onOpen}
                  onUndo={actions.onUndo}
                />
              ))}
            </ul>
          )}
          {turn.usage && <div class="turn-meta">{usageOf(turn)}</div>}
        </footer>
      )}
    </article>
  )
}

function usageOf(turn: Turn): string {
  const usage = turn.usage
  if (!usage) return ''
  const bits: string[] = []
  if (usage.num_turns) bits.push(`${usage.num_turns} step${usage.num_turns === 1 ? '' : 's'}`)
  if (usage.duration_ms) bits.push(`${(usage.duration_ms / 1000).toFixed(1)}s`)
  if (usage.cost_usd) bits.push(`$${usage.cost_usd.toFixed(4)}`)
  return bits.join(' · ')
}

function StatusBadge({ turn }: { turn: Turn }) {
  switch (turn.status) {
    case 'queued':
      return <span class="turn-badge queued">waiting its turn</span>
    case 'running':
      return <span class="turn-badge running">working</span>
    case 'failed':
      return <span class="turn-badge failed">failed</span>
    case 'cancelled':
      return (
        <span class="turn-badge stopped" title="Edits already saved were kept">
          stopped
        </span>
      )
    case 'interrupted':
      return <span class="turn-badge stopped">interrupted</span>
    default:
      return null
  }
}

/** What was attached to a request, each piece a way back to what it was. */
function AttachedContext({
  context,
  names,
  onOpen,
}: {
  context: MessageContext | null
  names: Names
  onOpen: (target: OpenTarget) => void
}) {
  if (!context) return null
  const documents = context.document_ids ?? []
  const pieces = []
  if (context.note_id) {
    const noteId = context.note_id
    pieces.push(
      <button
        key="note"
        type="button"
        class="ref"
        title="The note that was open"
        onClick={() => onOpen({ kind: 'note', noteId })}
      >
        <span class="chip-kind">note</span> {shorten(names.note(noteId), 28)}
      </button>,
    )
  }
  for (const documentId of documents) {
    pieces.push(
      <button
        key={documentId}
        type="button"
        class="ref"
        title="A paper attached as a starting point"
        onClick={() => onOpen({ kind: 'document', documentId, page: 1 })}
      >
        <span class="chip-kind">paper</span> {shorten(names.document(documentId), 28)}
      </button>,
    )
  }
  if (context.reference_id) {
    const referenceId = context.reference_id
    pieces.push(
      <button
        key="source"
        type="button"
        class="ref"
        title="The passage that was open"
        onClick={() => onOpen({ kind: 'reference', referenceId })}
      >
        <span class="chip-kind">passage</span> {referenceId}
      </button>,
    )
  }
  if (context.selection) {
    pieces.push(
      <span key="selection" class="turn-selection" title={context.selection}>
        “{shorten(context.selection, 40)}”
      </span>,
    )
  }
  if (pieces.length === 0) return null
  return <div class="turn-context">{pieces}</div>
}

const SETTLED: Record<string, string> = {
  allow: 'Allowed.',
  always: 'Allowed, and downloads are now always allowed.',
  deny: 'Not allowed.',
  expired: 'Not answered in time, so nothing was downloaded.',
  stopped: 'Stopped before it was answered.',
}

/** The agent asking leave to fetch a paper, with the address in full. */
function Permission({
  entry,
  live,
  onAnswer,
}: {
  entry: PermissionEntry
  live: boolean
  onAnswer: (requestId: string, answer: PermissionAnswer) => void
}) {
  const waiting = entry.answer === null && live
  return (
    <div
      class={waiting ? 'permission waiting' : 'permission'}
      role={waiting ? 'alertdialog' : undefined}
      aria-label="The agent asks to download a paper"
      data-request={entry.requestId}
    >
      <p>
        {waiting ? 'Download this paper?' : 'Asked to download'}{' '}
        <span class="permission-host">{entry.host}</span>
      </p>
      <code class="permission-url">{entry.url}</code>
      {waiting ? (
        <div class="permission-actions">
          <button
            type="button"
            class="primary"
            data-answer="allow"
            onClick={() => onAnswer(entry.requestId, 'allow')}
          >
            Allow
          </button>
          <button
            type="button"
            data-answer="always"
            title="Stop asking: the agent may download any paper you ask it for"
            onClick={() => onAnswer(entry.requestId, 'always')}
          >
            Always allow
          </button>
          <button type="button" data-answer="deny" onClick={() => onAnswer(entry.requestId, 'deny')}>
            Don’t allow
          </button>
        </div>
      ) : (
        <p class="permission-outcome">
          {entry.answer ? SETTLED[entry.answer] : 'The run ended before it was answered.'}
        </p>
      )}
    </div>
  )
}

function Steps({
  steps,
  folded,
  onOpen,
}: {
  steps: Step[]
  folded: boolean
  onOpen: (target: OpenTarget) => void
}) {
  const lines = steps.map((step, index) => <StepLine key={index} step={step} onOpen={onOpen} />)
  if (!folded) return <div class="steps">{lines}</div>
  const total = steps.reduce((n, step) => n + step.times, 0)
  const failed = steps.filter((step) => step.tone === 'bad').length
  return (
    <details class="steps folded">
      <summary>
        <span class="steps-count">{total} steps</span>
        <span class="steps-tally">{tally(steps)}</span>
        {failed > 0 && <span class="steps-failed">{failed} refused</span>}
      </summary>
      {lines}
    </details>
  )
}

function StepLine({ step, onOpen }: { step: Step; onOpen: (target: OpenTarget) => void }) {
  const target = step.open
  return (
    <div class={`step ${step.tone}`.trim()} title={step.detail}>
      <span class="verb">{step.verb}</span>
      {target ? (
        <button type="button" class="target ref" onClick={() => onOpen(target)}>
          {step.target}
        </button>
      ) : (
        <span class="target">{step.target}</span>
      )}
      {step.times > 1 && (
        <span class="times" title={`${step.times} times in a row`}>
          ×{step.times}
        </span>
      )}
    </div>
  )
}

function ChangeRow({
  edit,
  names,
  record,
  onOpen,
  onUndo,
}: {
  edit: ChangeEntry
  names: Names
  record: ChangeRecord | undefined
  onOpen: (target: OpenTarget) => void
  onUndo: (changeId: string) => void
}) {
  const activity = describeChange(edit, names)
  const target = activity.open
  return (
    <li class={record?.undone_at ? 'turn-change undone' : 'turn-change'}>
      <span class="mark" aria-hidden="true">
        ✎
      </span>
      {target ? (
        <button type="button" class="ref" onClick={() => onOpen(target)}>
          {activity.target}
        </button>
      ) : (
        <span>{activity.target}</span>
      )}
      {edit.summary && <span class="muted">{edit.summary}</span>}
      {record?.undone_at ? (
        <span class="muted">undone</span>
      ) : (
        record?.undoable && (
          <button type="button" class="link" onClick={() => onUndo(edit.changeId)}>
            Undo
          </button>
        )
      )}
    </li>
  )
}

function Prose({
  text,
  streaming = false,
  unfinished = false,
  onOpenSource,
  onOpenPaper,
}: {
  text: string
  streaming?: boolean
  unfinished?: boolean
  onOpenSource: (referenceId: string) => void
  onOpenPaper: (documentId: string) => void
}) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const classes = ['prose', streaming ? 'streaming' : '', unfinished ? 'unfinished' : '']
  return (
    <div
      class={classes.filter(Boolean).join(' ')}
      title={unfinished ? 'The run stopped here, mid-reply' : undefined}
      onClick={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-source-ref]')
          ?.dataset.sourceRef
        if (id) {
          event.preventDefault()
          onOpenSource(id)
          return
        }
        const paper = (event.target as HTMLElement).closest<HTMLElement>('[data-paper]')?.dataset
          .paper
        if (paper) {
          event.preventDefault()
          onOpenPaper(paper)
        }
      }}
      // Markdown is sanitized in renderMarkdown before it reaches the DOM.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
