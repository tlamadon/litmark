/**
 * Tags on papers: the user's own labels for gathering them.
 *
 * A tag is free text. One with a colon is read as `group:value` —
 * `field:labor`, `jmp:2026`, `author:Card` — and the filter gathers such tags
 * under their group, which is all the structure there is: no schema to set up
 * before the first paper can be put in a pile.
 */

import { useState } from 'preact/hooks'

import type { DocumentRecord, TagCount } from './api'

/** How papers with no tags at all are listed. Not a tag: it cannot be given. */
export const UNTAGGED = 'untagged'

const fold = (tag: string): string => tag.toLocaleLowerCase()

export const hasTag = (document: DocumentRecord, tag: string): boolean =>
  document.tags.some((own) => fold(own) === fold(tag))

/** The papers carrying every selected tag (or, for `untagged`, none at all). */
export function filterByTags(documents: DocumentRecord[], selected: string[]): DocumentRecord[] {
  if (selected.length === 0) return documents
  return documents.filter((document) =>
    selected.every((tag) =>
      tag === UNTAGGED ? document.tags.length === 0 : hasTag(document, tag),
    ),
  )
}

/** What was typed, as tags: separated by commas, trimmed, empties dropped. */
export function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.replace(/\s+/g, ' ').trim().replace(/^#/, ''))
    .filter(Boolean)
}

interface Group {
  name: string
  tags: { tag: string; label: string; count: number }[]
}

/** Plain tags first, then each `group:` with its values. */
export function groupTags(tags: TagCount[]): Group[] {
  const groups = new Map<string, Group>()
  for (const { tag, count } of tags) {
    const colon = tag.indexOf(':')
    const name = colon > 0 ? tag.slice(0, colon) : ''
    const label = colon > 0 ? tag.slice(colon + 1) : tag
    let group = groups.get(fold(name))
    if (!group) {
      group = { name, tags: [] }
      groups.set(fold(name), group)
    }
    group.tags.push({ tag, label, count })
  }
  return Array.from(groups.values())
}

export interface TagFilterProps {
  tags: TagCount[]
  untagged: number
  selected: string[]
  onToggle: (tag: string) => void
  onClear: () => void
}

/** Every tag in use, as chips that narrow the list to the papers carrying them. */
export function TagFilter(props: TagFilterProps) {
  if (props.tags.length === 0) return null
  const on = (tag: string): boolean => props.selected.some((own) => fold(own) === fold(tag))
  const chip = (tag: string, label: string, count: number) => (
    <button
      key={tag}
      type="button"
      class={on(tag) ? 'tag on' : 'tag'}
      aria-pressed={on(tag)}
      title={on(tag) ? `Stop filtering by ${tag}` : `Show only papers tagged ${tag}`}
      onClick={() => props.onToggle(tag)}
    >
      {label}
      <span class="count">{count}</span>
    </button>
  )
  return (
    <div class="tag-filter" role="group" aria-label="Filter papers by tag">
      {groupTags(props.tags).map((group) => (
        <div key={group.name} class="tag-group">
          {group.name && <span class="tag-group-name">{group.name}</span>}
          {group.tags.map((item) => chip(item.tag, item.label, item.count))}
        </div>
      ))}
      <div class="tag-group">
        {props.untagged > 0 && chip(UNTAGGED, 'untagged', props.untagged)}
        {props.selected.length > 0 && (
          <button type="button" class="link" onClick={props.onClear}>
            Show all
          </button>
        )}
      </div>
    </div>
  )
}

export interface TagInputProps {
  /** Tags already in the project, offered as completions. */
  known: TagCount[]
  placeholder: string
  label: string
  autoFocus?: boolean
  onAdd: (tags: string[]) => void
  onDone?: () => void
}

/** Type a tag, or several separated by commas, and press Enter. */
export function TagInput(props: TagInputProps) {
  const [text, setText] = useState('')
  const [listId] = useState(() => `tags-${Math.random().toString(36).slice(2, 8)}`)
  const commit = (): void => {
    const tags = parseTags(text)
    if (tags.length > 0) props.onAdd(tags)
    setText('')
  }
  return (
    <form
      class="tag-input"
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <input
        value={text}
        list={listId}
        placeholder={props.placeholder}
        aria-label={props.label}
        maxLength={200}
        ref={(node) => {
          if (node && props.autoFocus && !node.dataset.focused) {
            node.dataset.focused = '1'
            node.focus()
          }
        }}
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            props.onDone?.()
          }
        }}
      />
      <datalist id={listId}>
        {props.known.map(({ tag }) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <button type="submit" disabled={parseTags(text).length === 0}>
        Add
      </button>
      {props.onDone && (
        <button type="button" class="link" onClick={props.onDone}>
          Done
        </button>
      )}
    </form>
  )
}
