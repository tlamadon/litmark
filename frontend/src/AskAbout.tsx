/**
 * Asking the agent about a passage, from where it is read.
 *
 * Select some text — in the note or summary, or on a page of the paper — and
 * a small ✦ appears at the end of it. Click it (or press Cmd/Ctrl-K) and a box
 * opens by the passage for a request. Sending it is an ordinary turn in the
 * session on screen, with the passage attached and where it was found said,
 * so the chat keeps the whole record and is where the answer is read.
 *
 * It works from the selection the browser holds, wherever that is, rather
 * than from inside the editor or the viewer: the two panes are drawn by
 * different machinery, and what is wanted of them here is the same.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { SelectionIn } from './api'

/** The pane a selection is in: the note or summary, or the paper. */
export type AskPane = 'text' | 'paper'

/** What is asked about: the words, and where they are. */
export interface Passage {
  quote: string
  in: SelectionIn | null
}

export interface AskAboutProps {
  /** Whether the agent can take a request at all. */
  available: boolean
  /** What is selected in a pane, as the application knows it; null if nothing is. */
  passageIn: (pane: AskPane) => Passage | null
  /** Send it. Resolves to whether it was taken. */
  onAsk: (prompt: string, passage: Passage) => Promise<boolean>
}

interface Place {
  pane: AskPane
  /** The end of the selection, in the window: its right edge, top and bottom. */
  x: number
  top: number
  bottom: number
}

const IS_MAC = /mac/i.test(navigator.platform)
const BOX_WIDTH = 380
const BUTTON_SIZE = 22
/** Characters of the passage quoted at the head of the box. */
const MAX_QUOTE = 160

const elementOf = (node: Node | null): Element | null =>
  node instanceof Element ? node : (node?.parentElement ?? null)

function paneOf(node: Node | null): AskPane | null {
  const element = elementOf(node)
  if (element?.closest('.pdf-text-layer')) return 'paper'
  if (element?.closest('.editor-surface .cm-content')) return 'text'
  return null
}

/** Where the browser's selection ends, if it is a passage in one of the panes. */
function locate(): Place | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const pane = paneOf(selection.anchorNode)
  if (!pane || paneOf(selection.focusNode) !== pane) return null
  const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  )
  const last = rects[rects.length - 1]
  if (!last) return null
  return { pane, x: last.right, top: last.top, bottom: last.bottom }
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

