/**
 * The application shell: project sidebar, main editor, source panel, chat drawer.
 *
 * Each of the three side regions can collapse, and the chat drawer is capped so
 * it cannot squeeze the editor and the PDF into unreadable columns. On a narrow
 * window the source panel takes over the main view, with an explicit way back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'

import {
  ApiError,
  api,
  type ChangeRecord,
  type ConversationSummary,
  type DocumentRecord,
  type MessageContext,
  type NoteSummary,
  type ProjectState,
  type ReferenceRecord,
  type SearchHit,
  type SyncState,
} from './api'
import { Chat } from './chat/Chat'
import type { OpenTarget } from './chat/describe'
import { MarkdownEditor, type RevealResult } from './editor/MarkdownEditor'
import { nameOf, papersOf } from './papers'
import { EventStream, type ServerEvent } from './events'
import { PdfViewer, type PdfMark, type PdfSelection } from './pdf/PdfViewer'
import { Sidebar } from './Sidebar'
import { SyncStatus } from './SyncStatus'

type MainTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'summary'; documentId: string }
  | { kind: 'empty' }

interface Buffer {
  /** Which note or summary this text is: the target it was read for. */
  key: string
  text: string
  revision: string | null
}

const keyOf = (target: MainTarget): string =>
  target.kind === 'note'
    ? `note:${target.noteId}`
    : target.kind === 'summary'
      ? `summary:${target.documentId}`
      : 'empty'

const NARROW_QUERY = '(max-width: 1100px)'

/** Events after which the list of conversations is no longer current. */
const CONVERSATION_EVENTS = new Set([
  'run_queued',
  'run_started',
  'done',
  'message_added',
  'conversation_updated',
])

const CHAT_WIDTH_KEY = 'litmark:chat-width'
const CHAT_MIN_WIDTH = 300
const CHAT_DEFAULT_WIDTH = 420

/** The widest the drawer may be dragged: never more than half the window. */
const chatMaxWidth = (): number => Math.max(CHAT_MIN_WIDTH, Math.round(window.innerWidth * 0.5))

function storedChatWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(CHAT_WIDTH_KEY))
    if (Number.isFinite(stored) && stored >= CHAT_MIN_WIDTH) return stored
  } catch {
    /* storage can be refused; the default stands */
  }
  return CHAT_DEFAULT_WIDTH
}

/** Which conversation was open, so a reload comes back to it. */
function rememberedConversation(root: string): string | null {
  try {
    return window.localStorage.getItem(`litmark:conversation:${root}`)
  } catch {
    return null // Storage can be refused; the most recent conversation stands in.
  }
}

function rememberConversation(root: string, id: string): void {
  try {
    window.localStorage.setItem(`litmark:conversation:${root}`, id)
  } catch {
    /* as above */
  }
}

