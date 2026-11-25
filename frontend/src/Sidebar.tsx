/**
 * The panel on the left: what goes with whatever is on screen.
 *
 * The papers and notes themselves are in the library, which has the room for
 * them. This panel is about the one thing open: its table of contents, what
 * it is called and tagged, and what it is tied to — the papers a note cites,
 * the notes that cite a paper, the papers that mention each other. Over the
 * library, it holds the tags to narrow the papers by.
 */

import { useState } from 'preact/hooks'

import type {
  ChangeRecord,
  DocumentRecord,
  NoteSummary,
  RelatedToNote,
  RelatedToPaper,
  TagCount,
} from './api'
import { ago } from './chat/ConversationMenu'
import { describeOrigin } from './chat/describe'
import { IngestionStatus } from './Library'
import type { Heading } from './outline'
import { nameOf } from './papers'
import type { PdfOutlineItem } from './pdf/PdfViewer'
import { TagFilter, TagInput } from './Tags'

/** What the panel is about: the note or the paper in the main area. */
export type Subject =
  | { kind: 'note'; noteId: string }
  | { kind: 'paper'; documentId: string }
  /** The summarizing skill: how the reader wants papers summarized. */
  | { kind: 'skill' }
  | null

export interface SidebarProps {
  /** Over the library the panel filters it; otherwise it is about `subject`. */
  library: boolean
  documents: DocumentRecord[]
  notes: NoteSummary[]
  /** Every tag in use, with how many papers carry it. */
  tags: TagCount[]
  changes: ChangeRecord[]

  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClearTags: () => void

  subject: Subject
  /** The headings of the text that is open. */
  headings: Heading[]
  onGotoHeading: (index: number) => void
  /** The paper whose PDF is on show, and its own table of contents if it has one. */
  openDocumentId: string | null
  outline: PdfOutlineItem[]
  onGotoPage: (page: number) => void
  related: RelatedToNote | RelatedToPaper | null

  /** Fold the panel away, to a strip at the edge that brings it back. */
  onCollapse: () => void
  onOpenNote: (noteId: string) => void
  /** Open a paper: its summary, with the PDF beside it. */
  onOpenPaper: (documentId: string) => void
  onOpenSummary: (documentId: string) => void
  onOpenDocument: (documentId: string) => void
  /** Open the summarizing skill, to read what was learned or change it by hand. */
  onOpenSkill: () => void
  /** Delete a note. What it held is kept, and listed under Recent edits to undo. */
  onDeleteNote: (noteId: string) => Promise<void>
  /** Say what a paper is: its title, authors and year. Rejects with the reason. */
  onSetDetails: (
    documentId: string,
    details: { title?: string; authors?: string; year?: number },
  ) => Promise<void>
  onSetTags: (documentId: string, tags: string[]) => void
  onSummarize: (documentId: string) => Promise<void>
  onReextract: (documentId: string) => void
  onUndo: (change: ChangeRecord) => void
  onLoadChanges: () => Promise<void>
}

