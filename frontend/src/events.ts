/**
 * Server-sent events with resumable delivery.
 *
 * The server assigns every event a durable sequence ID. We track the highest
 * one seen and reconnect with it, so a dropped connection replays exactly the
 * events that were missed — no duplicated messages, no lost edits.
 */

import { getSessionToken, refreshSessionToken } from './api'

export type ServerEvent = {
  /** Absent on live-only events (the fragments of a reply as it streams). */
  seq?: number
  type: string
  conversation_id: string | null
  run_id: string | null
  created_at?: string
} & Record<string, unknown>

type Listener = (event: ServerEvent) => void

export class EventStream {
  private source: EventSource | null = null
  private listeners = new Set<Listener>()
  private lastSeq = 0
  private retry = 0
  private timer: number | null = null
  private closed = false

  constructor(private readonly onStatus?: (connected: boolean) => void) {}

  start(sinceSeq = 0): void {
    this.lastSeq = Math.max(this.lastSeq, sinceSeq)
    this.connect()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.source?.close()
    this.source = null
  }

  private connect(): void {
    if (this.closed) return
    this.source?.close()

    const url = `/api/events?since=${this.lastSeq}&token=${encodeURIComponent(getSessionToken())}`
    const source = new EventSource(url)
    this.source = source

    source.onopen = () => {
      this.retry = 0
      this.onStatus?.(true)
    }

    source.onmessage = (message) => this.dispatch(message)
    // The server names each frame by event type, so listen for each one.
    for (const name of KNOWN_EVENTS) {
      source.addEventListener(name, (message) => this.dispatch(message as MessageEvent))
    }

    source.onerror = () => {
      this.onStatus?.(false)
      source.close()
      if (this.closed) return
      // Reconnect with backoff; the replay is driven by lastSeq, not by the
      // browser's own Last-Event-ID handling, so nothing is lost meanwhile.
      this.retry = Math.min(this.retry + 1, 6)
      const delay = Math.min(500 * 2 ** (this.retry - 1), 10_000)
      // A stream refused for its credential fails just like one that dropped,
      // and would be refused again for ever: the server restarted and has a
      // new one. Pick that up before trying again.
      void refreshSessionToken().finally(() => {
        if (this.closed) return
        this.timer = window.setTimeout(() => this.connect(), delay)
      })
    }
  }

  private dispatch(message: MessageEvent): void {
    let event: ServerEvent
    try {
      event = JSON.parse(message.data) as ServerEvent
    } catch {
      return
    }
    if (event.type === 'ping') return
    if (typeof event.seq === 'number') {
      if (event.seq <= this.lastSeq) return // already applied
      this.lastSeq = event.seq
    }
    for (const listener of this.listeners) listener(event)
  }
}

const KNOWN_EVENTS = [
  'text_delta',
  'tool_started',
  'tool_finished',
  'file_proposed',
  'file_changed',
  'error',
  'done',
  'notice',
  'run_queued',
  'run_started',
  'conversation_updated',
  'message_added',
  'document_updated',
  'job_updated',
  'sync_updated',
  'ping',
]