export function App() {
  const [state, setState] = useState<ProjectState | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [stream, setStream] = useState<EventStream | null>(null)
  // Bumped when an agent edit lands, so a clean buffer follows the file.
  const [fileTick, setFileTick] = useState(0)

  const [target, setTarget] = useState<MainTarget>({ kind: 'empty' })
  const [buffer, setBuffer] = useState<Buffer | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selection, setSelection] = useState('')

  const [openDocument, setOpenDocument] = useState<DocumentRecord | null>(null)
  const [highlight, setHighlight] = useState<ReferenceRecord | null>(null)
  const [gotoPage, setGotoPage] = useState<number | null>(null)
  const [pdfSelection, setPdfSelection] = useState<PdfSelection | null>(null)
  const [insertNotice, setInsertNotice] = useState<string | null>(null)
  // Every reference in the open document, so the viewer can show all marks
  // and colour them by where they are cited from.
  const [documentReferences, setDocumentReferences] = useState<ReferenceRecord[]>([])
  const [gotoNonce, setGotoNonce] = useState(0)

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  // Conversations that finished a run while another was on screen.
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set())
  const [context, setContext] = useState<MessageContext>({})
  const [sync, setSync] = useState<SyncState | null>(null)
  const [changes, setChanges] = useState<ChangeRecord[]>([])

  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [chatWidth, setChatWidth] = useState(storedChatWidth)
  const [showSource, setShowSourcePanel] = useState(true)
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  const [sourceTakesOver, setSourceTakesOver] = useState(false)

  const insertRef = useRef<((markdown: string) => void) | null>(null)
  const revealRef = useRef<((referenceId: string) => RevealResult) | null>(null)
  // A citation to go to once the note that holds it has opened.
  const pendingReveal = useRef<string | null>(null)
  // The note just created, which opens ready to be written in.
  const startEditing = useRef<string | null>(null)
  // Notes deleted from this window, whose open editor may still try to save.
  const deletedNotes = useRef<Set<string>>(new Set())
  const docKey = keyOf(target)
  const docKeyRef = useRef(docKey)
  docKeyRef.current = docKey

  /**
   * Text read for one note must not land in another. A read can come back
   * after the reader has moved on; put there, it would show one note under
   * another's name — and be saved into it at the next keystroke.
   */
  const placeBuffer = useCallback((key: string, text: string, revision: string | null): void => {
    if (docKeyRef.current === key) setBuffer({ key, text, revision })
  }, [])
  const conversationRef = useRef<string | null>(null)
  const refreshTimer = useRef<number | null>(null)
  conversationRef.current = conversationId

  // -------------------------------------------------------------- loading

  const refreshState = useCallback(async (): Promise<ProjectState | null> => {
    try {
      const next = await api.state()
      setState(next)
      return next
    } catch (error) {
      setFatal(error instanceof Error ? error.message : 'The project could not be loaded.')
      return null
    }
  }, [])

  const refreshConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const { conversations: next } = await api.listConversations()
      setConversations(next)
      return next
    } catch {
      return [] // The list catches up on the next event.
    }
  }, [])

  const refreshSync = useCallback(async (): Promise<void> => {
    try {
      setSync(await api.syncStatus())
    } catch {
      /* the indicator catches up on the next round */
    }
  }, [])

  const selectConversation = useCallback((id: string): void => {
    setConversationId(id)
    setUnread((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    if (conversationId && state) rememberConversation(state.project.root, conversationId)
  }, [conversationId, state?.project.root])

  useEffect(() => {
    let source: EventStream | null = null
    void (async () => {
      const next = await refreshState()
      if (!next) return

      // Back to the conversation that was open; failing that, the most recent.
      setConversations(next.conversations)
      const chats = next.conversations.filter((c) => c.kind === 'chat')
      const remembered = rememberedConversation(next.project.root)
      const opening =
        next.conversations.find((c) => c.conversation_id === remembered)?.conversation_id ??
        chats[0]?.conversation_id ??
        (await api.createConversation()).conversation_id
      setConversationId(opening)
      if (chats.length === 0) void refreshConversations()
      void api.changes().then((payload) => setChanges(payload.changes))
      void refreshSync()

      if (next.notes.length > 0) setTarget({ kind: 'note', noteId: next.notes[0]!.note_id })

      source = new EventStream(setConnected)
      source.subscribe((event: ServerEvent) => {
        if (event.type === 'document_updated' || event.type === 'job_updated') {
          void refreshState()
        }
        if (event.type === 'document_updated') {
          // A paper sent or relabelled from elsewhere is in the record of edits.
          void api.changes().then((payload) => setChanges(payload.changes))
        }
        if (event.type === 'file_changed') {
          void refreshState()
          void api.changes().then((payload) => setChanges(payload.changes))
          setFileTick((tick) => tick + 1)
        }
        if (event.type === 'sync_updated') {
          setSync(event.status as SyncState)
          // The remote had news: notes and papers may have changed under us.
          if (Array.isArray(event.pulled) && event.pulled.length > 0) {
            void refreshState()
            void api.changes().then((payload) => setChanges(payload.changes))
            setFileTick((tick) => tick + 1)
          }
        }
        if (CONVERSATION_EVENTS.has(event.type)) {
          // A run's events come in bursts; one read of the list covers them.
          if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
          refreshTimer.current = window.setTimeout(() => void refreshConversations(), 150)
        }
        const finished = event.conversation_id
        if (event.type === 'done' && finished && finished !== conversationRef.current) {
          setUnread((current) => new Set(current).add(finished))
        }
      })
      source.start(next.latest_seq)
      setStream(source)
    })()

    const media = window.matchMedia(NARROW_QUERY)
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
      source?.close()
    }
  }, [refreshState, refreshConversations, refreshSync])

  // What is waiting to be saved changes as the user types; ask now and then.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshSync()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [refreshSync])

  // Load the buffer for whatever the main area is showing.
  useEffect(() => {
    const key = keyOf(target)
    // A different buffer starts clean, whatever the one before it was.
    setDirty(false)
    if (startEditing.current !== key) startEditing.current = null
    void (async () => {
      try {
        if (target.kind === 'note') {
          const note = await api.readNote(target.noteId)
          placeBuffer(key, note.text, note.revision)
        } else if (target.kind === 'summary') {
          const summary = await api.summary(target.documentId)
          placeBuffer(key, summary.text ?? '', summary.revision)
        } else {
          setBuffer(null)
        }
      } catch (error) {
        setInsertNotice(
          error instanceof ApiError ? error.body.message : 'That could not be opened.',
        )
        // Gone — deleted here, or from somewhere else: nothing to wait for.
        if (error instanceof ApiError && error.status === 404 && docKeyRef.current === key) {
          setTarget({ kind: 'empty' })
          void refreshState()
        }
      }
    })()
  }, [target, placeBuffer])

  // Keep the note context chip in step with what is being edited.
  useEffect(() => {
    setContext((current) => ({
      ...current,
      note_id: target.kind === 'note' ? target.noteId : null,
      note_revision: target.kind === 'note' ? (buffer?.revision ?? null) : null,
    }))
  }, [target, buffer?.revision])

  useEffect(() => {
    setContext((current) => ({ ...current, selection: selection || null }))
  }, [selection])

  const reloadReferences = useCallback(async (): Promise<void> => {
    if (!openDocument) {
      setDocumentReferences([])
      return
    }
    try {
      const payload = await api.listReferences(openDocument.document_id)
      setDocumentReferences(payload.references)
    } catch {
      setDocumentReferences([])
    }
  }, [openDocument?.document_id])

  useEffect(() => {
    void reloadReferences()
  }, [reloadReferences])

  // Citing notes change as the user types, so refresh when the buffer is saved.
  useEffect(() => {
    if (buffer?.revision) void reloadReferences()
  }, [buffer?.revision, reloadReferences])

  const reloadBuffer = useCallback(async (): Promise<void> => {
    const key = keyOf(target)
    try {
      if (target.kind === 'note') {
        const note = await api.readNote(target.noteId)
        placeBuffer(key, note.text, note.revision)
      } else if (target.kind === 'summary') {
        const summary = await api.summary(target.documentId)
        placeBuffer(key, summary.text ?? '', summary.revision)
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error
      // The note on screen was deleted from somewhere else.
      if (docKeyRef.current === key) {
        setTarget({ kind: 'empty' })
        setInsertNotice('The note that was open has been deleted.')
      }
    }
  }, [target, placeBuffer])

  // A clean buffer follows an agent's edit; a dirty one is left alone and the
  // editor surfaces a conflict if the user then saves.
  useEffect(() => {
    if (fileTick > 0 && !dirty) void reloadBuffer()
  }, [fileTick])

  const newConversation = useCallback(async (): Promise<void> => {
    // An empty conversation is as good as a new one: go there instead of
    // leaving a trail of them.
    const blank = conversations.find((c) => c.kind === 'chat' && c.turn_count === 0)
    const id = blank?.conversation_id ?? (await api.createConversation()).conversation_id
    await refreshConversations()
    selectConversation(id)
  }, [conversations, refreshConversations, selectConversation])

  const renameConversation = useCallback(
    async (id: string, title: string): Promise<void> => {
      await api.renameConversation(id, title)
      await refreshConversations()
    },
    [refreshConversations],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      await api.deleteConversation(id)
      const left = await refreshConversations()
      if (id !== conversationRef.current) return
      const next =
        left.find((c) => c.kind === 'chat')?.conversation_id ??
        (await api.createConversation()).conversation_id
      if (!left.some((c) => c.conversation_id === next)) await refreshConversations()
      selectConversation(next)
    },
    [refreshConversations, selectConversation],
  )

  // ------------------------------------------------------------- actions

  const save = useCallback(
    async (text: string, expectedRevision: string | null) => {
      if (target.kind === 'note') {
        // The last keystrokes in a note that was then deleted have nowhere to go.
        if (deletedNotes.current.has(target.noteId)) return { revision: expectedRevision ?? '' }
        const note = await api.saveNote(target.noteId, text, expectedRevision)
        placeBuffer(keyOf(target), note.text, note.revision)
        // A save that lands after the note was left says nothing about the
        // one now open.
        if (keyOf(target) === docKeyRef.current) setDirty(false)
        void refreshState()
        return { revision: note.revision }
      }
      if (target.kind === 'summary') {
        const result = await api.saveSummary(target.documentId, text, expectedRevision)
        placeBuffer(keyOf(target), text, result.revision)
        if (keyOf(target) === docKeyRef.current) setDirty(false)
        void refreshState()
        return { revision: result.revision }
      }
      throw new Error('Nothing is open to save.')
    },
    [target, refreshState, placeBuffer],
  )

  const openSource = useCallback(
    async (referenceId: string): Promise<void> => {
      try {
        const reference = await api.getReference(referenceId)
        setHighlight(reference)
        setGotoPage(reference.page_number)
        setGotoNonce((value) => value + 1)
        setShowSourcePanel(true)
        if (narrow) setSourceTakesOver(true)
        setContext((current) => ({
          ...current,
          reference_id: reference.reference_id,
          page_number: reference.page_number,
        }))
        if (reference.missing_source) {
          setInsertNotice(
            reference.message ??
              'The cited document is no longer in this project. The reference was kept.',
          )
          return
        }
        const document =
          state?.documents.find((item) => item.document_id === reference.document_id) ??
          (await api.getDocument(reference.document_id))
        setOpenDocument(document)
      } catch (error) {
        setInsertNotice(
          error instanceof ApiError
            ? error.body.message
            : 'That source could not be opened.',
        )
      }
    },
    [state?.documents, narrow],
  )

  const insertReference = useCallback(
    async (withQuote: boolean): Promise<void> => {
      if (!pdfSelection) return
      try {
        const reference = await api.createReference({
          document_id: pdfSelection.documentId,
          page_number: pdfSelection.pageNumber,
          quote: pdfSelection.quote,
          prefix: pdfSelection.prefix,
          suffix: pdfSelection.suffix,
        })
        const snippet = withQuote
          ? `\n\n> ${reference.quote ?? pdfSelection.quote}\n>\n> ${reference.markdown_link}\n`
          : ` ${reference.markdown_link}`
        insertRef.current?.(snippet)
        setHighlight(reference)
        setInsertNotice(reference.message ?? null)
        setPdfSelection(null)
      } catch (error) {
        // An ambiguous or absent passage is reported, never guessed at.
        setInsertNotice(
          error instanceof ApiError
            ? error.body.message
            : 'That passage could not be turned into a reference.',
        )
      }
    },
    [pdfSelection],
  )

  const deleteNote = useCallback(
    async (noteId: string): Promise<void> => {
      try {
        deletedNotes.current.add(noteId)
        await api.deleteNote(noteId)
      } catch (error) {
        deletedNotes.current.delete(noteId)
        setInsertNotice(
          error instanceof ApiError ? error.body.message : 'The note could not be deleted.',
        )
        return
      }
      if (docKeyRef.current === `note:${noteId}`) setTarget({ kind: 'empty' })
      await refreshState()
      setChanges((await api.changes()).changes)
    },
    [refreshState],
  )

  const createNote = useCallback(async (): Promise<void> => {
    const note = await api.createNote('Untitled note')
    // A new note may take the name of one deleted before.
    deletedNotes.current.delete(note.note_id)
    await refreshState()
    startEditing.current = `note:${note.note_id}`
    setTarget({ kind: 'note', noteId: note.note_id })
  }, [refreshState])

  const importFiles = useCallback(
    async (files: File[], tags: string[] = []): Promise<void> => {
      const pdfs = files.filter(
        (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
      )
      if (pdfs.length === 0) {
        setInsertNotice('Only PDF import is supported in this version.')
        return
      }
      let result: Awaited<ReturnType<typeof api.uploadDocuments>>
      try {
        result = await api.uploadDocuments(pdfs, tags)
      } catch (error) {
        setInsertNotice(
          error instanceof ApiError ? error.body.message : 'The papers could not be imported.',
        )
        return
      }
      await refreshState()
      const messages: string[] = []
      for (const item of result.imported) {
        if (item.duplicate) {
          messages.push(`${item.document.display_title} was already imported.`)
        }
      }
      for (const failure of result.errors) {
        messages.push(`${failure.filename}: ${failure.message}`)
      }
      setInsertNotice(messages.length > 0 ? messages.join(' ') : null)
      const first = result.imported[0]?.document
      if (first) {
        setOpenDocument(first)
        setShowSourcePanel(true)
      }
    },
    [refreshState],
  )

  /** A change of tags: do it, show the result, and say why if it was refused. */
  const changeTags = useCallback(
    async (change: () => Promise<unknown>): Promise<void> => {
      try {
        await change()
        await refreshState()
      } catch (error) {
        setInsertNotice(
          error instanceof ApiError ? error.body.message : 'The tags could not be changed.',
        )
      }
    },
    [refreshState],
  )

  const openDocumentById = useCallback(
    (documentId: string): void => {
      const document = state?.documents.find((item) => item.document_id === documentId)
      if (!document) return
      setOpenDocument(document)
      setHighlight(null)
      setGotoPage(1)
      setGotoNonce((value) => value + 1)
      setShowSourcePanel(true)
      if (narrow) setSourceTakesOver(true)
      setContext((current) => ({
        ...current,
        document_ids: Array.from(new Set([...(current.document_ids ?? []), documentId])),
      }))
    },
    [state?.documents, narrow],
  )

  /** Drag the drawer's edge to trade room between the chat and the page. */
  const resizeChat = useCallback((event: PointerEvent): void => {
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    let width = 0
    const onMove = (move: PointerEvent): void => {
      // The drawer sits against the right edge of the window.
      width = Math.min(chatMaxWidth(), Math.max(CHAT_MIN_WIDTH, window.innerWidth - move.clientX))
      setChatWidth(width)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      if (width > 0) {
        try {
          window.localStorage.setItem(CHAT_WIDTH_KEY, String(width))
        } catch {
          /* the width holds for this visit */
        }
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
    event.preventDefault()
  }, [])

  /**
   * Go from a highlight in the paper to where it is cited.
   *
   * In the note that is open, if it cites the passage; otherwise the note or
   * summary that does is opened. A passage cited in several places is walked
   * through by clicking again: each citation in this note, then the next place.
   */
  const revealCitation = useCallback(
    (reference: ReferenceRecord): void => {
      setHighlight(reference)
      const places = reference.cited_by ?? []
      if (places.length === 0) return
      const keyOfPlace = (place: (typeof places)[number]): string =>
        place.kind === 'note' ? `note:${place.id}` : `summary:${place.id}`

      const here = places.findIndex((place) => keyOfPlace(place) === docKeyRef.current)
      let next = places[0]!
      if (here >= 0) {
        const result = revealRef.current?.(reference.reference_id)
        const more = places.length > 1
        if (result?.found && !(result.wrapped && more)) {
          setSourceTakesOver(false)
          return
        }
        if (!more) return // Cited here by the record, but no longer in the text.
        next = places[(here + 1) % places.length]!
      }
      pendingReveal.current = reference.reference_id
      setTarget(
        next.kind === 'note'
          ? { kind: 'note', noteId: next.id }
          : { kind: 'summary', documentId: next.id },
      )
      setSourceTakesOver(false)
    },
    [],
  )

  /** Show a paper at a page, as a step in the chat names it. Attaches nothing. */
  const showDocument = useCallback(
    (documentId: string, page: number): void => {
      const document = state?.documents.find((item) => item.document_id === documentId)
      if (!document) {
        setInsertNotice('That paper is no longer in this project.')
        return
      }
      setOpenDocument(document)
      setHighlight(null)
      setGotoPage(page)
      setGotoNonce((value) => value + 1)
      setShowSourcePanel(true)
      if (narrow) setSourceTakesOver(true)
    },
    [state?.documents, narrow],
  )

  /** Open whatever a line of the conversation refers to. */
  const openTarget = useCallback(
    (target: OpenTarget): void => {
      if (target.kind === 'document') showDocument(target.documentId, target.page)
      else if (target.kind === 'reference') void openSource(target.referenceId)
      else if (target.kind === 'note') {
        setTarget({ kind: 'note', noteId: target.noteId })
        setSourceTakesOver(false)
      } else {
        setTarget({ kind: 'summary', documentId: target.documentId })
        setSourceTakesOver(false)
      }
    },
    [showDocument, openSource],
  )

  const jumpToHit = useCallback(
    async (hit: SearchHit): Promise<void> => {
      openDocumentById(hit.document_id)
      setGotoPage(hit.page_number)
      setGotoNonce((value) => value + 1)
      setHighlight(null)
    },
    [openDocumentById],
  )

  const writeBibliography = useCallback(async (): Promise<void> => {
    try {
      const result = await api.writeBibliography()
      const count = `${result.entries} ${result.entries === 1 ? 'entry' : 'entries'}`
      const headline = result.written
        ? `Wrote ${result.path} — ${count}.`
        : `${result.path} was already up to date — ${count}.`
      // Incomplete PDF metadata is reported rather than filled in, so the
      // warnings travel with the result instead of being hidden.
      setInsertNotice([headline, ...result.warnings].join(' '))
    } catch (error) {
      setInsertNotice(
        error instanceof ApiError
          ? error.body.message
          : 'The bibliography could not be written.',
      )
    }
  }, [])

  const undo = useCallback(
    async (change: Pick<ChangeRecord, 'change_id'>): Promise<void> => {
      try {
        await api.undo(change.change_id)
        // Undoing a deletion brings a note back into the list.
        deletedNotes.current.clear()
        await refreshState()
        await reloadBuffer()
        setChanges((await api.changes()).changes)
      } catch (error) {
        setInsertNotice(
          error instanceof ApiError
            ? `Undo was refused: ${error.body.message}`
            : 'Undo failed.',
        )
      }
    },
    [reloadBuffer, refreshState],
  )

  // ---------------------------------------------------------------- render

  const marks = useMemo<PdfMark[]>(() => {
    const currentNoteId = target.kind === 'note' ? target.noteId : null
    return documentReferences
      .filter((reference) => (reference.rects?.length ?? 0) > 0)
      .map((reference) => {
        const citedBy = reference.cited_by ?? []
        const inCurrentNote = citedBy.some(
          (citation) => citation.kind === 'note' && citation.id === currentNoteId,
        )
        const tone: PdfMark['tone'] =
          reference.reference_id === highlight?.reference_id
            ? 'active'
            : inCurrentNote
              ? 'current-note'
              : citedBy.length > 0
                ? 'other-note'
                : 'uncited'
        const where =
          citedBy.length === 0
            ? 'not cited in any note yet'
            : `cited in ${citedBy.map((citation) => citation.title).join(', ')} — click to go there`
        const quote = reference.quote ? `“${reference.quote.slice(0, 90)}” — ` : ''
        return {
          referenceId: reference.reference_id,
          pageNumber: reference.page_number,
          rects: reference.rects ?? [],
          tone,
          label: `${quote}${where} (${reference.reference_id})`,
        }
      })
  }, [documentReferences, target, highlight?.reference_id])


  if (fatal !== null) {
    return (
      <main class="fatal">
        <h1>Litmark</h1>
        <p>{fatal}</p>
      </main>
    )
  }

  if (!state) {
    return (
      <main class="fatal">
        <p>Opening the project…</p>
      </main>
    )
  }

  const notesById = new Map<string, NoteSummary>(
    state.notes.map((note) => [note.note_id, note]),
  )
  // What a `paper:` link in the text on screen may name.
  const papers = papersOf(state.documents)

  const currentTitle =
    target.kind === 'note'
      ? (notesById.get(target.noteId)?.title ?? target.noteId)
      : target.kind === 'summary'
        ? `Summary — ${
            nameOf(state.documents.find((d) => d.document_id === target.documentId)) ??
            target.documentId
          }`
        : 'Nothing open'

  const showSourceRegion = showSource && openDocument !== null && (!narrow || sourceTakesOver)
  const showMain = !narrow || !sourceTakesOver

  return (
    <div
      class={[
        'shell',
        showChat ? '' : 'chat-collapsed',
        showSourceRegion ? '' : 'source-hidden',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header class="topbar">
        <button
          type="button"
          class="ghost"
          onClick={() => setShowSidebar(!showSidebar)}
          title="Toggle the project sidebar"
        >
          ☰
        </button>
        <h1>{state.project.name}</h1>
        <span class="muted path" title={state.project.root}>
          {state.project.root}
        </span>
        <span class="spacer" />
        {!connected && <span class="badge warn">Reconnecting…</span>}
        {sync && (
          <SyncStatus
            sync={sync}
            onOpened={() => void refreshSync()}
            onSync={async (resolve) => {
              const result = await api.syncNow(resolve)
              setSync(result)
              if (result.problems.length > 0) throw new Error(result.problems.join(' '))
            }}
          />
        )}
        {!state.agent.ready && (
          <span class="badge" title={state.agent.message}>
            Agent not configured
          </span>
        )}
        <button
          type="button"
          class={showChat ? 'ghost active' : 'ghost'}
          onClick={() => setShowChat(!showChat)}
          title="Toggle the chat drawer"
        >
          Chat
        </button>
      </header>

      {insertNotice !== null && (
        <div class="banner" role="status">
          <span>{insertNotice}</span>
          <button type="button" class="ghost" onClick={() => setInsertNotice(null)}>
            ✕
          </button>
        </div>
      )}

      <div class="body" style={{ '--chat-width': `${chatWidth}px` }}>
        {showSidebar && (
          <Sidebar
            documents={state.documents}
            notes={state.notes}
            changes={changes}
            activeTarget={target}
            onOpenNote={(noteId) => {
              setTarget({ kind: 'note', noteId })
              setSourceTakesOver(false)
            }}
            onOpenSummary={(documentId) => {
              setTarget({ kind: 'summary', documentId })
              setSourceTakesOver(false)
            }}
            onOpenDocument={openDocumentById}
            onNewNote={() => void createNote()}
            onDeleteNote={deleteNote}
            onSetDetails={async (documentId, details) => {
              await api.setDetails(documentId, details)
              await refreshState()
            }}
            tags={state.tags}
            onImport={(files, tags) => void importFiles(files, tags)}
            onSetTags={(documentId, tags) => void changeTags(() => api.setTags(documentId, tags))}
            onTagDocuments={(ids, add) => void changeTags(() => api.tagDocuments(ids, add))}
            onSearchJump={(hit) => void jumpToHit(hit)}
            onSummarize={async (documentId) => {
              const result = await api.summarize(documentId)
              if (!result.queued) setInsertNotice(result.reason ?? 'No summary was queued.')
            }}
            onReextract={(documentId) => void api.reextract(documentId)}
            onWriteBibliography={writeBibliography}
            onUndo={(change) => void undo(change)}
            onLoadChanges={async () => setChanges((await api.changes()).changes)}
          />
        )}

        {showMain && (
          <main class="main">
            <div class="main-head">
              <h2>{currentTitle}</h2>
              {narrow && openDocument && (
                <button type="button" class="ghost" onClick={() => setSourceTakesOver(true)}>
                  Show source
                </button>
              )}
            </div>
            {buffer && buffer.key === docKey && target.kind !== 'empty' ? (
              <MarkdownEditor
                docKey={docKey}
                text={buffer.text}
                revision={buffer.revision}
                save={save}
                onOpenSource={(id) => void openSource(id)}
                papers={papers}
                onOpenPaper={(id) => showDocument(id, 1)}
                onSelectionChange={setSelection}
                onDirtyChange={setDirty}
                activeReference={highlight?.reference_id ?? null}
                startEditing={startEditing.current === docKey}
                onSaveLost={(message) =>
                  setInsertNotice(
                    `The last edits to “${currentTitle}” could not be saved: ${message}`,
                  )
                }
                registerInsert={(insert) => {
                  insertRef.current = insert
                }}
                registerReveal={(reveal) => {
                  revealRef.current = reveal
                  // Opened in order to show a citation: go to it.
                  const waiting = pendingReveal.current
                  pendingReveal.current = null
                  if (waiting) reveal(waiting)
                }}
              />
            ) : target.kind !== 'empty' ? (
              <div class="empty">
                <p>Opening…</p>
              </div>
            ) : (
              <div class="empty">
                <p>Open a note, or drag PDFs onto the sidebar to import them.</p>
                <button type="button" onClick={() => void createNote()}>
                  New note
                </button>
              </div>
            )}
          </main>
        )}

        {showSourceRegion && openDocument && (
          <aside class="source">
            {narrow && (
              <button
                type="button"
                class="ghost back"
                onClick={() => setSourceTakesOver(false)}
              >
                ← Back to the note
              </button>
            )}
            {pdfSelection && (
              <div class="selection-actions">
                <span class="muted">
                  “{pdfSelection.quote.slice(0, 60)}
                  {pdfSelection.quote.length > 60 ? '…' : ''}”
                </span>
                <button type="button" onClick={() => void insertReference(false)}>
                  Insert reference
                </button>
                <button type="button" onClick={() => void insertReference(true)}>
                  Insert quotation and reference
                </button>
              </div>
            )}
            <PdfViewer
              document={openDocument}
              marks={marks}
              gotoPage={gotoPage}
              gotoNonce={gotoNonce}
              onSelection={setPdfSelection}
              onActivateMark={(referenceId) => {
                const reference = documentReferences.find(
                  (item) => item.reference_id === referenceId,
                )
                if (reference) revealCitation(reference)
              }}
              onClose={() => {
                setOpenDocument(null)
                // No passage is on show any more, here or in the note.
                setHighlight(null)
                setSourceTakesOver(false)
              }}
            />
          </aside>
        )}

        {showChat && (
          <aside class="chat-drawer">
            <div
              class="chat-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the chat"
              title="Drag to resize; double-click to reset"
              onPointerDown={resizeChat}
              onDblClick={() => {
                setChatWidth(CHAT_DEFAULT_WIDTH)
                try {
                  window.localStorage.removeItem(CHAT_WIDTH_KEY)
                } catch {
                  /* nothing was stored */
                }
              }}
            />
            <Chat
              conversations={conversations}
              currentId={conversationId}
              unread={unread}
              stream={stream}
              agent={state.agent}
              documents={state.documents}
              notes={state.notes}
              changes={changes}
              context={context}
              onContextChange={setContext}
              onSelect={selectConversation}
              onNew={() => void newConversation()}
              onRename={renameConversation}
              onDelete={deleteConversation}
              onOpen={openTarget}
              onOpenSource={(id) => void openSource(id)}
              onUndo={(changeId) => void undo({ change_id: changeId })}
            />
          </aside>
        )}
      </div>
    </div>
  )
}
