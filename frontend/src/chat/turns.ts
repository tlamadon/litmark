/**
 * Turns: one stream of events, folded the same way live and on reload.
 *
 * A turn is a request and everything the agent did about it — its prose, each
 * tool it used, each file it changed. The server keeps a run's events with
 * durable sequence IDs, so a conversation read back is the same events the
 * browser followed while it ran, folded by the same function. The chat view
 * and the transcript view are two renderings of the result, which is why the
 * transcript cannot show a step the chat quietly dropped.
 */

import type { MessageContext, RunEvent, RunStatus, RunUsage, TurnRecord } from '../api'

export interface TextEntry {
  kind: 'text'
  text: string
  /** The run stopped mid-sentence; this is as far as the block got. */
  unfinished?: boolean
}

export interface ToolEntry {
  kind: 'tool'
  id: string
  tool: string
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  finished: boolean
  isError: boolean
}

export interface ChangeEntry {
  kind: 'change'
  changeId: string
  targetKind: 'note' | 'summary'
  targetId: string
  summary: string
}

export interface NoticeEntry {
  kind: 'notice'
  text: string
}

export type Entry = TextEntry | ToolEntry | ChangeEntry | NoticeEntry

export interface Turn {
  runId: string
  /** 'chat' for something the user asked; 'summary' for background work. */
  kind: string
  label: string | null
  status: RunStatus
  prompt: string | null
  context: MessageContext | null
  createdAt: string | null
  entries: Entry[]
  /** The block being written, fragment by fragment; replaced when it lands. */
  streaming: string
  /**
   * A fragment was missed (the page loaded mid-reply, or the connection
   * dropped). Fragments are not replayed, so rather than show text with a hole
   * in it, show nothing of this block until it arrives whole.
   */
  streamBroken: boolean
  error: string | null
  usage: RunUsage | null
  /** The last durable event folded in; an event at or below it is a replay. */
  seq: number
}

const FINISHED: RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted']

export const isFinished = (status: RunStatus): boolean => FINISHED.includes(status)

