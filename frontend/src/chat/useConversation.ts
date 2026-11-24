/**
 * One conversation, kept current: read once, then followed on the stream.
 *
 * The two have to meet without a gap or an overlap. The server reports the
 * newest event it had when it read the conversation; events at or below that
 * are already in what it returned, and anything later arrives on the stream.
 * Events that arrive while the read is in flight are held and sorted the same
 * way once it lands.
 */

import { useEffect, useState } from 'preact/hooks'

import { api, type ConversationSummary } from '../api'
import type { EventStream, ServerEvent } from '../events'
import { applyEvent, latestSeq, turnFromRecord, type Turn } from './turns'

export interface ConversationView {
  id: string | null
  loading: boolean
  error: string | null
  kind: ConversationSummary['kind']
  turns: Turn[]
}

const EMPTY: ConversationView = { id: null, loading: false, error: null, kind: 'chat', turns: [] }

export function useConversation(id: string | null, stream: EventStream | null): ConversationView {
  const [view, setView] = useState<ConversationView>(EMPTY)

  useEffect(() => {
    if (!id) {
      setView(EMPTY)
      return
    }
    let cancelled = false
    let loaded = false
    let floor = 0
    const held: ServerEvent[] = []
    setView({ id, loading: true, error: null, kind: 'chat', turns: [] })

    const fresh = (event: ServerEvent): boolean =>
      typeof event.seq !== 'number' || event.seq > floor

    const unsubscribe = stream?.subscribe((event) => {
      if (event.conversation_id !== id) return
      if (!loaded) {
        held.push(event)
        return
      }
      if (!fresh(event)) return
      setView((current) =>
        current.id === id ? { ...current, turns: applyEvent(current.turns, event) } : current,
      )
    })

    api
      .conversation(id)
      .then((conversation) => {
        if (cancelled) return
        floor = latestSeq(conversation.turns, conversation.latest_seq)
        let turns = conversation.turns.map(turnFromRecord)
        for (const event of held) if (fresh(event)) turns = applyEvent(turns, event)
        held.length = 0
        loaded = true
        setView({ id, loading: false, error: null, kind: conversation.kind, turns })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setView({
          id,
          loading: false,
          error: error instanceof Error ? error.message : 'The conversation could not be read.',
          kind: 'chat',
          turns: [],
        })
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [id, stream])

  return view
}
