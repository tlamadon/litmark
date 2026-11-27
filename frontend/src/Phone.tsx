/**
 * The shell on a phone: what is drawn around the one pane on show.
 *
 * A bar along the top with the library, the session and the way to the panel
 * about what is open; a bar along the bottom, in reach of a thumb, with the
 * three panes — Text, Paper, Chat — and which of them is on; and the panel
 * itself as a sheet that slides up over the pane and is put away again.
 *
 * What is on show, and where an action leads, is worked out in `phonePanes.ts`;
 * the panes themselves are the application's own, placed by `App.tsx`.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import type { ChatSign, Keyboard, PhonePane, PhoneTab } from './phonePanes'
import { keyboardAfter, PHONE_QUERY, PHONE_TABS, takesTyping } from './phonePanes'
import { touchFirst } from './touch'

/** Whether the window is narrow enough to be laid out as a phone, as it changes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY)
    const onChange = (event: MediaQueryListEvent): void => setPhone(event.matches)
    setPhone(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return phone
}

/** How long after the typing stops the bar along the bottom comes back. */
const BAR_RETURNS_MS = 250

/**
 * Whether text is being typed somewhere in the page: the keyboard is up, and
 * the bar along the bottom is in its way. Only where the page is worked by
 * touch: a narrow window on a desktop has no keyboard on its screen, and
 * nothing for the bar to get out of the way of.
 *
 * Read from what has the focus rather than remembered from the events about
 * it: a box taken off the page while it had the focus is not always followed
 * by word that it lost it, and a bar that stayed away for good would leave no
 * way between the panes. So it is asked again after anything the reader does.
 *
 * The bar comes back a moment after the typing stops, not at once: the press
 * that ends it is often on a button beside the box — Send — and a bar put
 * back between the press and its release would move that button from under it.
 *
 * It comes back, too, when the keyboard is seen to have been put away with
 * the box still holding the focus (see `keyboardAfter`).
 */
export function useTyping(enabled: boolean): boolean {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setTyping(false)
      return
    }
    let later: number | null = null
    let keyboard: Keyboard = 'unknown'
    const typingNow = (): boolean =>
      touchFirst() && keyboard !== 'down' && takesTyping(document.activeElement)
    const settle = (): void => {
      later = null
      setTyping(typingNow())
    }
    const look = (): void => {
      if (later !== null) window.clearTimeout(later)
      later = null
      if (typingNow()) setTyping(true)
      else later = window.setTimeout(settle, BAR_RETURNS_MS)
    }
    // After the press or the key has done what it does, and the page is redrawn.
    const lookSoon = (): void => void window.setTimeout(look, 0)
    // The focus gone somewhere else: what was known of the keyboard was about the last place.
    const onFocus = (): void => {
      keyboard = 'unknown'
      look()
    }
    const view = window.visualViewport
    const onView = (): void => {
      if (!view || window.innerHeight === 0) return
      // Zoomed in, less of the window is seen for another reason: counted out.
      const next = keyboardAfter(keyboard, (view.height * view.scale) / window.innerHeight)
      if (next === keyboard) return
      keyboard = next
      look()
    }
    look()
    view?.addEventListener('resize', onView)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', lookSoon)
    document.addEventListener('pointerup', lookSoon)
    document.addEventListener('keyup', lookSoon)
    return () => {
      if (later !== null) window.clearTimeout(later)
      view?.removeEventListener('resize', onView)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', lookSoon)
      document.removeEventListener('pointerup', lookSoon)
      document.removeEventListener('keyup', lookSoon)
    }
  }, [enabled])
  return typing
}

export interface PhoneTopProps {
  project: { name: string; root: string }
  /** The library is what is on show. */
  inLibrary: boolean
  onLibrary: () => void
  /** The session on screen, with the menu of the others: the row of tabs, folded. */
  session: ComponentChildren
  /** The connection to the server is down, and being tried again. */
  reconnecting: boolean
  /** The panel about what is open is up. */
  aboutOpen: boolean
  onAbout: () => void
  /** Something in the panel wants looking at: sync needs a decision, or failed. */
  aboutNeedsLooking: boolean
  /**
   * The version running. Its number is at the foot of the sheet; what is drawn
   * of it here is only what speaks up — a later release, a page to reload.
   */
  version: ComponentChildren
}