function blankTurn(runId: string): Turn {
  return {
    runId,
    kind: 'chat',
    label: null,
    status: 'queued',
    prompt: null,
    context: null,
    createdAt: null,
    entries: [],
    streaming: '',
    streamBroken: false,
    error: null,
    usage: null,
    seq: 0,
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Text that never arrived as a finished block still belongs to the turn. */
function settle(turn: Turn): Turn {
  if (!turn.streaming.trim()) return { ...turn, streaming: '' }
  return {
    ...turn,
    entries: [...turn.entries, { kind: 'text', text: turn.streaming }],
    streaming: '',
  }
}

/** Fold one event into a turn. Pure: the turn given is never changed. */
export function foldEvent(turn: Turn, event: RunEvent): Turn {
  if (typeof event.seq === 'number') {
    if (event.seq <= turn.seq) return turn
    turn = { ...turn, seq: event.seq }
  }

  switch (event.type) {
    case 'message_added':
      if (event.role !== 'user') return turn
      return {
        ...turn,
        prompt: String(event.content ?? ''),
        context: (event.context as MessageContext | null) ?? null,
        createdAt: String(event.created_at ?? turn.createdAt ?? ''),
      }

    case 'run_queued':
      return {
        ...turn,
        kind: String(event.kind ?? turn.kind),
        label: (event.label as string | null) ?? turn.label,
        createdAt: String(event.started_at ?? event.created_at ?? turn.createdAt ?? ''),
      }

    case 'run_started':
      return {
        ...turn,
        status: 'running',
        kind: String(event.kind ?? turn.kind),
        label: (event.label as string | null) ?? turn.label,
      }

    case 'text_delta': {
      const text = String(event.text ?? '')
      if (event.partial) {
        if (turn.streamBroken) return turn
        // Each fragment says where it belongs. One that does not follow what
        // is here means some were missed: wait for the block rather than guess.
        if (typeof event.offset === 'number' && event.offset !== turn.streaming.length) {
          return { ...turn, streaming: '', streamBroken: true }
        }
        return { ...turn, streaming: turn.streaming + text }
      }
      if (event.final) {
        const entry: TextEntry = { kind: 'text', text }
        if (event.unfinished) entry.unfinished = true
        return {
          ...turn,
          entries: text.trim() ? [...turn.entries, entry] : turn.entries,
          streaming: '',
          streamBroken: false,
        }
      }
      // Neither: a durable fragment, as older versions recorded them.
      return { ...turn, streaming: turn.streaming + text }
    }

    case 'tool_started': {
      const settled = settle(turn)
      const entry: ToolEntry = {
        kind: 'tool',
        id: String(event.tool_use_id ?? `seq-${event.seq ?? settled.entries.length}`),
        tool: String(event.tool ?? 'tool'),
        input: asRecord(event.input),
        result: null,
        finished: false,
        isError: false,
      }
      return { ...settled, entries: [...settled.entries, entry] }
    }

    case 'tool_finished': {
      const id = event.tool_use_id ? String(event.tool_use_id) : null
      const result = asRecord(event.result)
      // Without an id (older records), a result answers the oldest call of
      // that tool still waiting for one.
      const index = turn.entries.findIndex(
        (entry) =>
          entry.kind === 'tool' &&
          !entry.finished &&
          (id !== null ? entry.id === id : !event.tool || entry.tool === event.tool),
      )
      if (index < 0) return turn
      const entries = turn.entries.slice()
      const entry = entries[index] as ToolEntry
      entries[index] = {
        ...entry,
        finished: true,
        result,
        // A project tool that refused answers `ok: false`; that is a failure
        // of the step even though the call itself went through.
        isError: Boolean(event.is_error) || result.ok === false,
      }
      return { ...turn, entries }
    }

    case 'file_changed': {
      const settled = settle(turn)
      const entry: ChangeEntry = {
        kind: 'change',
        changeId: String(event.change_id ?? ''),
        targetKind: event.target_kind === 'summary' ? 'summary' : 'note',
        targetId: String(event.target_id ?? ''),
        summary: String(event.summary ?? ''),
      }
      return { ...settled, entries: [...settled.entries, entry] }
    }

    case 'notice': {
      const settled = settle(turn)
      return {
        ...settled,
        entries: [...settled.entries, { kind: 'notice', text: String(event.message ?? '') }],
      }
    }

    case 'error':
      return { ...settle(turn), error: String(event.message ?? 'The run failed.') }

    case 'done': {
      const settled = settle(turn)
      const reason = String(event.terminal_reason ?? 'endTurn')
      let status = event.status as RunStatus | undefined
      if (!status || !isFinished(status)) {
        if (reason === 'cancelled') status = 'cancelled'
        else if (reason === 'interrupted') status = 'interrupted'
        else status = settled.error || reason === 'error' ? 'failed' : 'succeeded'
      }
      return {
        ...settled,
        status,
        streamBroken: false,
        usage: (event.usage as RunUsage | undefined) ?? settled.usage,
        error:
          status === 'interrupted' && !settled.error
            ? String(event.message ?? 'This run was interrupted by a server restart.')
            : settled.error,
      }
    }

    default:
      return turn
  }
}

/** A turn as the server kept it: its events folded, then the row's last word. */
export function turnFromRecord(record: TurnRecord): Turn {
  let turn = blankTurn(record.run_id)
  turn.kind = record.kind
  turn.label = record.label
  turn.createdAt = record.message?.created_at ?? record.started_at
  turn.prompt = record.message?.content ?? null
  turn.context = (record.message?.context as MessageContext | null) ?? null
  for (const event of record.events) turn = foldEvent(turn, event)

  // The run's row says how it ended; events alone can lag a restart.
  if (isFinished(record.status)) turn = { ...settle(turn), status: record.status }
  else if (!isFinished(turn.status)) turn = { ...turn, status: record.status }
  if (record.error && !turn.error) turn = { ...turn, error: record.error }
  if (record.usage && !turn.usage) turn = { ...turn, usage: record.usage }

  // Recorded before runs kept their events: the reply is all there is.
  if (record.reply && !turn.entries.some((entry) => entry.kind === 'text')) {
    turn = { ...turn, entries: [...turn.entries, { kind: 'text', text: record.reply }] }
  }
  // Still going: the fragments of the block being written were live only.
  if (turn.status === 'running') turn = { ...turn, streaming: '', streamBroken: true }
  return turn
}

/** Fold a live event into the list of turns, starting a turn if it is new. */
export function applyEvent(turns: Turn[], event: RunEvent): Turn[] {
  const runId = event.run_id
  if (!runId) return turns
  const index = turns.findIndex((turn) => turn.runId === runId)
  if (index < 0) {
    // A fragment for a run this view has never heard of starts nothing.
    if (event.transient) return turns
    return [...turns, foldEvent(blankTurn(runId), event)]
  }
  const next = foldEvent(turns[index]!, event)
  if (next === turns[index]) return turns
  const copy = turns.slice()
  copy[index] = next
  return copy
}

/** The newest durable event already folded into these records. */
export function latestSeq(records: TurnRecord[], floor = 0): number {
  let seq = floor
  for (const record of records) {
    for (const event of record.events) {
      if (typeof event.seq === 'number' && event.seq > seq) seq = event.seq
    }
  }
  return seq
}
