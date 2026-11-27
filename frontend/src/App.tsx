/**
 * The application shell: the library, and what is open — a panel about it,
 * the note or summary, the paper, and the chat drawer.
 *
 * The library is every paper and note as a grid, and is where one starts. It
 * is laid over whatever is open rather than replacing it, so going to look
 * something up and coming back loses no place. Each side region can collapse,
 * and the chat drawer is capped so it cannot squeeze the editor and the PDF
 * into unreadable columns. On a narrow window the paper takes over the main
 * view, with an explicit way back.
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
  type RelatedToNote,
  type RelatedToPaper,
  type SearchHit,
  type SelectionIn,
  type SyncState,
} from './api'
import { AskAbout, type AskPane, type Passage } from './AskAbout'
import { Chat } from './chat/Chat'
import type { OpenTarget } from './chat/describe'
import { MarkdownEditor, type RevealResult } from './editor/MarkdownEditor'
import { EventStream, type ServerEvent } from './events'
import { Library } from './Library'
import { headingsOf } from './outline'
import { nameOf, papersOf } from './papers'
import {
  PdfViewer,
  type PdfMark,
  type PdfOutlineItem,
  type PdfSelection,
} from './pdf/PdfViewer'
import type { InkNews } from './pdf/useInk'
import {
  addressOf,
  isUntouched,
  openSessions,
  readView,
  sessionInAddress,
  Sessions,
  type SessionView,
} from './Sessions'
import { Sidebar, type Subject } from './Sidebar'
import { UNTAGGED } from './Tags'
import { SyncStatus } from './SyncStatus'
import { Version } from './Version'

type MainTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'summary'; documentId: string }
  /** The summarizing skill: how the reader wants papers summarized. */
  | { kind: 'skill' }
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
      : target.kind === 'skill'
        ? 'skill:summary'
        : 'empty'

/** Whether what a target names is still in the project. */
function stillThere(project: ProjectState, target: MainTarget): boolean {
  if (target.kind === 'note') {
    return project.notes.some((note) => note.note_id === target.noteId)
  }
  if (target.kind === 'summary') {
    return project.documents.some((document) => document.document_id === target.documentId)
  }
  return target.kind === 'skill'
}

/**
 * Where the reader has been in a session, most recent last: the texts that
 * were open, each with the place it was read to, and the pages of the papers
 * they were taken away from. A link followed is a step that can be taken back.
 */
interface Trail {
  text: { target: MainTarget; at: number }[]
  paper: { documentId: string; page: number }[]
}

/** Further back than this is not somewhere one is still on the way from. */
const TRAIL_LENGTH = 50

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

const SOURCE_SHARE_KEY = 'litmark:source-share'
/** How the text and the paper divide the room between them: the paper's part. */
const SOURCE_DEFAULT_SHARE = 0.51
const SOURCE_MIN_SHARE = 0.3
const SOURCE_MAX_SHARE = 0.75
/**
 * The least the two are given between them, however short of room the window
 * is: a readable line of text and a readable page (see `.body > .main`).
 */
const SPLIT_LEAST = '34ch + 360px'

/**
 * How much of the room a pane takes when the text and the paper are side by
 * side. Its part of what there is, and the same part of the least they are
 * given: so the split is the reader's in a small window too, where each
 * pane's own minimum would otherwise decide it, and the chat and the panel
 * beside them are squeezed no more than they were.
 */
const splitStyle = (part: number): { flexGrow: number; minWidth: string } => ({
  flexGrow: part,
  minWidth: `calc((${SPLIT_LEAST}) * ${part.toFixed(4)})`,
})

