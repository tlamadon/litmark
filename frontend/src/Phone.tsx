/**
 * The shell on a phone: what is drawn around the one pane on show.
 *
 * A bar along the top that is the session's: its name, and the list of the
 * others let down from it. A bar afloat along the bottom, in reach of a thumb,
 * with the three panes — Notes, Papers, Chat — which of them is on, and how
 * many of each are open. And the panel about a note or a paper, as a sheet
 * that slides up over the pane and is put away; the way to it is in the
 * pane's own line (see `PaneHead.tsx`).
 *
 * What is on show, and where an action leads, is worked out in `phonePanes.ts`;
 * the panes themselves are the application's own, placed by `App.tsx`.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import type { Behind, ChatSign, Held, Keyboard, PhonePane, PhoneTab } from './phonePanes'
import { keyboardAfter, PHONE_QUERY, PHONE_TABS, takesTyping } from './phonePanes'
import { touchFirst } from './touch'

/**
 * How wide the window is, as the layout asks it: narrow enough to be laid out
 * as a phone, and narrow enough that the text and the paper do not go side by
 * side. Asked together, and answered together: a tablet turned on its side
 * crosses both at once, and a moment in which only one had changed would be a
 * layout the window was never in — one that takes a pane off the page.
 */
export function useWidths(narrowQuery: string): { phone: boolean; narrow: boolean } {
  const read = (): { phone: boolean; narrow: boolean } => ({
    phone: window.matchMedia(PHONE_QUERY).matches,
    narrow: window.matchMedia(narrowQuery).matches,
  })
  const [widths, setWidths] = useState(read)
  useEffect(() => {
    const queries = [window.matchMedia(PHONE_QUERY), window.matchMedia(narrowQuery)]
    const onChange = (): void =>
      setWidths((before) => {
        const now = read()
        return now.phone === before.phone && now.narrow === before.narrow ? before : now
      })
    onChange()
    for (const query of queries) query.addEventListener('change', onChange)
    return () => {
      for (const query of queries) query.removeEventListener('change', onChange)
    }
  }, [narrowQuery])
  return widths
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
  /**
   * The session on screen, with the menu of the others: the row of tabs,
   * folded. It has the bar to itself — a session is the text, the paper and
   * the conversation that go together, and going to another changes all three.
   */
  session: ComponentChildren
  /** The connection to the server is down, and being tried again. */
  reconnecting: boolean
  /**
   * The version running. Its number is at the foot of the session's menu; what
   * is drawn of it here is only what speaks up — a later release, a page to reload.
   */
  version: ComponentChildren
  /**
   * Focus — a link opens over what is being read, not in its place — and the
   * way to turn it on and off. An experiment: see `peeks.ts`.
   */
  focus: { on: boolean; toggle: () => void }
}

/**
 * The bar along the top, made as the one along the bottom is: the session in
 * a capsule, which opens downwards into the list of sessions. Nothing else is
 * in it: what is about the note or the paper on show is in that pane's own line.
 */
export function PhoneTop(props: PhoneTopProps) {
  return (
    <header class="topbar phone-top">
      {props.session}
      {props.reconnecting && (
        <span class="badge warn" title="Reconnecting…" aria-label="Reconnecting…">
          …
        </span>
      )}
      {props.version}
      <FocusButton {...props.focus} />
    </header>
  )
}

/**
 * The way into focus and out of it. Drawn as a frame around a single thing:
 * one document, and nothing beside it.
 */
export function FocusButton(props: { on: boolean; toggle: () => void; label?: boolean }) {
  const title = props.on
    ? 'Focus is on: one thing at a time, and a link opens over it. Press to turn it off.'
    : 'Focus: one thing at a time, and a link opens over it rather than in its place.'
  return (
    <button
      type="button"
      class={['ghost', 'focus-toggle', props.label ? '' : 'icon', props.on ? 'active' : '']
        .filter(Boolean)
        .join(' ')}
      data-action="focus"
      aria-pressed={props.on}
      aria-label="Focus"
      title={title}
      onClick={props.toggle}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M2.2 5.4V2.2h3.2M10.6 2.2h3.2v3.2M13.8 10.6v3.2h-3.2M5.4 13.8H2.2v-3.2"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <rect x="5.6" y="5.2" width="4.8" height="5.6" rx="0.8" fill="currentColor" opacity={props.on ? 1 : 0.45} />
      </svg>
      {props.label && <span>Focus</span>}
    </button>
  )
}

