/**
 * The library: every paper and every note, as a grid to look over.
 *
 * A project grows to a hundred papers and more, which a column of cards down
 * the side of the window cannot show. Here they have the width of the page:
 * filtered by what is typed and by tag, in an order of the reader's choosing,
 * each one click from being open. Whatever is open keeps its place underneath,
 * so looking something up here is not leaving what was being read.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { api, type DocumentRecord, type NoteSummary, type SearchHit, type TagCount } from './api'
import { ago } from './chat/ConversationMenu'
import { nameOf } from './papers'
import { filterByTags, TagInput, UNTAGGED } from './Tags'

export interface LibraryProps {
  documents: DocumentRecord[]
  notes: NoteSummary[]
  /** Every tag in use, offered when tagging what is listed. */
  tags: TagCount[]
  /** The tags the papers are narrowed to; a paper must carry all of them. */
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClearTags: () => void
  onOpenPaper: (documentId: string) => void
  onOpenNote: (noteId: string) => void
  onNewNote: () => void
  onDeleteNote: (noteId: string) => Promise<void>
  /** Import PDFs; `tags` are given to each, so they arrive in the collection on screen. */
  onImport: (files: File[], tags: string[]) => void
  onTagDocuments: (documentIds: string[], add: string[]) => void
  onSearchJump: (hit: SearchHit) => void
  onWriteBibliography: () => Promise<void>
}

type Order = 'added' | 'author' | 'year' | 'title'

const ORDERS: { value: Order; label: string }[] = [
  { value: 'added', label: 'Recently added' },
  { value: 'author', label: 'Author' },
  { value: 'year', label: 'Year' },
  { value: 'title', label: 'Title' },
]
const ORDER_KEY = 'litmark:library-order'

function storedOrder(): Order {
  try {
    const stored = window.localStorage.getItem(ORDER_KEY)
    if (ORDERS.some((order) => order.value === stored)) return stored as Order
  } catch {
    /* storage can be refused; the default stands */
  }
  return 'added'
}

const byText = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

function inOrder(documents: DocumentRecord[], order: Order): DocumentRecord[] {
  const sorted = [...documents]
  if (order === 'added') {
    sorted.sort((a, b) => b.imported_at.localeCompare(a.imported_at))
  } else if (order === 'year') {
    // Newest first; a paper whose year nobody knows goes last.
    sorted.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || byText(nameOf(a)!, nameOf(b)!))
  } else if (order === 'title') {
    sorted.sort((a, b) => byText(a.display_title, b.display_title))
  } else {
    sorted.sort((a, b) => byText(nameOf(a)!, nameOf(b)!) || (a.year ?? 0) - (b.year ?? 0))
  }
  return sorted
}

/** Every word typed must occur somewhere in what the paper is known by. */
function matches(words: string[], ...known: (string | number | null | undefined)[]): boolean {
  if (words.length === 0) return true
  const haystack = known.filter(Boolean).join(' ').toLocaleLowerCase()
  return words.every((word) => haystack.includes(word))
}