export function AskAbout(props: AskAboutProps) {
  // The ✦, by a selection that can be asked about.
  const [offer, setOffer] = useState<Place | null>(null)
  // The box, once it is: the passage as it was when the box opened — what is
  // selected is let go of as soon as the typing starts.
  const [asking, setAsking] = useState<{ passage: Passage; at: Place } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [refused, setRefused] = useState(false)

  const latest = useRef(props)
  latest.current = props
  const state = useRef({ offer, asking, prompt, sending })
  state.current = { offer, asking, prompt, sending }
  const box = useRef<HTMLFormElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)

  const open = (): void => {
    if (!latest.current.available || state.current.sending) return
    const at = state.current.offer ?? locate()
    const passage = at ? latest.current.passageIn(at.pane) : null
    if (!at || !passage) return
    setAsking({ passage, at })
    setOffer(null)
    setPrompt('')
    setRefused(false)
  }
  const openRef = useRef(open)
  openRef.current = open

  const close = (): void => {
    setAsking(null)
    setPrompt('')
    setRefused(false)
  }

  useEffect(() => {
    const mine = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      Boolean(box.current?.contains(target) || button.current?.contains(target))

    let settle: number | null = null
    /** Offer the selection as it stands, once what made it has been taken in. */
    const refresh = (): void => {
      if (settle !== null) window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        settle = null
        if (state.current.asking || !latest.current.available) return
        const at = locate()
        setOffer(at && latest.current.passageIn(at.pane) ? at : null)
      }, 40)
    }

    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0 || mine(event.target)) return
      refresh()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      // A selection made from the keyboard: Shift and the arrows, or select-all.
      if (mine(event.target)) return
      if (event.shiftKey || event.key === 'Shift' || event.key === 'a' || event.key === 'A') {
        refresh()
      }
    }
    const onMouseDown = (event: MouseEvent): void => {
      if (mine(event.target)) return
      setOffer(null)
      // An empty box is not worth keeping open; one with a request typed in
      // closes only when asked to.
      const { asking: opened, prompt: typed, sending: busy } = state.current
      if (opened && !busy && !typed.trim()) close()
    }
    const onScroll = (event: Event): void => {
      // The passage has moved from under the ✦. The box stays: it says what
      // it is about.
      if (!mine(event.target)) setOffer(null)
    }
    const onSelectionChange = (): void => {
      // Typed over, or let go of: there is no passage for the ✦ to be about.
      if (state.current.offer && (window.getSelection()?.isCollapsed ?? true)) setOffer(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      if (state.current.asking || !latest.current.available) return
      const at = state.current.offer ?? locate()
      if (!at || !latest.current.passageIn(at.pane)) return
      event.preventDefault()
      openRef.current()
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('resize', onScroll)
    return () => {
      if (settle !== null) window.clearTimeout(settle)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  // An agent that is no longer there has nothing to be asked.
  useEffect(() => {
    if (!props.available) setOffer(null)
  }, [props.available])

  useEffect(() => {
    if (asking) input.current?.focus()
  }, [asking])

  // Under the passage, or above it where there is no room below.
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !asking) return
    const { at } = asking
    const height = node.offsetHeight
    const below = at.bottom + 8
    const top = below + height > window.innerHeight - 8 ? at.top - height - 8 : below
    node.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`
    node.style.left = `${clamp(at.x - BOX_WIDTH / 2, 8, window.innerWidth - BOX_WIDTH - 8)}px`
  }, [asking, prompt, refused])

  const send = async (): Promise<void> => {
    const request = prompt.trim()
    if (!asking || !request || sending) return
    setSending(true)
    setRefused(false)
    const taken = await props.onAsk(request, asking.passage).catch(() => false)
    setSending(false)
    if (taken) close()
    // Not taken: the words are kept, to be sent again.
    else setRefused(true)
  }

  const shortcut = `${IS_MAC ? 'Cmd' : 'Ctrl'}-K`

  return (
    <>
      {offer && !asking && (
        <button
          ref={button}
          type="button"
          class="ask-button"
          data-action="ask-about"
          title={`Ask the agent about this passage (${shortcut})`}
          aria-label="Ask the agent about this passage"
          style={{
            left: `${clamp(offer.x + 4, 4, window.innerWidth - BUTTON_SIZE - 4)}px`,
            top: `${clamp(offer.top - BUTTON_SIZE - 2, 4, window.innerHeight - BUTTON_SIZE - 4)}px`,
          }}
          // Keep the selection: a press on the button must not clear what it is for.
          onMouseDown={(event) => event.preventDefault()}
          onClick={open}
        >
          ✦
        </button>
      )}
      {asking && (
        <form
          ref={box}
          class="ask-box"
          role="dialog"
          aria-label="Ask the agent about the selected passage"
          style={{ width: `${BOX_WIDTH}px` }}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <blockquote class="ask-quote" title={asking.passage.quote}>
            {asking.passage.quote.length > MAX_QUOTE
              ? `${asking.passage.quote.slice(0, MAX_QUOTE - 1).trimEnd()}…`
              : asking.passage.quote}
          </blockquote>
          <textarea
            ref={input}
            rows={2}
            value={prompt}
            placeholder="Ask about this passage…"
            aria-label="What to ask about the passage"
            disabled={sending}
            onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
              }
              // Enter sends; Shift-Enter is a new line. Not while an input
              // method is composing: there, Enter picks a candidate.
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div class="ask-actions">
            <span class={refused ? 'hint refused' : 'hint'}>
              {refused
                ? 'That could not be sent.'
                : sending
                  ? 'Sending…'
                  : 'Enter to send · Esc to close'}
            </span>
            <button type="button" class="ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" class="primary" disabled={sending || !prompt.trim()}>
              Ask
            </button>
          </div>
        </form>
      )}
    </>
  )
}