/** What the tabs are drawn with: a 16px box, a line, the ink of the text. */
const ICONS = {
  // Lines of writing.
  text: 'M3 3.75h10M3 6.6h10M3 9.45h10M3 12.3h6',
  // A page, its corner turned down.
  paper: 'M4.25 1.9h4.9l2.6 2.7v9.5h-7.5zM9 1.9v2.9h2.75',
  // What is said.
  chat: 'M2.6 3.1h10.8v7.6H8.2L5.2 13.4v-2.7H2.6z',
  // Sessions: several sets of work, one over another.
  sessions: 'M8 2.3 13.5 5 8 7.7 2.5 5zM2.7 8 8 10.6 13.3 8M2.7 10.9 8 13.5l5.3-2.6',
} as const

/**
 * The head of the session's capsule in the top bar: the mark of sessions, and
 * on it how many are open — as the tabs along the bottom say how many notes
 * and papers are.
 */
export function SessionsLead(props: { count: number; needsLooking?: boolean }) {
  return (
    <span class="phone-tab-icon sessions-lead">
      <PhoneIcon name="sessions" />
      {/* Something at the foot of the menu wants looking at: sync needs a decision, or failed. */}
      {props.needsLooking && <span class="dot bad sessions-attention" />}
      {props.count > 0 && (
        <span class="phone-tab-count" aria-hidden="true">
          {props.count}
        </span>
      )}
    </span>
  )
}

export function PhoneIcon(props: { name: keyof typeof ICONS; size?: number }) {
  const size = props.size ?? 20
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        d={ICONS[props.name]}
      />
    </svg>
  )
}

export interface PhoneBarProps {
  /** What fills the screen now. With the library up, no tab is the one on. */
  pane: PhonePane
  /** Whether there is anything on show behind the first two tabs. */
  behind: Behind
  /** How many notes, and how many papers, are open in the session. */
  counts: { text: number; paper: number }
  /** What the Chat tab says of the conversation: at work, or answered. */
  chat: ChatSign
  /** A tab pressed — the one already on, too. */
  onSelect: (tab: PhoneTab) => void
}

// The first two are named for what they hold: the notes (and summaries) open
// in the session, and its papers.
const TAB_NAMES: Record<PhoneTab, string> = { text: 'Notes', paper: 'Papers', chat: 'Chat' }
const CHAT_SIGNS: Record<Exclude<ChatSign, null>, string> = {
  working: 'the agent is working',
  answered: 'a new reply',
  failed: 'the run failed',
}

/**
 * The bar along the bottom, afloat over the pane: the three panes in a capsule
 * with a mark that slides to the one on. With the library up, none is.
 *
 * A tab with nothing behind it is quieter, and works: its pane says nothing
 * is open and offers the way to open something. The library is reached from
 * there, and from the list of what is open that a press on the tab already
 * on lets up — it is what the first two panes are filled from.
 */