export function Sidebar(props: SidebarProps) {
  const untagged = props.documents.filter((document) => document.tags.length === 0).length
  const subject = props.subject
  const paper =
    subject?.kind === 'paper'
      ? props.documents.find((document) => document.document_id === subject.documentId)
      : undefined
  const note =
    subject?.kind === 'note' ? props.notes.find((item) => item.note_id === subject.noteId) : undefined
  const onShow = props.openDocumentId
    ? props.documents.find((document) => document.document_id === props.openDocumentId)
    : undefined

  return (
    <nav class="sidebar" aria-label={props.library ? 'Filters' : 'About what is open'}>
      <header class="panel-head">
        <h3>{props.library ? 'Tags' : 'About'}</h3>
        <button
          type="button"
          class="ghost icon"
          data-action="hide-sidebar"
          title="Hide this panel"
          aria-label="Hide this panel"
          onClick={props.onCollapse}
        >
          «
        </button>
      </header>
      {props.library ? (
        <section>
          {props.tags.length === 0 && untagged === 0 ? (
            <p class="muted">
              No tags yet. A tag gathers papers: a field, a year, a shortlist.
            </p>
          ) : (
            <TagFilter
              tags={props.tags}
              untagged={untagged}
              selected={props.selectedTags}
              onToggle={props.onToggleTag}
              onClear={props.onClearTags}
            />
          )}
        </section>
      ) : (
        <>
          {subject?.kind === 'skill' && (
            <section class="about">
              <strong>How papers are summarized</strong>
              <p class="about-text">
                The agent follows this every time it writes a summary. Tell it in the chat how
                you want them — shorter, what to lead with, what to leave out — and it writes
                that down here. Or change it yourself.
              </p>
              <p class="about-text muted">
                A paper already summarized keeps its summary until you Regenerate it.
              </p>
            </section>
          )}
          {note && <NoteAbout key={note.note_id} note={note} onDelete={props.onDeleteNote} />}
          {paper && <PaperAbout key={paper.document_id} document={paper} {...props} />}

          {props.headings.length > 0 && (
            <section>
              <h3>Contents</h3>
              <ul class="toc">
                {props.headings.map((heading, index) => (
                  <li key={`${heading.line}-${heading.text}`} style={{ '--depth': heading.level - 1 }}>
                    <button type="button" onClick={() => props.onGotoHeading(index)}>
                      {heading.text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {onShow && props.outline.length > 0 && (
            <section>
              <h3 title={onShow.display_title}>In the paper</h3>
              <ul class="toc">
                {props.outline.map((item, index) => (
                  <li key={`${index}-${item.page}`} style={{ '--depth': item.level - 1 }}>
                    <button type="button" onClick={() => props.onGotoPage(item.page)}>
                      <span>{item.title}</span>
                      <span class="muted">{item.page}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Related {...props} />
        </>
      )}

      <RecentEdits {...props} />
    </nav>
  )
}

/** The note that is open: what it is, and the way to be rid of it. */
function NoteAbout(props: { note: NoteSummary; onDelete: (noteId: string) => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  return (
    <section class="about">
      <strong>{props.note.title}</strong>
      <span class="muted">
        {[`${props.note.note_id}.md`, ago(props.note.modified_at)].filter(Boolean).join(' · ')}
      </span>
      {deleting ? (
        <div class="conv-confirm entry-confirm">
          <span>Delete this note? It can be brought back from Recent edits.</span>
          <button
            type="button"
            class="danger"
            data-action="confirm-delete-note"
            onClick={() => {
              setDeleting(false)
              void props.onDelete(props.note.note_id)
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setDeleting(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div class="entry-actions">
          <button
            type="button"
            class="link"
            data-action="delete-note"
            onClick={() => setDeleting(true)}
          >
            Delete
          </button>
        </div>
      )}
    </section>
  )
}

/** The paper that is open: what it is called, its tags, and what can be done to it. */
function PaperAbout(props: SidebarProps & { document: DocumentRecord }) {
  const { document } = props
  const [editingDetails, setEditingDetails] = useState(false)
  const [tagging, setTagging] = useState(false)
  return (
    <section class="about">
      {/* By its authors and year where they are known, as it is cited. */}
      <strong>{nameOf(document)}</strong>
      {document.label && <span class="paper-title">{document.display_title}</span>}
      <span class="muted" title={document.original_filename}>
        {[document.page_count ? `${document.page_count} pages` : '', document.original_filename]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <IngestionStatus document={document} />

      {(document.tags.length > 0 || tagging) && (
        <div class="entry-tags">
          {document.tags.map((tag) =>
            tagging ? (
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
              <span key={tag} class="tag">
                {tag}
              </span>
            ),
          )}
        </div>
      )}
      {tagging && (
        <TagInput
          known={props.tags}
          autoFocus
          label={`Add a tag to ${document.display_title}`}
          placeholder="Add a tag…"
          onAdd={(tags) => props.onSetTags(document.document_id, [...document.tags, ...tags])}
          onDone={() => setTagging(false)}
        />
      )}
      {editingDetails && (
        <DetailsForm
          document={document}
          onSave={(details) => props.onSetDetails(document.document_id, details)}
          onDone={() => setEditingDetails(false)}
        />
      )}

      <div class="entry-actions">
        {props.openDocumentId !== document.document_id && (
          <button
            type="button"
            class="link"
            onClick={() => props.onOpenDocument(document.document_id)}
          >
            Read PDF
          </button>
        )}
        {!editingDetails && (
          <button
            type="button"
            class="link"
            title="Set the title, authors and year this paper goes by"
            onClick={() => setEditingDetails(true)}
          >
            Details
          </button>
        )}
        {!tagging && (
          <button type="button" class="link" onClick={() => setTagging(true)}>
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
        {document.extraction.status === 'ok' && document.summary.status !== 'unavailable' && (
          <button
            type="button"
            class="link"
            onClick={() => void props.onSummarize(document.document_id)}
          >
            {document.summary.status === 'ready' ? 'Regenerate' : 'Summarize'}
          </button>
        )}
        <button
          type="button"
          class="link"
          data-action="open-skill"
          title="How papers are summarized: what the agent has learned of how you want it done"
          onClick={props.onOpenSkill}
        >
          Summarizing skill
        </button>
      </div>
    </section>
  )
}

/** What the thing on screen is tied to, each a click away. */
function Related(props: SidebarProps) {
  const related = props.related
  if (!related || !props.subject) return null
  const byId = new Map(props.documents.map((document) => [document.document_id, document]))

  const papers = (
    title: string,
    hint: string,
    items: { document_id: string; count?: number; tags?: string[] }[],
  ) => {
    const known = items.filter((item) => byId.has(item.document_id))
    if (known.length === 0) return null
    return (
      <section>
        <h3 title={hint}>{title}</h3>
        <ul class="related">
          {known.map((item) => {
            const document = byId.get(item.document_id)!
            return (
              <li key={item.document_id}>
                <button
                  type="button"
                  title={document.display_title}
                  onClick={() => props.onOpenPaper(item.document_id)}
                >
                  <span>{nameOf(document)}</span>
                  <span class="muted">
                    {item.tags ? item.tags.join(', ') : item.count && item.count > 1 ? `×${item.count}` : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  if ('papers' in related) {
    return papers('Papers in this note', 'The papers this note cites or names', related.papers)
  }
  return (
    <>
      {related.notes.length > 0 && (
        <section>
          <h3 title="The notes that cite or name this paper">Notes about it</h3>
          <ul class="related">
            {related.notes.map((item) => (
              <li key={item.note_id}>
                <button type="button" onClick={() => props.onOpenNote(item.note_id)}>
                  <span>{item.title}</span>
                  <span class="muted">{item.count > 1 ? `×${item.count}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {papers('Papers it mentions', 'Named in this paper’s summary', related.mentions)}
      {papers('Mentioned by', 'Papers whose summaries name this one', related.mentioned_by)}
      {papers('Same tags', 'Papers carrying some of the same tags', related.same_tags)}
    </>
  )
}

function RecentEdits(props: SidebarProps) {
  return (
    <details class="changes" onToggle={() => void props.onLoadChanges()}>
      <summary>Recent edits</summary>
      {props.changes.length === 0 && <p class="muted">No edits recorded yet.</p>}
      <ul>
        {props.changes.map((change) => {
          const origin = describeOrigin(change.origin)
          const isNote = change.target_kind === 'note'
          const isSkill = change.target_kind === 'skill'
          const note = isNote
            ? props.notes.find((item) => item.note_id === change.target_id)
            : undefined
          const name = isSkill
            ? 'how papers are summarized'
            : isNote
            ? (note?.title ?? change.target_id)
            : (nameOf(
                props.documents.find((document) => document.document_id === change.target_id),
              ) ?? change.target_id)
          // A note that was deleted is named, and there is nothing to open.
          const gone = isNote && !note
          const open = (): void => {
            if (isSkill) props.onOpenSkill()
            else if (isNote) props.onOpenNote(change.target_id)
            else if (change.target_kind === 'summary') props.onOpenSummary(change.target_id)
            else props.onOpenDocument(change.target_id)
          }
          return (
            <li key={change.change_id}>
              <span>
                <strong class={origin.outside ? 'origin outside' : 'origin'} title={origin.title}>
                  {origin.label}
                </strong>{' '}
                ·{' '}
                {gone ? (
                  <span>{name}</span>
                ) : (
                  <button type="button" class="link" onClick={open}>
                    {change.target_kind === 'summary' ? `summary of ${name}` : name}
                  </button>
                )}
                <br />
                <span class="muted">
                  {[change.summary, ago(change.created_at)].filter(Boolean).join(' · ')}
                </span>
              </span>
              {change.undoable ? (
                <button type="button" class="link" onClick={() => props.onUndo(change)}>
                  Undo
                </button>
              ) : (
                <span class="muted">{change.undone_at ? 'undone' : ''}</span>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

/** The title, authors and year a paper goes by, for when the PDF got them wrong. */
function DetailsForm(props: {
  document: DocumentRecord
  onSave: (details: { title?: string; authors?: string; year?: number }) => Promise<void>
  onDone: () => void
}) {
  const { document } = props
  const [title, setTitle] = useState(document.title ?? '')
  const [authors, setAuthors] = useState(document.authors ?? '')
  const [year, setYear] = useState(document.year ? String(document.year) : '')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (event: Event): Promise<void> => {
    event.preventDefault()
    const details: { title?: string; authors?: string; year?: number } = {}
    // Only what was filled in is said; an empty field leaves what is recorded.
    if (title.trim()) details.title = title.trim()
    if (authors.trim()) details.authors = authors.trim()
    if (year.trim()) details.year = Number(year)
    if (Object.keys(details).length === 0) {
      props.onDone()
      return
    }
    setBusy(true)
    try {
      await props.onSave(details)
      props.onDone()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="details-form" onSubmit={(event) => void save(event)}>
      <label>
        Authors
        <input
          type="text"
          value={authors}
          placeholder="G. Steven Olley and Ariel Pakes"
          autoFocus
          onInput={(event) => setAuthors((event.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Year
        <input
          type="text"
          inputMode="numeric"
          value={year}
          placeholder="1996"
          onInput={(event) => setYear((event.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Title
        <input
          type="text"
          value={title}
          placeholder={document.display_title}
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />
      </label>
      {problem && <p class="conv-problem">{problem}</p>}
      <div class="details-actions">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" class="link" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