function storedSourceShare(): number {
  try {
    const stored = Number(window.localStorage.getItem(SOURCE_SHARE_KEY))
    if (Number.isFinite(stored) && stored >= SOURCE_MIN_SHARE && stored <= SOURCE_MAX_SHARE) {
      return stored
    }
  } catch {
    /* storage can be refused; the default stands */
  }
  return SOURCE_DEFAULT_SHARE
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
  // The ink on a paper was saved from another window, or came in from git.
  const [inkNews, setInkNews] = useState<InkNews | null>(null)

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

  // The library is laid over what is open, which keeps its place underneath.
  const [library, setLibrary] = useState(false)
  // The tags the library is narrowed to; a paper must carry all of them.
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  // The open paper's own table of contents, when its PDF carries one.
  const [outline, setOutline] = useState<PdfOutlineItem[]>([])
  // What the note or paper on screen is tied to.
  const [related, setRelated] = useState<{
    key: string
    value: RelatedToNote | RelatedToPaper
  } | null>(null)

  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [chatWidth, setChatWidth] = useState(storedChatWidth)
  const [sourceShare, setSourceShare] = useState(storedSourceShare)
  const [showSource, setShowSourcePanel] = useState(true)
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  const [sourceTakesOver, setSourceTakesOver] = useState(false)

  const insertRef = useRef<((markdown: string) => void) | null>(null)
  const revealRef = useRef<((referenceId: string) => RevealResult) | null>(null)
  const gotoHeadingRef = useRef<((headingIndex: number) => void) | null>(null)

  // A session is a conversation and its view. What each one had on screen, as
  // this window knows it — ahead of what the server was last told.
  const viewsRef = useRef(new Map<string, SessionView>())
  // What the server was last told of each, so the same thing is not said twice.
  const savedViews = useRef(new Map<string, string>())
  // The view waiting to be told, a moment after it last changed.
  const pendingView = useRef<{ id: string; view: SessionView; json: string; timer: number } | null>(
    null,
  )
  // The session whose view is on screen: until it is, there is nothing to save.
  const restoredFor = useRef<string | null>(null)
  // Whether the library is to be laid over a view that is being restored.
  const pendingLibrary = useRef<boolean | null>(null)
  // The page the paper on show is at.
  const [pdfPage, setPdfPage] = useState<number | null>(null)
  const stateRef = useRef<ProjectState | null>(null)
  stateRef.current = state
  const conversationsRef = useRef<ConversationSummary[]>([])
  conversationsRef.current = conversations
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

  // The way back, for each session. Kept by this window only: it is where
  // this reader has just been, not part of what the session is.
  const trails = useRef(new Map<string, Trail>())
  const [, redrawTrail] = useState(0)
  const trailOf = useCallback((id: string): Trail => {
    let trail = trails.current.get(id)
    if (!trail) {
      trail = { text: [], paper: [] }
      trails.current.set(id, trail)
    }
    return trail
  }, [])
  // How far each text on screen has been read: the position at the top of the view.
  const textPlaces = useRef(new Map<string, number>())
  // A step back is not itself somewhere to go back from.
  const steppingBack = useRef(false)
  const lastShown = useRef<{ session: string | null; target: MainTarget } | null>(null)
  const openDocumentRef = useRef<DocumentRecord | null>(null)
  openDocumentRef.current = openDocument
  const pdfPageRef = useRef<number | null>(null)
  pdfPageRef.current = pdfPage

  // Whatever takes the place of a text — a link in it, the panel, the chat —
  // leaves that text behind as somewhere to come back to.
  useEffect(() => {
    const last = lastShown.current
    lastShown.current = { session: conversationId, target }
    const back = steppingBack.current
    steppingBack.current = false
    const leaving = last ? keyOf(last.target) : null
    if (leaving === docKey) return
    // A text newly opened is at its first line; one come back to is where it was left.
    if (!back) textPlaces.current.set(docKey, 0)
    // A session come to has its own trail; nothing was left to get there.
    if (back || !last || !conversationId || last.session !== conversationId) return
    if (leaving === null || last.target.kind === 'empty') return
    const trail = trailOf(conversationId).text
    trail.push({ target: last.target, at: textPlaces.current.get(leaving) ?? 0 })
    if (trail.length > TRAIL_LENGTH) trail.shift()
    redrawTrail((tick) => tick + 1)
  }, [docKey, conversationId])

  /** Back to the text that was open before this one, where it was left. */
  const stepBackText = useCallback((): void => {
    const id = conversationRef.current
    const project = stateRef.current
    if (!id || !project) return
    const trail = trailOf(id).text
    while (trail.length > 0) {
      const place = trail.pop()!
      const key = keyOf(place.target)
      // Deleted since, or where the reader already is: further back, then.
      if (key === docKeyRef.current || !stillThere(project, place.target)) continue
      steppingBack.current = true
      textPlaces.current.set(key, place.at)
      setTarget(place.target)
      setSourceTakesOver(false)
      break
    }
    redrawTrail((tick) => tick + 1)
  }, [trailOf])

  /**
   * The page on show is about to be left for another — a citation opened, an
   * entry of the contents, another paper: it is kept as somewhere to return to.
   */
  const leavePage = useCallback((): void => {
    const id = conversationRef.current
    const documentId = openDocumentRef.current?.document_id
    if (!id || !documentId) return
    const trail = trailOf(id).paper
    const page = pdfPageRef.current ?? 1
    const top = trail[trail.length - 1]
    if (top && top.documentId === documentId && top.page === page) return
    trail.push({ documentId, page })
    if (trail.length > TRAIL_LENGTH) trail.shift()
    redrawTrail((tick) => tick + 1)
  }, [trailOf])

  /** Back to the page, and the paper, the reader was taken away from. */
  const stepBackPaper = useCallback((): void => {
    const id = conversationRef.current
    const project = stateRef.current
    if (!id || !project) return
    const trail = trailOf(id).paper
    const here = openDocumentRef.current?.document_id ?? null
    while (trail.length > 0) {
      const place = trail.pop()!
      const paper = project.documents.find((item) => item.document_id === place.documentId)
      if (!paper || (place.documentId === here && place.page === pdfPageRef.current)) continue
      setOpenDocument(paper)
      // A passage picked out in one paper means nothing in another.
      if (place.documentId !== here) setHighlight(null)
      setGotoPage(place.page)
      setGotoNonce((value) => value + 1)
      break
    }
    redrawTrail((tick) => tick + 1)
  }, [trailOf])

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

  /** Tell the server now what is on screen, rather than in a moment. */
  const flushView = useCallback((): void => {
    const pending = pendingView.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingView.current = null
    savedViews.current.set(pending.id, pending.json)
    api.saveView(pending.id, pending.view).then(
      () => {
        // The list this window holds learns it too: a session with a view is
        // one that stays in the row.
        setConversations((known) =>
          known.map((conversation) =>
            conversation.conversation_id === pending.id && conversation.view == null
              ? { ...conversation, view: pending.view }
              : conversation,
          ),
        )
      },
      () => {
        // Not told after all: say it again the next time the view changes.
        savedViews.current.delete(pending.id)
      },
    )
  }, [])

  /**
   * Put on screen what a session last had there: the note or paper, the page,
   * what was attached. What is no longer in the project is simply not opened.
   */
  const restoreView = useCallback(
    (id: string, project: ProjectState, known: ConversationSummary[]): void => {
      const view =
        viewsRef.current.get(id) ??
        readView(known.find((conversation) => conversation.conversation_id === id)?.view)
      const has = (documentId: string): boolean =>
        project.documents.some((document) => document.document_id === documentId)
      let next: MainTarget = view.target
      if (next.kind === 'note') {
        const noteId = next.noteId
        if (!project.notes.some((note) => note.note_id === noteId)) next = { kind: 'empty' }
      } else if (next.kind === 'summary' && !has(next.documentId)) {
        next = { kind: 'empty' }
      }
      const paper = view.documentId
        ? (project.documents.find((document) => document.document_id === view.documentId) ?? null)
        : null
      // Going somewhere takes the library away; coming back to a session that
      // had it up is the one case where it is put back.
      pendingLibrary.current = view.library
      setTarget({ ...next })
      setOpenDocument(paper)
      setHighlight(null)
      setPdfSelection(null)
      setGotoPage(paper ? (view.page ?? 1) : null)
      setGotoNonce((value) => value + 1)
      setPdfPage(paper ? (view.page ?? 1) : null)
      setSourceTakesOver(false)
      setContext({ document_ids: view.attached.filter(has) })
      restoredFor.current = id
    },
    [],
  )

  const selectConversation = useCallback(
    (id: string, address: 'push' | 'replace' | 'keep' = 'push'): void => {
      const leaving = conversationRef.current
      if (id !== leaving) {
        // What the session being left had on screen is told before it is left.
        flushView()
        setConversationId(id)
        if (stateRef.current) restoreView(id, stateRef.current, conversationsRef.current)
      }
      setUnread((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      })
      if (address !== 'keep' && sessionInAddress(window.location.pathname) !== id) {
        // Each session has an address, so one can be kept in a window of its own.
        if (address === 'replace') window.history.replaceState(null, '', addressOf(id))
        else window.history.pushState(null, '', addressOf(id))
      }
      // Going to a session that was put away brings it back to the row.
      if (conversationsRef.current.find((c) => c.conversation_id === id)?.closed) {
        void api.setClosed(id, false).then(
          () => refreshConversations(),
          () => undefined,
        )
      }
    },
    [flushView, restoreView, refreshConversations],
  )

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
      // The session the address names; failing that the one last open here,
      // then the most recent.
      const addressed = sessionInAddress(window.location.pathname)
      const opening =
        chats.find((c) => c.conversation_id === addressed)?.conversation_id ??
        next.conversations.find((c) => c.conversation_id === remembered)?.conversation_id ??
        chats[0]?.conversation_id ??
        (await api.createConversation()).conversation_id
      conversationsRef.current = next.conversations
      stateRef.current = next
      selectConversation(opening, 'replace')
      if (chats.length === 0) void refreshConversations()
      void api.changes().then((payload) => setChanges(payload.changes))
      void refreshSync()

      source = new EventStream(setConnected)
      source.subscribe((event: ServerEvent) => {
        if (
          event.type === 'document_updated' ||
          event.type === 'job_updated' ||
          event.type === 'settings_updated'
        ) {
          void refreshState()
        }
        if (event.type === 'document_updated') {
          // A paper sent or relabelled from elsewhere is in the record of edits.
          void api.changes().then((payload) => setChanges(payload.changes))
        }
        if (event.type === 'ink_updated' && typeof event.document_id === 'string') {
          const { document_id: documentId, revision } = event
          setInkNews((before) => ({
            documentId,
            revision: typeof revision === 'string' ? revision : null,
            tick: (before?.tick ?? 0) + 1,
          }))
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
            if (event.pulled.some((path) => /^documents\/[^/]+\/ink\.json$/.test(String(path)))) {
              setInkNews((before) => ({
                documentId: null,
                revision: null,
                tick: (before?.tick ?? 0) + 1,
              }))
            }
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
        } else if (target.kind === 'skill') {
          const skill = await api.skill()
          placeBuffer(key, skill.text, skill.revision)
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

  // What is selected in the text, and which text that is.
  const selectionIn = useMemo<SelectionIn | null>(
    () =>
      target.kind === 'note'
        ? { kind: 'note', id: target.noteId }
        : target.kind === 'summary'
          ? { kind: 'summary', id: target.documentId }
          : null,
    [docKey],
  )
  useEffect(() => {
    setContext((current) => ({
      ...current,
      selection: selection || null,
      selection_in: selection ? selectionIn : null,
    }))
  }, [selection, selectionIn])

  const contextRef = useRef(context)
  contextRef.current = context

  /** What can be asked about in a pane: the passage selected there. */
  const passageIn = useCallback(
    (pane: AskPane): Passage | null => {
      if (pane === 'text') return selection.trim() ? { quote: selection, in: selectionIn } : null
      if (!pdfSelection) return null
      return {
        quote: pdfSelection.quote,
        in: { kind: 'paper', id: pdfSelection.documentId, page: pdfSelection.pageNumber },
      }
    },
    [selection, selectionIn, pdfSelection],
  )

  /**
   * Ask about a passage, from where it is: a turn in the session on screen,
   * sent with everything a message from the chat is sent with, and the passage
   * in place of whatever else was selected.
   */
  const askAbout = useCallback(async (prompt: string, passage: Passage): Promise<boolean> => {
    const id = conversationRef.current
    if (!id) return false
    const base = contextRef.current
    const papers = base.document_ids ?? []
    // The paper a passage is from is one the agent is to start from.
    const from = passage.in?.kind === 'paper' ? passage.in.id : null
    try {
      await api.sendMessage(id, prompt, {
        ...base,
        selection: passage.quote,
        selection_in: passage.in,
        document_ids: from && !papers.includes(from) ? [...papers, from] : papers,
      })
    } catch (error) {
      setInsertNotice(
        error instanceof ApiError ? error.body.message : 'The request could not be sent.',
      )
      return false
    }
    // The answer is read in the chat: brought out if it was put away.
    setShowChat(true)
    return true
  }, [])

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
      } else if (target.kind === 'skill') {
        // The agent learned something while it was open: show what it wrote.
        const skill = await api.skill()
        placeBuffer(key, skill.text, skill.revision)
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

  /**
   * A new session. One in which nothing has been asked or opened is as good
   * as a new one: go there instead of leaving a trail of them. `besides` is a
   * session not to end up in — the one being closed.
   */
  const newConversation = useCallback(
    async (besides: string | null = null): Promise<void> => {
      const untouched = (conversation: ConversationSummary): boolean => {
        const id = conversation.conversation_id
        if (conversation.kind !== 'chat' || id === besides) return false
        // What this window has done in it since counts, whatever the server has heard.
        const mine = viewsRef.current.get(id)
        return isUntouched(mine ? { ...conversation, view: mine } : conversation)
      }
      const known = conversationsRef.current
      const here = known.find((c) => c.conversation_id === conversationRef.current)
      const blank = (here && untouched(here) ? here : undefined) ?? known.find(untouched)
      const id = blank?.conversation_id ?? (await api.createConversation()).conversation_id
      await refreshConversations()
      selectConversation(id)
    },
    [refreshConversations, selectConversation],
  )

  /** Put a session away. Nothing is deleted; the chat's list brings it back. */
  const closeSession = useCallback(
    async (id: string): Promise<void> => {
      if (id === conversationRef.current) {
        // Somewhere to be instead: the session beside it, or a new one.
        const row = openSessions(conversationsRef.current, id)
        const at = row.findIndex((c) => c.conversation_id === id)
        const beside = row[at + 1] ?? row[at - 1]
        if (beside) selectConversation(beside.conversation_id)
        else await newConversation(id)
      }
      try {
        await api.setClosed(id, true)
      } finally {
        await refreshConversations()
      }
    },
    [selectConversation, newConversation, refreshConversations],
  )

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
      viewsRef.current.delete(id)
      const next =
        openSessions(left, null)[0]?.conversation_id ??
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
      if (target.kind === 'skill') {
        const skill = await api.saveSkill(text, expectedRevision)
        placeBuffer(keyOf(target), skill.text, skill.revision)
        if (keyOf(target) === docKeyRef.current) setDirty(false)
        return { revision: skill.revision }
      }
      throw new Error('Nothing is open to save.')
    },
    [target, refreshState, placeBuffer],
  )

  const openSource = useCallback(
    async (referenceId: string): Promise<void> => {
      try {
        const reference = await api.getReference(referenceId)
        leavePage()
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
    [state?.documents, narrow, leavePage],
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
      leavePage()
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
    [state?.documents, narrow, leavePage],
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

  /** Drag the paper's edge to trade room between it and the text beside it. */
  const resizeSource = useCallback((event: PointerEvent): void => {
    const handle = event.currentTarget as HTMLElement
    const source = handle.parentElement
    const main = source?.parentElement?.querySelector<HTMLElement>(':scope > .main')
    if (!source || !main) return
    handle.setPointerCapture(event.pointerId)
    let share = 0
    const onMove = (move: PointerEvent): void => {
      // The two of them, edge to edge: the paper's part is what is right of the pointer.
      const left = main.getBoundingClientRect().left
      const right = source.getBoundingClientRect().right
      if (right <= left) return
      share = Math.min(
        SOURCE_MAX_SHARE,
        Math.max(SOURCE_MIN_SHARE, (right - move.clientX) / (right - left)),
      )
      setSourceShare(share)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      if (share > 0) {
        try {
          window.localStorage.setItem(SOURCE_SHARE_KEY, String(share))
        } catch {
          /* the split holds for this visit */
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
      leavePage()
      setOpenDocument(document)
      setHighlight(null)
      setGotoPage(page)
      setGotoNonce((value) => value + 1)
      setShowSourcePanel(true)
      if (narrow) setSourceTakesOver(true)
    },
    [state?.documents, narrow, leavePage],
  )

  /** Open whatever a line of the conversation refers to. */
  const openTarget = useCallback(
    (target: OpenTarget): void => {
      if (target.kind === 'document') showDocument(target.documentId, target.page)
      else if (target.kind === 'reference') void openSource(target.referenceId)
      else if (target.kind === 'note') {
        setTarget({ kind: 'note', noteId: target.noteId })
        setSourceTakesOver(false)
      } else if (target.kind === 'skill') {
        setTarget({ kind: 'skill' })
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

  /** Open a paper from the library: its summary, with the PDF beside it. */
  const openPaper = useCallback(
    (documentId: string): void => {
      setTarget({ kind: 'summary', documentId })
      setSourceTakesOver(false)
      openDocumentById(documentId)
    },
    [openDocumentById],
  )

  // Going anywhere — to a note, a summary, a page of a paper — is leaving the
  // library; it stays one click away, and what was open is still there.
  useEffect(() => {
    // …unless this is a session coming back that had the library up.
    setLibrary(pendingLibrary.current ?? false)
    pendingLibrary.current = null
  }, [target, gotoNonce])

  // What is on screen, as it is kept for the session.
  const view = useMemo<SessionView>(
    () => ({
      target,
      documentId: openDocument?.document_id ?? null,
      page: openDocument ? pdfPage : null,
      attached: context.document_ids ?? [],
      library,
    }),
    [target, openDocument?.document_id, pdfPage, context.document_ids, library],
  )
  const viewJson = JSON.stringify(view)
  useEffect(() => {
    const id = conversationId
    // Nothing to keep until the session's own view is the one on screen.
    if (!id || restoredFor.current !== id) return
    viewsRef.current.set(id, view)
    const pending = pendingView.current
    if (pending) window.clearTimeout(pending.timer)
    pendingView.current = null
    if (savedViews.current.get(id) === viewJson) return
    // Told a moment after it settles: a page turned is not worth a request each.
    pendingView.current = { id, view, json: viewJson, timer: window.setTimeout(flushView, 700) }
  }, [conversationId, viewJson, flushView])

  // A window put away or closed is told about at once.
  useEffect(() => {
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') flushView()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flushView)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flushView)
    }
  }, [flushView])

  // Back and forward go between the sessions that were on screen.
  useEffect(() => {
    const onPop = (): void => {
      const id = sessionInAddress(window.location.pathname)
      if (!id || id === conversationRef.current) return
      if (conversationsRef.current.some((c) => c.conversation_id === id && c.kind === 'chat')) {
        selectConversation(id, 'keep')
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [selectConversation])

  // A window is named for its session, to tell several of them apart.
  const onScreen = conversations.find((c) => c.conversation_id === conversationId)
  const sessionTitle = onScreen && !onScreen.untitled ? onScreen.title : null
  useEffect(() => {
    document.title = sessionTitle ? `${sessionTitle} — Litmark` : 'Litmark'
  }, [sessionTitle])

  useEffect(() => {
    if (!openDocument) setOutline([])
  }, [openDocument?.document_id])

  // What the panel on the left is about: the note, or the paper — the one
  // whose summary is open, or failing that the one being read.
  const subject = useMemo<Subject>(() => {
    if (target.kind === 'note') return { kind: 'note', noteId: target.noteId }
    if (target.kind === 'summary') return { kind: 'paper', documentId: target.documentId }
    if (target.kind === 'skill') return { kind: 'skill' }
    return openDocument ? { kind: 'paper', documentId: openDocument.document_id } : null
  }, [target, openDocument?.document_id])
  const subjectKey = !subject
    ? ''
    : subject.kind === 'note'
      ? `note:${subject.noteId}`
      : subject.kind === 'paper'
        ? `paper:${subject.documentId}`
        : 'skill'

  // What it is tied to is read from the text of the notes and summaries, so
  // it is asked again whenever one of them is saved or changed from elsewhere.
  useEffect(() => {
    if (!subject || subject.kind === 'skill') {
      setRelated(null)
      return
    }
    let cancelled = false
    const asked =
      subject.kind === 'note'
        ? api.relatedToNote(subject.noteId)
        : api.relatedToPaper(subject.documentId)
    asked.then(
      (value) => {
        if (!cancelled) setRelated({ key: subjectKey, value })
      },
      () => {
        if (!cancelled) setRelated(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [subjectKey, buffer?.revision, fileTick, state?.documents])

  const headings = useMemo(
    () => (buffer && buffer.key === docKey ? headingsOf(buffer.text) : []),
    [buffer, docKey],
  )

  const toggleTag = useCallback((tag: string): void => {
    const fold = (value: string): string => value.toLocaleLowerCase()
    setSelectedTags((current) =>
      current.some((own) => fold(own) === fold(tag))
        ? current.filter((own) => fold(own) !== fold(tag))
        : [...current, tag],
    )
  }, [])

  // A tag whose last paper lost it is no longer something to filter by.
  useEffect(() => {
    if (!state) return
    const live = new Set(state.tags.map(({ tag }) => tag.toLocaleLowerCase()))
    const untagged = state.documents.some((document) => document.tags.length === 0)
    setSelectedTags((current) => {
      const kept = current.filter((tag) =>
        tag === UNTAGGED ? untagged : live.has(tag.toLocaleLowerCase()),
      )
      return kept.length === current.length ? current : kept
    })
  }, [state?.tags, state?.documents])

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

  // A session nothing has been asked in yet goes by what is open in it.
  const sessionLabel = (conversation: ConversationSummary): string => {
    if (!conversation.untitled) return conversation.title
    const id = conversation.conversation_id
    const seen =
      id === conversationId ? view : (viewsRef.current.get(id) ?? readView(conversation.view))
    if (seen.target.kind === 'note') {
      return notesById.get(seen.target.noteId)?.title ?? 'New session'
    }
    if (seen.target.kind === 'skill') return 'Summarizing skill'
    const paperId = seen.target.kind === 'summary' ? seen.target.documentId : seen.documentId
    return nameOf(state.documents.find((d) => d.document_id === paperId)) ?? 'New session'
  }

  const titleOf = (shown: MainTarget): string =>
    shown.kind === 'note'
      ? (notesById.get(shown.noteId)?.title ?? shown.noteId)
      : shown.kind === 'summary'
        ? `Summary — ${
            nameOf(state.documents.find((d) => d.document_id === shown.documentId)) ??
            shown.documentId
          }`
        : shown.kind === 'skill'
          ? 'How papers are summarized'
          : 'Nothing open'
  const currentTitle = titleOf(target)

  // Where a step back would go, in the text and in the paper: the last place
  // on each trail that is still there and is not where the reader already is.
  const trail = conversationId ? trails.current.get(conversationId) : undefined
  const textBefore = [...(trail?.text ?? [])]
    .reverse()
    .find((place) => keyOf(place.target) !== docKey && stillThere(state, place.target))
  const paperBefore = [...(trail?.paper ?? [])]
    .reverse()
    .find(
      (place) =>
        !(place.documentId === openDocument?.document_id && place.page === pdfPage) &&
        state.documents.some((d) => d.document_id === place.documentId),
    )
  const paperBeforeName =
    paperBefore && paperBefore.documentId !== openDocument?.document_id
      ? nameOf(state.documents.find((d) => d.document_id === paperBefore.documentId))
      : null

  // The library shows when it is asked for, and when nothing at all is open.
  const inLibrary = library || (target.kind === 'empty' && openDocument === null)
  const showSourceRegion =
    !inLibrary &&
    showSource &&
    openDocument !== null &&
    (!narrow || sourceTakesOver || target.kind === 'empty')
  // With no note or summary open, a paper being read has the page to itself.
  const showMain = !inLibrary && target.kind !== 'empty' && (!narrow || !sourceTakesOver)

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
        <h1 title={state.project.root}>{state.project.name}</h1>
        <button
          type="button"
          class={inLibrary ? 'ghost active' : 'ghost'}
          data-action="library"
          aria-pressed={inLibrary}
          title={
            inLibrary
              ? 'Every paper and note — click again to go back to what was open'
              : 'Every paper and note'
          }
          onClick={() => setLibrary(!inLibrary)}
        >
          Library
        </button>
        <Sessions
          conversations={conversations}
          currentId={conversationId}
          unread={unread}
          labelFor={sessionLabel}
          onSelect={(id) => selectConversation(id)}
          onNew={() => void newConversation()}
          onClose={(id) => void closeSession(id)}
          onRename={renameConversation}
        />
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
        {state.auth?.password && (
          <button
            type="button"
            class="ghost sign-out"
            data-action="sign-out"
            title="End this session; the password is asked for again"
            onClick={() => void api.signOut()}
          >
            Sign out
          </button>
        )}
        <Version connected={connected} />
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
        {showSidebar ? (
          <Sidebar
            onCollapse={() => setShowSidebar(false)}
            library={inLibrary}
            documents={state.documents}
            notes={state.notes}
            tags={state.tags}
            changes={changes}
            selectedTags={selectedTags}
            onToggleTag={toggleTag}
            onClearTags={() => setSelectedTags([])}
            subject={subject}
            headings={headings}
            onGotoHeading={(index) => gotoHeadingRef.current?.(index)}
            openDocumentId={openDocument?.document_id ?? null}
            outline={outline}
            onGotoPage={(page) => {
              leavePage()
              setGotoPage(page)
              setGotoNonce((value) => value + 1)
              if (narrow) setSourceTakesOver(true)
            }}
            related={related && related.key === subjectKey ? related.value : null}
            onOpenNote={(noteId) => {
              setTarget({ kind: 'note', noteId })
              setSourceTakesOver(false)
            }}
            onOpenPaper={openPaper}
            onOpenSummary={(documentId) => {
              setTarget({ kind: 'summary', documentId })
              setSourceTakesOver(false)
            }}
            onOpenDocument={openDocumentById}
            onOpenSkill={() => {
              setTarget({ kind: 'skill' })
              setSourceTakesOver(false)
            }}
            onDeleteNote={deleteNote}
            onSetDetails={async (documentId, details) => {
              await api.setDetails(documentId, details)
              await refreshState()
            }}
            onSetTags={(documentId, tags) => void changeTags(() => api.setTags(documentId, tags))}
            onSummarize={async (documentId) => {
              const result = await api.summarize(documentId)
              if (!result.queued) setInsertNotice(result.reason ?? 'No summary was queued.')
            }}
            onReextract={(documentId) => void api.reextract(documentId)}
            onUndo={(change) => void undo(change)}
            onLoadChanges={async () => setChanges((await api.changes()).changes)}
          />
        ) : (
          <button
            type="button"
            class="rail rail-left"
            data-action="show-sidebar"
            title={inLibrary ? 'Show the tag filters' : 'Show the panel about what is open'}
            onClick={() => setShowSidebar(true)}
          >
            <span aria-hidden="true">»</span>
            <span class="rail-label">{inLibrary ? 'Tags' : 'About'}</span>
          </button>
        )}

        {inLibrary && (
          <Library
            documents={state.documents}
            notes={state.notes}
            tags={state.tags}
            selectedTags={selectedTags}
            onToggleTag={toggleTag}
            onClearTags={() => setSelectedTags([])}
            onOpenPaper={openPaper}
            onOpenNote={(noteId) => {
              setTarget({ kind: 'note', noteId })
              setSourceTakesOver(false)
            }}
            onNewNote={() => void createNote()}
            onOpenSkill={() => {
              setTarget({ kind: 'skill' })
              setSourceTakesOver(false)
            }}
            onDeleteNote={deleteNote}
            onImport={(files, tags) => void importFiles(files, tags)}
            onTagDocuments={(ids, add) => void changeTags(() => api.tagDocuments(ids, add))}
            onSearchJump={(hit) => void jumpToHit(hit)}
            onWriteBibliography={writeBibliography}
          />
        )}

        {showMain && (
          <main
            class="main"
            // Beside the paper, the two divide the room as the reader set it.
            style={showSourceRegion ? splitStyle(1 - sourceShare) : undefined}
          >
            {narrow && openDocument && (
              <div class="main-head">
                <button type="button" class="ghost" onClick={() => setSourceTakesOver(true)}>
                  Show the paper
                </button>
              </div>
            )}
            {buffer && buffer.key === docKey ? (
              <MarkdownEditor
                docKey={docKey}
                title={currentTitle}
                registerGoto={(goto) => {
                  gotoHeadingRef.current = goto
                }}
                text={buffer.text}
                revision={buffer.revision}
                save={save}
                onOpenSource={(id) => void openSource(id)}
                papers={papers}
                onOpenPaper={(id) => showDocument(id, 1)}
                notes={state.notes}
                onOpenNote={(noteId) => {
                  setTarget({ kind: 'note', noteId })
                  setSourceTakesOver(false)
                }}
                back={textBefore ? { to: titleOf(textBefore.target), go: stepBackText } : null}
                onPlace={(position) => textPlaces.current.set(docKey, position)}
                // Where it was left: stepped back to, or put back from under the library.
                startAt={textPlaces.current.get(docKey)}
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
            ) : (
              <div class="empty">
                <p>Opening…</p>
              </div>
            )}
          </main>
        )}

        {showSourceRegion && openDocument && (
          <aside class="source" style={showMain ? splitStyle(sourceShare) : undefined}>
            {showMain && !narrow && (
              <div
                class="source-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the paper"
                title="Drag to resize; double-click to reset"
                onPointerDown={resizeSource}
                onDblClick={() => {
                  setSourceShare(SOURCE_DEFAULT_SHARE)
                  try {
                    window.localStorage.removeItem(SOURCE_SHARE_KEY)
                  } catch {
                    /* nothing was stored */
                  }
                }}
              />
            )}
            {narrow && (
              <button
                type="button"
                class="ghost back"
                onClick={() => setSourceTakesOver(false)}
              >
                ← Back to the text
              </button>
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
              onOutline={setOutline}
              onPage={setPdfPage}
              back={
                paperBefore
                  ? {
                      to: `p. ${paperBefore.page}${paperBeforeName ? ` of ${paperBeforeName}` : ''}`,
                      go: stepBackPaper,
                    }
                  : null
              }
              onJump={leavePage}
              inkNews={inkNews}
              onClose={() => {
                setOpenDocument(null)
                // No passage is on show any more, here or in the note.
                setHighlight(null)
                setSourceTakesOver(false)
              }}
            />
          </aside>
        )}

        <AskAbout
          available={state.agent.ready}
          passageIn={passageIn}
          onAsk={askAbout}
          // A reference is put into the text that is open: with none, there is nowhere.
          onCite={showMain ? (withQuote) => void insertReference(withQuote) : undefined}
        />

        {showChat ? (
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
              onCollapse={() => setShowChat(false)}
              downloads={state.settings?.downloads ?? 'ask'}
              onDownloads={(mode) => {
                // The server announces the change, and the state is read again.
                void api.setDownloads(mode).catch((error: unknown) => {
                  setInsertNotice(error instanceof Error ? error.message : String(error))
                })
              }}
            />
          </aside>
        ) : (
          <button
            type="button"
            class="rail rail-right"
            data-action="show-chat"
            title="Show the chat"
            onClick={() => setShowChat(true)}
          >
            <span aria-hidden="true">«</span>
            <span class="rail-label">Chat</span>
          </button>
        )}
      </div>
    </div>
  )
}
