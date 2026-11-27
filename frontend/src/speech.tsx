/**
 * Dictation: press the microphone, speak, and the words are typed for you.
 *
 * Talking is often the quickest way to ask about a paper. Beside the boxes
 * where the agent is asked something (the chat's composer, and the box that
 * opens by a selected passage) a microphone turns on the browser's own speech
 * recognition. What it hears goes in at the caret as it is heard: provisional
 * words first, then the settled ones in their place. Press it again, press
 * Esc, or send, to stop.
 *
 * This is the browser's recogniser (the Web Speech API), not something
 * litmark runs, and that has consequences. A browser without one (Firefox,
 * at the time of writing) shows no microphone. Where it comes from decides
 * where your voice goes: Chrome and Edge send the audio to their vendor's
 * servers, Safari to Apple's. And browsers only lend the microphone to a page
 * served over HTTPS or from localhost. Nothing is captured before the button
 * is pressed or after it is released.
 *
 * Borrowed from texai's `speech.js`.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'

/** The part of a recogniser used here; TypeScript's DOM types lack it. */
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type RecognitionClass = new () => Recognition

// Looked up when asked, not once: a browser may expose it only after a
// setting or a permission changes, and a test can stand one in.
const recogniser = (): RecognitionClass | null => {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass
    webkitSpeechRecognition?: RecognitionClass
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Whether this browser can take dictation at all. */
export const speechAvailable = (): boolean => recogniser() !== null

// Only one microphone listens at a time: starting a second stops the first.
let current: (() => void) | null = null

/** Stop whatever is listening, e.g. because what it typed is being sent. */
export function stopDictation(): void {
  current?.()
}

/**
 * What was said, fitted between what is already there: a space on either side
 * where words would otherwise run together.
 */
export function joined(before: string, said: string, after = ''): string {
  if (!said) return ''
  const lead = before && !/\s$/.test(before) && !/^[\s.,;:!?)]/.test(said) ? ' ' : ''
  const tail = /^[\p{L}\p{N}]/u.test(after) ? ' ' : ''
  return lead + said + tail
}

function explain(error: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return window.isSecureContext
      ? 'The browser would not lend the microphone. Allow it for this page and try again.'
      : 'Browsers lend the microphone only to pages served over HTTPS or from localhost.'
  }
  if (error === 'audio-capture') return 'No microphone was found.'
  if (error === 'network') return 'Speech recognition could not reach its service.'
  if (error === 'language-not-supported') return 'Speech recognition does not know this language.'
  return `Dictation stopped: ${error}.`
}

const MIC_PATH =
  'M8 1.5a2 2 0 0 1 2 2V8a2 2 0 0 1-4 0V3.5a2 2 0 0 1 2-2zM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5'

export interface MicButtonProps {
  /** The box the words go into. */
  input: RefObject<HTMLTextAreaElement>
  /** Its text changed: the box is controlled, so the words go in through here. */
  onText: (text: string) => void
  /** What went wrong, in words a reader can act on; null when it is past. */
  onError?: (message: string | null) => void
  disabled?: boolean
}

/**
 * A microphone for a textarea, or nothing when the browser cannot take
 * dictation. It stops listening when it goes away.
 */
export function MicButton(props: MicButtonProps) {
  const [listening, setListening] = useState(false)
  const session = useRef<{ recognition: Recognition; stop: () => void } | null>(null)
  const latest = useRef(props)
  latest.current = props

  const stop = (): void => {
    const live = session.current
    if (!live) return
    session.current = null
    if (current === live.stop) current = null
    try {
      live.recognition.stop()
    } catch {
      // Already stopped: it ends on its own after a silence.
    }
    setListening(false)
    latest.current.input.current?.focus()
  }

  const start = (): void => {
    const Recogniser = recogniser()
    const box = latest.current.input.current
    if (!Recogniser || !box) return
    current?.()

    const recognition = new Recogniser()
    recognition.lang = document.documentElement.lang || navigator.language || 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    const live = { recognition, stop }
    session.current = live
    current = stop

    // What surrounds the caret when the button is pressed; what is heard goes
    // between, replacing whatever was heard before it.
    const at = box.selectionStart ?? box.value.length
    const before = box.value.slice(0, at)
    const after = box.value.slice(box.selectionEnd ?? at)

    recognition.onresult = (event) => {
      // Results after a stop are dropped: what was shown is what is sent.
      if (session.current !== live) return
      // Everything heard since the press, settled or not: the recogniser
      // revises its last few words as it goes.
      let said = ''
      for (let i = 0; i < event.results.length; i += 1) {
        said += event.results[i]?.[0]?.transcript ?? ''
      }
      const text = joined(before, said.replace(/\s+/g, ' ').trim(), after)
      const node = latest.current.input.current
      const value = before + text + after
      if (node) {
        // Set here as well as through the state, so the caret can be put
        // after the words now rather than after the next render.
        node.value = value
        const caret = before.length + text.length
        node.setSelectionRange(caret, caret)
      }
      latest.current.onText(value)
    }
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      latest.current.onError?.(explain(event.error))
    }
    // It ends itself after a long silence, or when the service drops it.
    recognition.onend = () => {
      if (session.current === live) stop()
    }

    try {
      recognition.start()
    } catch (error) {
      session.current = null
      current = null
      latest.current.onError?.(error instanceof Error ? error.message : String(error))
      return
    }
    latest.current.onError?.(null)
    setListening(true)
  }

  // Esc stops the microphone, and only that: the box it types into stays open.
  useEffect(() => {
    if (!listening) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      stop()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [listening])

  // Gone, or the box can no longer be typed into: stop listening.
  useEffect(() => () => stop(), [])
  useEffect(() => {
    if (props.disabled) stop()
  }, [props.disabled])

  if (!recogniser()) return null
  return (
    <button
      type="button"
      class={listening ? 'mic-button listening' : 'mic-button'}
      aria-label="Dictate"
      aria-pressed={listening}
      title={
        listening
          ? 'Listening… press again, or Esc, to stop'
          : 'Dictate: speak, and it is typed here (uses your browser’s speech recognition)'
      }
      disabled={props.disabled && !listening}
      // A press must not take the caret out of the box it is about to type into.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (session.current ? stop() : start())}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          d={MIC_PATH}
        />
      </svg>
    </button>
  )
}
