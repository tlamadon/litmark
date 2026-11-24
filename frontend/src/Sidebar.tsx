/**
 * Project sidebar: Documents and Notes, search, import, and a change log.
 *
 * Each document shows its title, a summary preview, and its ingestion status.
 * Extraction and summary state are reported separately, so a summary that
 * failed never makes a readable PDF look unavailable.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'

import {
  api,
  type ChangeRecord,
  type DocumentRecord,
  type NoteSummary,
  type SearchHit,
  type TagCount,
} from './api'
import { filterByTags, TagFilter, TagInput, UNTAGGED } from './Tags'

export interface SidebarProps {
  documents: DocumentRecord[]
  /** Every tag in use, with how many papers carry it. */
  tags: TagCount[]
  notes: NoteSummary[]
  changes: ChangeRecord[]
  activeTarget: { kind: string; noteId?: string; documentId?: string }
  onOpenNote: (noteId: string) => void
  onOpenSummary: (documentId: string) => void
  onOpenDocument: (documentId: string) => void
  onNewNote: () => void
  /** Import PDFs; `tags` are given to each, so they arrive in the collection on screen. */
  onImport: (files: File[], tags: string[]) => void
  onSetTags: (documentId: string, tags: string[]) => void
  onTagDocuments: (documentIds: string[], add: string[]) => void
  onSearchJump: (hit: SearchHit) => void
  onSummarize: (documentId: string) => Promise<void>
  onReextract: (documentId: string) => void
  onWriteBibliography: () => Promise<void>
  onUndo: (change: ChangeRecord) => void
  onLoadChanges: () => Promise<void>
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [noteHits, setNoteHits] = useState<{ note_id: string; title: string; snippet: string }[]>(
    [],
  )
  const [dragging, setDragging] = useState(false)
  const [searching, setSearching] = useState(false)
  // The tags the list is narrowed to; a paper must carry all of them.
  const [selected, setSelected] = useState<string[]>([])
  const [editingTags, setEditingTags] = useState<string | null>(null)
  const [taggingShown, setTaggingShown] = useState(false)

  const untagged = useMemo(
    () => props.documents.filter((document) => document.tags.length === 0).length,
    [props.documents],
  )
  const shown = useMemo(
    () => filterByTags(props.documents, selected),
    [props.documents, selected],
  )
  // A tag whose last paper lost it is no longer something to filter by.
  useEffect(() => {
    const live = new Set(props.tags.map(({ tag }) => tag.toLocaleLowerCase()))
    setSelected((current) => {
      const kept = current.filter(
        (tag) => (tag === UNTAGGED ? untagged > 0 : live.has(tag.toLocaleLowerCase())),
      )
      return kept.length === current.length ? current : kept
    })
  }, [props.tags, untagged])

  const toggleTag = (tag: string): void =>
    setSelected((current) =>
      current.some((own) => own.toLocaleLowerCase() === tag.toLocaleLowerCase())
        ? current.filter((own) => own.toLocaleLowerCase() !== tag.toLocaleLowerCase())
        : [...current, tag],
    )
  // What a paper imported now is tagged with: the collection on screen.
  const importTags = selected.filter((tag) => tag !== UNTAGGED)
  const importFiles = (files: File[]): void => props.onImport(files, importTags)

  const runSearch = async (value: string): Promise<void> => {
    setQuery(value)
    if (value.trim().length < 2) {
      setHits(null)
      setNoteHits([])
      return
    }
    setSearching(true)
    try {
      const result = await api.search(value)
      setHits(result.passages)
      setNoteHits(result.notes)
    } finally {
      setSearching(false)
    }
  }

  return (
    <nav
      class={dragging ? 'sidebar dropping' : 'sidebar'}
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
      <div class="sidebar-tools">
        <input
          type="search"
          placeholder="Search papers and notes"
          value={query}
          onInput={(event) => void runSearch((event.target as HTMLInputElement).value)}
          aria-label="Search"
        />
        <label class="import" title="Import one or more PDFs">
          Import
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

      {hits !== null && (
        <section class="results">
          <h3>
            Results {searching && <span class="muted">searching…</span>}
          </h3>
          {hits.length === 0 && noteHits.length === 0 && (
            <p class="muted">Nothing matched.</p>
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

      <section>
        <div class="section-head">
          <h3>Documents</h3>
          <span class="head-actions">
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
              title="Download a BibTeX file for these documents"
            >
              Download
            </a>
          </span>
        </div>
        {props.documents.length === 0 && (
          <p class="muted">
            No papers yet. Drag PDFs here, or use Import.
          </p>
        )}

        <TagFilter
          tags={props.tags}
          untagged={untagged}
          selected={selected}
          onToggle={toggleTag}
          onClear={() => setSelected([])}
        />
        {props.documents.length > 0 && (
          <div class="tag-bar">
            <span class="muted">
              {selected.length > 0
                ? `${shown.length} of ${props.documents.length} papers`
                : `${props.documents.length} paper${props.documents.length === 1 ? '' : 's'}`}
              {importTags.length > 0 && ` · imports are tagged ${importTags.join(', ')}`}
            </span>
            {shown.length > 0 && !taggingShown && (
              <button
                type="button"
                class="link"
                title="Give a tag to every paper listed below"
                onClick={() => setTaggingShown(true)}
              >
                Tag {shown.length === 1 ? 'it' : `these ${shown.length}`}…
              </button>
            )}
          </div>
        )}
        {taggingShown && (
          <TagInput
            known={props.tags}
            autoFocus
            label={`Tag the ${shown.length} papers listed`}
            placeholder="field:labor, jmp:2026…"
            onAdd={(tags) => {
              props.onTagDocuments(
                shown.map((document) => document.document_id),
                tags,
              )
              // Done in one go. Left open, the list it applies to can change
              // underneath it — tagging the untagged empties that very filter.
              setTaggingShown(false)
            }}
            onDone={() => setTaggingShown(false)}
          />
        )}

        <ul class="list">
          {shown.map((document) => (
            <li key={document.document_id}>
              <button
                type="button"
                class={
                  props.activeTarget.documentId === document.document_id
                    ? 'entry active'
                    : 'entry'
                }
                onClick={() => props.onOpenSummary(document.document_id)}
                title={document.original_filename}
              >
                <strong>{document.display_title}</strong>
                <SummaryPreview document={document} />
                <IngestionStatus document={document} />
              </button>
              {(document.tags.length > 0 || editingTags === document.document_id) && (
                <div class="entry-tags">
                  {document.tags.map((tag) =>
                    editingTags === document.document_id ? (
                      <span key={tag} class="tag">
                        {tag}
                        <button
                          type="button"
                          aria-label={`Remove the tag ${tag}`}
                          onClick={() =>
                            props.onSetTags(
                              document.document_id,
                              document.tags.filter((own) => own !== tag),
                            )
                          }
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <button
                        key={tag}
                        type="button"
                        class={
                          selected.some((own) => own.toLocaleLowerCase() === tag.toLocaleLowerCase())
                            ? 'tag on'
                            : 'tag'
                        }
                        title={`Show only papers tagged ${tag}`}
                        onClick={() => toggleTag(tag)}
                      >
                        {tag}
                      </button>
                    ),
                  )}
                </div>
              )}
              {editingTags === document.document_id && (
                <TagInput
                  known={props.tags}
                  autoFocus
                  label={`Add a tag to ${document.display_title}`}
                  placeholder="Add a tag…"
                  onAdd={(tags) => props.onSetTags(document.document_id, [...document.tags, ...tags])}
                  onDone={() => setEditingTags(null)}
                />
              )}
              <div class="entry-actions">
                <button
                  type="button"
                  class="link"
                  onClick={() => props.onOpenDocument(document.document_id)}
                >
                  Read PDF
                </button>
                {editingTags !== document.document_id && (
                  <button
                    type="button"
                    class="link"
                    onClick={() => setEditingTags(document.document_id)}
                  >
                    {document.tags.length > 0 ? 'Edit tags' : 'Tag'}
                  </button>
                )}
                {document.extraction.status === 'failed' && (
                  <button
                    type="button"
                    class="link"
                    onClick={() => props.onReextract(document.document_id)}
                  >
                    Retry extraction
                  </button>
                )}
                {document.extraction.status === 'ok' &&
                  document.summary.status !== 'unavailable' && (
                    <button
                      type="button"
                      class="link"
                      onClick={() => void props.onSummarize(document.document_id)}
                    >
                      {document.summary.status === 'ready' ? 'Regenerate' : 'Summarize'}
                    </button>
                  )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div class="section-head">
          <h3>Notes</h3>
          <button type="button" class="link" onClick={props.onNewNote}>
            New
          </button>
        </div>
        <ul class="list">
          {props.notes.map((note) => (
            <li key={note.note_id}>
              <button
                type="button"
                class={props.activeTarget.noteId === note.note_id ? 'entry active' : 'entry'}
                onClick={() => props.onOpenNote(note.note_id)}
              >
                <strong>{note.title}</strong>
                <span class="muted">{note.note_id}.md</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <details class="changes" onToggle={() => void props.onLoadChanges()}>
        <summary>Recent edits</summary>
        {props.changes.length === 0 && <p class="muted">No edits recorded yet.</p>}
        <ul>
          {props.changes.map((change) => (
            <li key={change.change_id}>
              <span>
                <strong>{change.origin}</strong> · {change.target_id}
                <br />
                <span class="muted">{change.summary}</span>
              </span>
              {change.undoable ? (
                <button type="button" class="link" onClick={() => props.onUndo(change)}>
                  Undo
                </button>
              ) : (
                <span class="muted">{change.undone_at ? 'undone' : '—'}</span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </nav>
  )
}

function SummaryPreview({ document }: { document: DocumentRecord }) {
  const text = (document.summary_text ?? '')
    .replace(/^#.*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return <span class="preview">{text.slice(0, 120)}…</span>
}

function IngestionStatus({ document }: { document: DocumentRecord }) {
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
  else if (summary.status === 'ready') parts.push({ label: 'summary ready', tone: 'ok' })
  else if (summary.status === 'failed') parts.push({ label: 'summary failed', tone: 'error' })
  else if (summary.status === 'unavailable')
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