/** The bar along the top: the project, the library, the session, the panel. */
export function PhoneTop(props: PhoneTopProps) {
  return (
    <header class="topbar phone-top">
      <h1 title={props.project.root}>{props.project.name}</h1>
      <button
        type="button"
        class={props.inLibrary ? 'ghost active' : 'ghost'}
        data-action="library"
        aria-pressed={props.inLibrary}
        title={
          props.inLibrary
            ? 'Every paper and note — again to go back to what was open'
            : 'Every paper and note'
        }
        onClick={props.onLibrary}
      >
        Library
      </button>
      {props.session}
      {props.reconnecting && (
        <span class="badge warn" title="Reconnecting…" aria-label="Reconnecting…">
          …
        </span>
      )}
      {props.version}
      <button
        type="button"
        class={props.aboutOpen ? 'ghost icon about-button active' : 'ghost icon about-button'}
        data-action="about"
        aria-expanded={props.aboutOpen}
        aria-haspopup="dialog"
        aria-label={props.inLibrary ? 'Tags, and this window' : 'About what is open'}
        title={props.inLibrary ? 'Tags, and this window' : 'About what is open'}
        onClick={props.onAbout}
      >
        <svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true">
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path
            d="M8 7.2v4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </svg>
        {props.aboutNeedsLooking && <span class="dot bad" />}
      </button>
    </header>
  )
}

export interface PhoneTabsProps {
  /** What fills the screen now. With the library up, no tab is the one on. */
  pane: PhonePane
  /** What is behind each tab, in a few words; null when there is nothing. */
  behind: Record<PhoneTab, string | null>
  /** What the Chat tab says of the conversation: at work, or answered. */
  chat: ChatSign
  onSelect: (tab: PhoneTab) => void
}

const TAB_NAMES: Record<PhoneTab, string> = { text: 'Text', paper: 'Paper', chat: 'Chat' }
/** Said on a tab with nothing behind it, in place of what would be there. */
const NOTHING_BEHIND: Record<PhoneTab, string> = {
  text: 'nothing open',
  paper: 'none open',
  chat: '',
}
const CHAT_SIGNS: Record<Exclude<ChatSign, null>, string> = {
  working: 'working…',
  answered: 'new reply',
  failed: 'the run failed',
}

/**
 * The bar along the bottom: the three panes, which is on, and what is behind
 * each. A tab with nothing behind it is dimmed and says so; pressing it does
 * nothing, since there would be nothing to show.
 */
export function PhoneTabs(props: PhoneTabsProps) {
  return (
    <nav class="phone-tabs" aria-label="Panes">
      {PHONE_TABS.map((tab) => {
        const on = props.pane === tab
        const empty = tab !== 'chat' && props.behind[tab] === null
        const sign = tab === 'chat' ? props.chat : null
        const what = sign ? CHAT_SIGNS[sign] : (props.behind[tab] ?? NOTHING_BEHIND[tab])
        return (
          <button
            key={tab}
            type="button"
            class={on ? 'phone-tab on' : 'phone-tab'}
            data-tab={tab}
            data-sign={sign ?? undefined}
            aria-current={on ? 'page' : undefined}
            aria-disabled={empty}
            onClick={() => {
              if (!empty) props.onSelect(tab)
            }}
          >
            <span class="phone-tab-name">
              {TAB_NAMES[tab]}
              {sign && <span class={`dot ${sign}`} />}
            </span>
            <span class="phone-tab-what">{what}</span>
          </button>
        )
      })}
    </nav>
  )
}

export interface AboutSheetProps {
  label: string
  onClose: () => void
  /** The panel itself. */
  children: ComponentChildren
  /** What was at the end of the top bar on a wide window: sync, signing out, the version. */
  foot?: ComponentChildren
}

/**
 * The panel about what is open, as a sheet over the pane: slid up from the
 * bottom, put away by its button, by a press outside it, or by Escape.
 */
export function AboutSheet(props: AboutSheetProps) {
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      class="sheet-backdrop"
      onClick={(event) => {
        // A press on the pane behind, not one inside the sheet that bubbled.
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.label}>
        <button
          type="button"
          class="ghost icon sheet-close"
          data-action="close-about"
          aria-label="Close"
          title="Close"
          onClick={props.onClose}
        >
          ✕
        </button>
        {props.children}
        {props.foot && <footer class="sheet-foot">{props.foot}</footer>}
      </div>
    </div>
  )
}
