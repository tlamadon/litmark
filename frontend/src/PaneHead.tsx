/**
 * The line at the top of a pane, where the window shows one pane at a time:
 * what is in the pane, said the same way whichever pane it is.
 *
 * The title is the handle on the document. Pressed, its contents are let down
 * under it — the headings of a note, the sections of a paper, the questions
 * asked in a conversation — and one of them is a place to go. At the far end
 * of the line, for a note or a paper, is the way to the panel about it.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

export interface PaneTitleProps {
  /** What is in the pane. */
  title: string
  /** Whether its contents are down. */
  open: boolean
  /** Let the contents down, or put them away. Left out, the title is only a title. */
  onPress?: () => void
  /** What the contents are, for whoever cannot see the mark: "Headings", "Sections". */
  contents?: string
}

/** The title of what is in the pane: a button to its contents where it has any. */
export function PaneTitle(props: PaneTitleProps) {
  if (!props.onPress) {
    return (
      <span class="pane-title" title={props.title}>
        <span class="pane-title-text">{props.title}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      class={props.open ? 'pane-title pressable on' : 'pane-title pressable'}
      data-action="contents"
      aria-expanded={props.open}
      aria-haspopup="dialog"
      title={props.contents ? `${props.title} — ${props.contents}` : props.title}
      onClick={props.onPress}
    >
      <span class="pane-title-text">{props.title}</span>
      <span class="pane-title-mark" aria-hidden="true">
        ▾
      </span>
    </button>
  )
}

/** The way to the panel about what is in the pane. */
export function InfoButton(props: { open: boolean; label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      class={props.open ? 'ghost icon about-button active' : 'ghost icon about-button'}
      data-action="about"
      aria-expanded={props.open}
      aria-haspopup="dialog"
      aria-label={props.label}
      title={props.label}
      onClick={props.onPress}
    >
      <svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M8 7.2v4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
      </svg>
    </button>
  )
}

/** A whole line of its own: for a pane whose bar does not already say what is in it. */
export function PaneHead(props: { children: ComponentChildren }) {
  return <header class="pane-head">{props.children}</header>
}

export interface ContentsItem {
  key: string
  /** As it is said; or, where it carries mathematics, as it is drawn (already made safe). */
  label: string
  html?: string
  /** How far in: 0 for the outermost. */
  depth?: number
  /** A word at the end of the line: the page it is on. */
  note?: string
  /** Where the reader is now. */
  current?: boolean
}

export interface ContentsListProps {
  /** What these are: said to whoever cannot see them. */
  label: string
  items: ContentsItem[]
  onPick: (key: string) => void
  onDismiss: () => void
}

/**
 * The contents of what is in the pane, let down from its title: a press on
 * one goes there and puts the list away; a press anywhere else, or Escape,
 * only puts it away.
 */
export function ContentsList(props: ContentsListProps) {
  const dismiss = useRef(props.onDismiss)
  dismiss.current = props.onDismiss
  const list = useRef<HTMLUListElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss.current()
    }
    document.addEventListener('keydown', onKey)
    // Opened on where the reader is, in a long list.
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <div class="contents-backdrop" onClick={props.onDismiss} />
      <div class="contents-list" role="dialog" aria-label={props.label}>
        <ul ref={list}>
          {props.items.map((item) => (
            <li key={item.key} class={item.current ? 'on' : ''} style={{ '--depth': item.depth ?? 0 }}>
              <button
                type="button"
                aria-current={item.current ? 'true' : undefined}
                onClick={() => props.onPick(item.key)}
              >
                {item.html !== undefined ? (
                  // Escaped by whoever made it, with nothing but its mathematics drawn.
                  <span class="contents-label" dangerouslySetInnerHTML={{ __html: item.html }} />
                ) : (
                  <span class="contents-label">{item.label}</span>
                )}
                {item.note && <span class="muted">{item.note}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