export function PhoneBar(props: PhoneBarProps) {
  const on = PHONE_TABS.indexOf(props.pane as PhoneTab)
  return (
    <div class="phone-bar">
      <nav class="phone-tabs" aria-label="Panes" data-on={on >= 0 ? PHONE_TABS[on] : 'none'}>
        {/* The mark of the tab that is on: one shape that moves, not three that light up. */}
        <span class="phone-tabs-mark" aria-hidden="true" style={{ '--at': Math.max(on, 0) }} />
        {PHONE_TABS.map((tab) => {
          const current = props.pane === tab
          const empty = tab !== 'chat' && !props.behind[tab]
          const sign = tab === 'chat' ? props.chat : null
          const count = tab === 'chat' ? 0 : props.counts[tab]
          return (
            <button
              key={tab}
              type="button"
              class={['phone-tab', current ? 'on' : '', empty ? 'empty' : ''].filter(Boolean).join(' ')}
              data-tab={tab}
              data-sign={sign ?? undefined}
              aria-current={current ? 'page' : undefined}
              aria-label={
                sign
                  ? `${TAB_NAMES[tab]} — ${CHAT_SIGNS[sign]}`
                  : tab === 'chat'
                    ? undefined
                    : `${TAB_NAMES[tab]} — ${count === 0 ? 'none' : count} open`
              }
              onClick={() => props.onSelect(tab)}
            >
              <span class="phone-tab-icon">
                <PhoneIcon name={tab} />
                {sign && <span class={`phone-tab-sign ${sign}`} />}
                {count > 0 && (
                  <span class="phone-tab-count" aria-hidden="true">
                    {count}
                  </span>
                )}
              </span>
              <span class="phone-tab-name">{TAB_NAMES[tab]}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

/**
 * A pane with nothing in it: what is missing, and the way to open something.
 * It is a place to start from, not a dead end.
 */
export function EmptyPane(props: {
  kind: 'text' | 'paper'
  /** To the library, on the kind this pane is filled from. */
  onOpen: () => void
  /** Start a note, where the pane is the text's. */
  onNew?: () => void
}) {
  const text = props.kind === 'text'
  return (
    <div class="empty-pane" data-empty={props.kind}>
      <span class="empty-pane-icon">
        <PhoneIcon name={props.kind} size={30} />
      </span>
      <p>{text ? 'No note or summary open' : 'No paper open'}</p>
      <div class="empty-pane-actions">
        <button type="button" class="primary" data-action="open-from-library" onClick={props.onOpen}>
          {text ? 'Open a note' : 'Open a paper'}
        </button>
        {props.onNew && (
          <button type="button" data-action="new-note" onClick={props.onNew}>
            New note
          </button>
        )}
      </div>
    </div>
  )
}

export interface OpenListProps {
  kind: 'text' | 'paper'
  /** What is open, in the order it was opened; one of them is the one on show. */
  items: { key: string; label: string; current: boolean }[]
  onPick: (key: string) => void
  onClose: (key: string) => void
  /** To the library, on this kind, for something that is not open yet. */
  onOpenAnother: () => void
  onNew?: () => void
  onDismiss: () => void
}

/**
 * What is open in the session, of the kind the tab holds: a list over the bar
 * to go to another of them, close one, or open one more. The number on the
 * tab is how many are here.
 */
export function OpenList(props: OpenListProps) {
  const dismiss = useRef(props.onDismiss)
  dismiss.current = props.onDismiss
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const notes = props.kind === 'text'
  return (
    <>
      <div class="open-list-backdrop" onClick={props.onDismiss} />
      <div
        class="open-list"
        role="dialog"
        data-kind={props.kind}
        aria-label={notes ? 'Notes open in this session' : 'Papers open in this session'}
      >
        <div class="menu-kicker">Open in this session</div>
        <ul>
          {props.items.map((item) => (
            <li key={item.key} class={item.current ? 'on' : ''}>
              <button
                type="button"
                class="open-item"
                aria-current={item.current ? 'true' : undefined}
                onClick={() => props.onPick(item.key)}
              >
                <PhoneIcon name={props.kind} size={15} />
                <span>{item.label}</span>
              </button>
              <button
                type="button"
                class="open-close"
                aria-label={`Close ${item.label}`}
                title="Close it here. Nothing is deleted."
                onClick={() => props.onClose(item.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div class="open-list-foot">
          <button
            type="button"
            data-action="open-another"
            title={notes ? 'To the library, on its notes' : 'To the library, on its papers'}
            onClick={props.onOpenAnother}
          >
            Open another…
          </button>
          {props.onNew && (
            <button type="button" data-action="new-note" onClick={props.onNew}>
              New note
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * What a session holds, under its name in the menu: the text and the paper
 * open in it. Picking a session is picking the set, and this is what says so.
 */
export function SessionHolds(props: { held: Held }) {
  const { text, paper } = props.held
  if (text === null && paper === null) return <span class="menu-holds none">Nothing open</span>
  return (
    <span class="menu-holds">
      {text !== null && (
        <span class="held">
          <PhoneIcon name="text" size={13} />
          <span>{text}</span>
        </span>
      )}
      {paper !== null && (
        <span class="held">
          <PhoneIcon name="paper" size={13} />
          <span>{paper}</span>
        </span>
      )}
    </span>
  )
}

export interface AboutSheetProps {
  label: string
  onClose: () => void
  /** The panel itself. */
  children: ComponentChildren
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
      </div>
    </div>
  )
}