export function Library(props: LibraryProps) {
  const [query, setQuery] = useState('')
  // Papers or notes; a search looks through both, and shows both.
  const [showing, setShowing] = useState<'papers' | 'notes'>('papers')
  const [order, setOrder] = useState<Order>(storedOrder)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [noteHits, setNoteHits] = useState<{ note_id: string; title: string; snippet: string }[]>(
    [],
  )
  const [searching, setSearching] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [taggingShown, setTaggingShown] = useState(false)
  // The note asked to be deleted, until that is confirmed or called off.
  const [deleting, setDeleting] = useState<string | null>(null)

  const words = useMemo(
    () => query.toLocaleLowerCase().split(/\s+/).filter(Boolean),
    [query],
  )
  const papers = useMemo(() => {
    const tagged = filterByTags(props.documents, props.selectedTags)
    const found = tagged.filter((document) =>
      matches(
        words,
        document.label,
        document.display_title,
        document.authors,
        document.year,
        document.original_filename,
        ...document.tags,
      ),
    )
    return inOrder(found, order)
  }, [props.documents, props.selectedTags, words, order])
  const notes = useMemo(
    () => props.notes.filter((note) => matches(words, note.title, note.note_id)),
    [props.notes, words],
  )

  // What is typed narrows the cards at once; the text of the papers and the
  // notes is searched a moment later, once the typing has paused.
  const asked = useRef(0)
  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) {
      setHits([])
      setNoteHits([])
      setSearching(false)
      return
    }
    const mine = ++asked.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      api.search(text).then(
        (result) => {
          if (asked.current !== mine) return
          setHits(result.passages)
          setNoteHits(result.notes)
          setSearching(false)
        },
        () => {
          if (asked.current === mine) setSearching(false)
        },
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const chooseOrder = (next: Order): void => {
    setOrder(next)
    try {
      window.localStorage.setItem(ORDER_KEY, next)
    } catch {
      /* not remembered, then */
    }
  }

  // What a paper imported now is tagged with: the collection on screen.
  const importTags = props.selectedTags.filter((tag) => tag !== UNTAGGED)
  const importFiles = (files: File[]): void => props.onImport(files, importTags)
  const narrowed = props.selectedTags.length > 0 || words.length > 0
  const searchingAll = words.length > 0
  const showPapers = searchingAll || showing === 'papers'
  const showNotes = searchingAll || showing === 'notes'
  const on = (tag: string): boolean =>
    props.selectedTags.some((own) => own.toLocaleLowerCase() === tag.toLocaleLowerCase())

  return (
    <main
      class={dragging ? 'library dropping' : 'library'}
      aria-label="Library"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const files = Array.from(event.dataTransfer?.files ?? [])
        if (files.length > 0) importFiles(files)
      }}
    >
      <div class="library-tools">
        <input
          type="search"
          placeholder="Find a paper or a note — by author, title, tag, or what it says"
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          aria-label="Search"
        />
        <div class="mode-tabs" role="group" aria-label="Papers or notes">
          {(['papers', 'notes'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              class={showing === kind && !searchingAll ? 'on' : ''}
              aria-pressed={showing === kind && !searchingAll}
              data-show={kind}
              onClick={() => {
                setShowing(kind)
                setQuery('')
              }}
            >
              {kind === 'papers' ? 'Papers' : 'Notes'}{' '}
              <span class="count">
                {kind === 'papers' ? props.documents.length : props.notes.length}
              </span>
            </button>
          ))}
        </div>
        <label class="import" title="Import one or more PDFs (or drop them anywhere here)">
          Import PDFs
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(event) => {
              const input = event.target as HTMLInputElement
              const files = Array.from(input.files ?? [])
              if (files.length > 0) importFiles(files)
              input.value = ''
            }}
          />
        </label>
      </div>

      {showPapers && (
      <section>
        <div class="library-head">
          <h3>Papers</h3>
          <span class="muted">
            {narrowed
              ? `${papers.length} of ${props.documents.length}`
              : `${props.documents.length}`}
            {importTags.length > 0 && ` · imports are tagged ${importTags.join(', ')}`}
          </span>
          {props.selectedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              class="tag on"
              title={`Stop filtering by ${tag}`}
              onClick={() => props.onToggleTag(tag)}
            >
              {tag} ×
            </button>
          ))}
          <span class="spacer" />
          {papers.length > 0 && !taggingShown && (
            <button
              type="button"
              class="link"
              title="Give a tag to every paper shown below"
              onClick={() => setTaggingShown(true)}
            >
              Tag {papers.length === 1 ? 'it' : `these ${papers.length}`}…
            </button>
          )}
          <button
            type="button"
            class="link"
            onClick={() => void props.onWriteBibliography()}
            title="Write references.bib into the project directory"
          >
            Write .bib
          </button>
          <a
            class="link"
            href={api.bibliographyUrl()}
            download="references.bib"
            title="Download a BibTeX file for these papers"
          >
            Download .bib
          </a>
          <label class="order">
            <span class="muted">Order</span>
            <select
              value={order}
              aria-label="Order of the papers"
              onChange={(event) => chooseOrder((event.target as HTMLSelectElement).value as Order)}
            >
              {ORDERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {taggingShown && (
          <TagInput
            known={props.tags}
            autoFocus
            label={`Tag the ${papers.length} papers shown`}
            placeholder="field:labor, jmp:2026…"
            onAdd={(tags) => {
              props.onTagDocuments(
                papers.map((document) => document.document_id),
                tags,
              )
              // Done in one go. Left open, the list it applies to can change
              // underneath it — tagging the untagged empties that very filter.
              setTaggingShown(false)
            }}
            onDone={() => setTaggingShown(false)}
          />
        )}

        {props.documents.length === 0 ? (
          <p class="library-empty">No papers yet. Drop PDFs here, or use Import PDFs.</p>
        ) : papers.length === 0 ? (
          <p class="library-empty">
            No paper matches.{' '}
            {props.selectedTags.length > 0 && (
              <button type="button" class="link" onClick={props.onClearTags}>
                Show all tags
              </button>
            )}
          </p>
        ) : (
          <ul class="grid">
            {papers.map((document) => (
              <li key={document.document_id} class="card paper" data-document={document.document_id}>
                <button
                  type="button"
                  class="card-open"
                  title={document.original_filename}
                  onClick={() => props.onOpenPaper(document.document_id)}
                >
                  {/* By its authors and year where they are known, as it is cited. */}
                  <strong>{nameOf(document)}</strong>
                  {document.label && <span class="card-title">{document.display_title}</span>}
                  <IngestionStatus document={document} quiet />
                </button>
                {document.tags.length > 0 && (
                  <div class="card-tags">
                    {document.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        class={on(tag) ? 'tag on' : 'tag'}
                        title={on(tag) ? `Stop filtering by ${tag}` : `Show only papers tagged ${tag}`}
                        onClick={() => props.onToggleTag(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {showNotes && (
      <section>
        <div class="library-head">
          <h3>Notes</h3>
          <span class="muted">
            {words.length > 0 ? `${notes.length} of ${props.notes.length}` : `${props.notes.length}`}
          </span>
          <span class="spacer" />
          <button type="button" class="link" data-action="new-note" onClick={props.onNewNote}>
            New note
          </button>
        </div>
        {notes.length === 0 ? (
          <p class="library-empty">
            {props.notes.length === 0 ? 'No notes yet.' : 'No note matches.'}
          </p>
        ) : (
          <ul class="grid">
            {notes.map((note) => (
              <li key={note.note_id} class="card note" data-note={note.note_id}>
                <button
                  type="button"
                  class="card-open"
                  onClick={() => props.onOpenNote(note.note_id)}
                >
                  <strong>{note.title}</strong>
                  <span class="muted">
                    {[`${note.note_id}.md`, ago(note.modified_at)].filter(Boolean).join(' · ')}
                  </span>
                </button>
                {deleting === note.note_id ? (
                  <div class="conv-confirm card-confirm">
                    <span>Delete this note? It can be brought back from Recent edits.</span>
                    <button
                      type="button"
                      class="danger"
                      data-action="confirm-delete-note"
                      onClick={() => {
                        setDeleting(null)
                        void props.onDeleteNote(note.note_id)
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setDeleting(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    class="card-remove"
                    data-action="delete-note"
                    title="Delete this note"
                    aria-label={`Delete the note ${note.title}`}
                    onClick={() => setDeleting(note.note_id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {query.trim().length >= 2 && (
        <section class="results">
          <div class="library-head">
            <h3>In the text</h3>
            <span class="muted">
              {searching ? 'searching…' : `${hits.length + noteHits.length} found`}
            </span>
          </div>
          {!searching && hits.length === 0 && noteHits.length === 0 && (
            <p class="library-empty">Nothing in the papers or the notes says that.</p>
          )}
          {noteHits.map((hit) => (
            <button
              key={hit.note_id}
              type="button"
              class="result"
              onClick={() => props.onOpenNote(hit.note_id)}
            >
              <strong>{hit.title}</strong>
              <span class="muted">{hit.snippet}</span>
            </button>
          ))}
          {hits.map((hit, index) => (
            <button
              key={`${hit.document_id}-${hit.page_number}-${index}`}
              type="button"
              class="result"
              onClick={() => props.onSearchJump(hit)}
            >
              <strong>
                {hit.document_title} · p. {hit.page_label ?? hit.page_number}
              </strong>
              <span class="muted">{hit.snippet}</span>
            </button>
          ))}
        </section>
      )}
    </main>
  )
}

/**
 * Where a paper stands: its text, and its summary, reported apart — a summary
 * that failed must not make a readable PDF look unavailable.
 *
 * `quiet` leaves out what needs no attention, for a grid of a hundred papers
 * where "summary ready" on every card would say nothing.
 */
export function IngestionStatus({
  document,
  quiet = false,
}: {
  document: DocumentRecord
  quiet?: boolean
}) {
  const extraction = document.extraction
  const summary = document.summary
  const parts: { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' }[] = []

  if (extraction.status === 'pending') parts.push({ label: 'queued for text extraction', tone: 'muted' })
  else if (extraction.status === 'running') parts.push({ label: 'extracting text…', tone: 'muted' })
  else if (extraction.status === 'failed')
    parts.push({
      label: extraction.kind === 'encrypted' ? 'encrypted — readable only' : 'extraction failed',
      tone: 'error',
    })
  else if (extraction.quality === 'none')
    parts.push({ label: 'no text layer (scan) — readable only', tone: 'warn' })
  else if (extraction.quality === 'partial')
    parts.push({ label: 'partly extracted', tone: 'warn' })

  if (summary.status === 'queued') parts.push({ label: 'summary queued', tone: 'muted' })
  else if (summary.status === 'ready' && !quiet) parts.push({ label: 'summary ready', tone: 'ok' })
  else if (summary.status === 'failed') parts.push({ label: 'summary failed', tone: 'error' })
  else if (summary.status === 'unavailable' && !quiet)
    parts.push({ label: 'no summary possible', tone: 'muted' })

  if (parts.length === 0) return null
  return (
    <span class="status-row">
      {parts.map((part) => (
        <span key={part.label} class={`status ${part.tone}`}>
          {part.label}
        </span>
      ))}
    </span>
  )
}
