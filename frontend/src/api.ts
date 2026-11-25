/**
 * Typed client for the local server.
 *
 * Every request carries the per-process session credential that the server
 * injected into this page, so an unrelated website cannot drive the API.
 */

const TOKEN_META = 'meta[name="litmark-token"]'

let sessionToken = document.querySelector<HTMLMetaElement>(TOKEN_META)?.content ?? ''

/** The credential to send now. It changes when the server restarts. */
export const getSessionToken = (): string => sessionToken

let refreshing: Promise<boolean> | null = null

/**
 * Pick up the server's current credential by reading the page again.
 *
 * The credential is made afresh each time the server starts, so a page left
 * open across a restart holds one the server no longer accepts: every request
 * is refused, and the page looks frozen though the server is fine. The page
 * the server serves carries the current one — reading it is what a reload
 * would do, without losing what is on screen. Resolves to whether it changed.
 */
export function refreshSessionToken(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } })
      if (!response.ok) return false
      const page = new DOMParser().parseFromString(await response.text(), 'text/html')
      const fresh = page.querySelector<HTMLMetaElement>(TOKEN_META)?.content ?? ''
      if (!fresh || fresh === sessionToken) return false
      sessionToken = fresh
      return true
    } catch {
      return false // The server is not there to ask; the caller reports that.
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

let leaving = false

/** Leave for the sign-in page, once, remembering where to come back to. */
export function goToSignIn(): void {
  if (leaving) return
  leaving = true
  const here = window.location.pathname + window.location.search
  window.location.assign(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`)
}

export interface ApiErrorBody {
  code: string
  message: string
  expected_revision?: string | null
  actual_revision?: string | null
  current_text?: string | null
  proposed_text?: string | null
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.status = status
    this.body = body
  }

  get isConflict(): boolean {
    return this.status === 409
  }
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('x-litmark-token', sessionToken)
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(`/api${path}`, { ...init, headers })
  if (response.status === 204) return undefined as T
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const body: ApiErrorBody = payload?.error ?? {
      code: 'http_error',
      message: `${response.status} ${response.statusText}`,
    }
    // Refused for its credential: the server has restarted since this page
    // loaded. Fetch the new one and ask again, once.
    if (response.status === 401 && body.code === 'unauthorized' && !retried) {
      if (await refreshSessionToken()) return request<T>(path, init, true)
    }
    // No longer signed in — the session lapsed, or was ended elsewhere: to the
    // form, and back to this place afterwards.
    if (response.status === 401 && body.code === 'login_required') goToSignIn()
    throw new ApiError(response.status, body)
  }
  return payload as T
}

// ----------------------------------------------------------------- types

export interface NoteSummary {
  note_id: string
  title: string
  revision: string
  modified_at: string
}

/** The summarizing skill: how this reader wants papers summarized. */
export interface Skill {
  name: string
  text: string
  revision: string
  /** False while it is still what every project starts with. */
  customised: boolean
}

/** The papers a note cites or names, most leaned-on first. */
export interface RelatedToNote {
  papers: { document_id: string; count: number }[]
}

/** What a paper is tied to: notes about it, papers around it. */
export interface RelatedToPaper {
  notes: { note_id: string; title: string; count: number }[]
  mentions: { document_id: string; count: number }[]
  mentioned_by: { document_id: string; count: number }[]
  same_tags: { document_id: string; tags: string[] }[]
}

export interface Note extends NoteSummary {
  text: string
}

export interface DocumentRecord {
  document_id: string
  sha256: string
  original_filename: string
  display_title: string
  /** How the paper is spoken of — `Olley & Pakes (1996)` — when its authors are known. */
  label: string | null
  /** Who said what the title, authors and year are; null while it is only the PDF's word. */
  details_by: string | null
  title: string | null
  authors: string | null
  year: number | null
  page_count: number | null
  byte_size: number
  imported_at: string
  /** The user's own labels; `group:value` by convention, e.g. `field:labor`. */
  tags: string[]
  searchable: boolean
  extraction: {
    status: 'pending' | 'running' | 'ok' | 'failed'
    quality: 'ok' | 'partial' | 'none' | null
    warnings: string[]
    empty_pages?: number[]
    error: string | null
    kind?: string
    encrypted?: boolean
  }
  summary: {
    status: 'none' | 'queued' | 'ready' | 'failed' | 'unavailable'
    error: string | null
    generated_at: string | null
  }
  summary_text?: string | null
  summary_revision?: string
}

export interface TagCount {
  tag: string
  /** How many papers carry it. */
  count: number
}

export interface AgentStatus {
  backend: string
  installed: boolean
  authenticated: boolean
  ready: boolean
  message: string
  detail: string | null
  /** Models a session may pick by name; any other can be typed. */
  models?: string[]
  /** Effort levels a session may pick. */
  efforts?: string[]
  /** What a session gets when it picks nothing. */
  default_model?: string | null
  default_effort?: string | null
}

/** Whether the agent may fetch papers from the web. */
export type DownloadMode = 'always' | 'ask' | 'never'

/** The reader's answer when the agent asks leave to do something. */
export type PermissionAnswer = 'allow' | 'always' | 'deny'

export interface ProjectState {
  project: { name: string; root: string; schema_version: number }
  agent: AgentStatus
  documents: DocumentRecord[]
  tags: TagCount[]
  notes: NoteSummary[]
  conversations: ConversationSummary[]
  latest_seq: number
  settings?: { downloads: DownloadMode }
  /** Whether the server asks for a password, and so has a session to end. */
  auth?: { password: boolean }
}

export interface PageRecord {
  page_number: number
  page_label: string | null
  width: number
  height: number
  rotation: number
  warnings: string[]
  text: string
}

export interface Citation {
  kind: 'note' | 'summary'
  id: string
  title: string
}

export interface ReferenceRecord {
  reference_id: string
  document_id: string
  document_sha256: string
  page_number: number
  page_label?: string | null
  status: 'resolved' | 'ambiguous' | 'not_found' | 'page_only' | 'missing_source'
  quote?: string | null
  rects?: number[][]
  coordinate_space: string
  note?: string | null
  document_title?: string
  document_sha256_matches?: boolean
  missing_source?: boolean
  message?: string
  /** Notes and summaries whose Markdown cites this reference. */
  cited_by?: Citation[]
}

export interface BibEntry {
  key: string
  document_id: string
  title: string
  entry_type: string
  fields: Record<string, string>
  /** Metadata the PDF did not supply; omitted from the entry, never guessed. */
  unknown_fields: string[]
  reference_ids: string[]
  bibtex: string
}

export interface BibCitation {
  reference_id: string
  key: string
  document_id: string
  page_number: number
  page_label: string | null
  /** The LaTeX command for this passage, e.g. `\cite[p.~12]{key}`. */
  cite: string
  cited_by: Citation[]
}

export interface Bibliography {
  entries: BibEntry[]
  citations: BibCitation[]
  warnings: string[]
  bibtex: string
}

export interface SearchHit {
  document_id: string
  document_title: string
  page_number: number
  page_label: string | null
  snippet: string
  quote: string
  score: number
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ConversationSummary {
  conversation_id: string
  title: string
  /** 'chat' is the user's own; 'system' collects background work (summaries). */
  kind: 'chat' | 'system'
  created_at: string
  updated_at: string
  /** How many runs it has had, whatever became of them. */
  turn_count: number
  status: 'running' | 'queued' | 'idle'
  last_run_status: RunStatus | null
  resumable: boolean
  /** Not yet named for anything asked in it. */
  untitled?: boolean
  /** What was on screen with it, as a window last left it; read with `readView`. */
  view?: unknown
  /** Put away: out of the row of sessions, with nothing of it gone. */
  closed?: boolean
  /** Chosen for this session; null is the project's default. */
  model?: string | null
  effort?: string | null
}

export interface RunUsage {
  duration_ms?: number
  num_turns?: number
  /** What this turn cost. */
  cost_usd?: number
  /** What the agent's session has cost so far, this turn included. */
  session_cost_usd?: number
}

/** One run as the server kept it: what was asked, and every durable event. */
export interface TurnRecord {
  run_id: string
  status: RunStatus
  kind: string
  label: string | null
  error: string | null
  usage: RunUsage | null
  started_at: string
  ended_at: string | null
  message: ChatMessage | null
  reply: string | null
  events: RunEvent[]
}

export type RunEvent = {
  seq?: number
  type: string
  conversation_id: string | null
  run_id: string | null
  created_at?: string
} & Record<string, unknown>

export interface ChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  run_id: string | null
  context: Record<string, unknown> | null
  created_at: string
}

export interface RunRecord {
  run_id: string
  status: string
  kind: string
  error: string | null
  started_at: string
  ended_at: string | null
}

export interface Conversation extends ConversationSummary {
  backend_session_id: string | null
  messages: ChatMessage[]
  runs: RunRecord[]
  turns: TurnRecord[]
  /** The newest event when this was read; anything later arrives on the stream. */
  latest_seq: number
}

export interface ChangeRecord {
  change_id: string
  target_kind: string
  target_id: string
  origin: string
  summary: string
  base_revision: string | null
  new_revision: string | null
  undoable: boolean
  undone_at: string | null
  created_at: string
}

/** Where a selection sent with a message was made: a note, a summary, a page of a paper. */
export interface SelectionIn {
  kind: 'note' | 'summary' | 'paper'
  /** The note's ID; for a summary or a paper, the document's. */
  id: string
  /** For a paper: the page of the PDF, counted from one. */
  page?: number
}

export interface MessageContext {
  note_id?: string | null
  note_revision?: string | null
  selection?: string | null
  /** Where `selection` was made, so the agent need not go looking for it. */
  selection_in?: SelectionIn | null
  document_ids?: string[]
  reference_id?: string | null
  page_number?: number | null
}

/** Where the text stands with git, and the papers with storage. */
export interface SyncState {
  git: {
    enabled: boolean
    automatic?: boolean
    /** 'off' when the project is not a repository litmark manages. */
    state: 'off' | 'synced' | 'local' | 'dirty' | 'ahead' | 'behind' | 'conflict' | 'error'
    message: string | null
    branch?: string
    remote?: string | null
    dirty?: number
    ahead?: number
    behind?: number
    conflict?: { files: string[]; side_branch: string | null; message: string } | null
    last_commit?: { sha: string; subject: string; committed_at: string } | null
    synced_at?: string | null
  }
  storage: {
    enabled: boolean
    backend: string | null
    where: string | null
    problem: string | null
    prefetch: boolean
    documents: number
    pdfs_here: number
    synced_at: string | null
    error: string | null
  }
  running: boolean
}

/** The version running, and a later one if one has been released. */
export interface VersionInfo {
  version: string
  /** Whether the server asks about later releases at all. */
  checks_for_updates: boolean
  /** The latest release known; null until the server has an answer. */
  latest: string | null
  update_available: boolean
  release_url: string | null
}

// ------------------------------------------------------------------- api

export const api = {
  state: () => request<ProjectState>('/state'),
  version: () => request<VersionInfo>('/version'),

  listNotes: () => request<{ notes: NoteSummary[] }>('/notes'),
  readNote: (id: string) => request<Note>(`/notes/${encodeURIComponent(id)}`),
  createNote: (title: string, text?: string) =>
    request<Note>('/notes', { method: 'POST', body: JSON.stringify({ title, text }) }),
  saveNote: (id: string, text: string, expected_revision: string | null) =>
    request<Note>(`/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ text, expected_revision }),
    }),
  deleteNote: (id: string, revision?: string | null) =>
    request<void>(
      `/notes/${encodeURIComponent(id)}${
        revision ? `?expected_revision=${encodeURIComponent(revision)}` : ''
      }`,
      { method: 'DELETE' },
    ),

  listDocuments: () => request<{ documents: DocumentRecord[] }>('/documents'),
  getDocument: (id: string) => request<DocumentRecord>(`/documents/${encodeURIComponent(id)}`),
  uploadDocuments: (files: File[], tags: string[] = []) => {
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    // Papers imported into a collection arrive already carrying its tags.
    const query = tags.map((tag) => `tags=${encodeURIComponent(tag)}`).join('&')
    return request<{
      imported: { document: DocumentRecord; duplicate: boolean }[]
      errors: { filename: string; message: string }[]
    }>(`/documents${query ? `?${query}` : ''}`, { method: 'POST', body: form })
  },
  setTags: (id: string, tags: string[]) =>
    request<DocumentRecord>(`/documents/${encodeURIComponent(id)}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    }),
  tagDocuments: (document_ids: string[], add: string[], remove: string[] = []) =>
    request<{ changed: string[]; tags: TagCount[] }>('/documents/tags', {
      method: 'POST',
      body: JSON.stringify({ document_ids, add, remove }),
    }),
  pdfUrl: (id: string) =>
    `/api/documents/${encodeURIComponent(id)}/pdf?token=${encodeURIComponent(getSessionToken())}`,
  pages: (id: string) =>
    request<{
      document_id: string
      page_count: number
      quality: string
      warnings: string[]
      pages: PageRecord[]
    }>(`/documents/${encodeURIComponent(id)}/pages`),
  summary: (id: string) =>
    request<{
      document_id: string
      text: string | null
      revision: string | null
      status: string
      error: string | null
      extraction_quality: string | null
      extraction_warnings: string[]
    }>(`/documents/${encodeURIComponent(id)}/summary`),
  saveSummary: (id: string, text: string, expected_revision: string | null) =>
    request<{ document_id: string; revision: string }>(
      `/documents/${encodeURIComponent(id)}/summary`,
      { method: 'PUT', body: JSON.stringify({ text, expected_revision }) },
    ),
  reextract: (id: string) =>
    request<{ job_id: string }>(`/documents/${encodeURIComponent(id)}/extract`, {
      method: 'POST',
    }),
  summarize: (id: string) =>
    request<{ queued: boolean; run_id?: string; reason?: string }>(
      `/documents/${encodeURIComponent(id)}/summarize`,
      { method: 'POST' },
    ),
  /** End the session in this browser, and go back to the sign-in page. */
  signOut: async (): Promise<void> => {
    try {
      await fetch('/logout', { method: 'POST', redirect: 'manual' })
    } finally {
      window.location.assign('/login')
    }
  },
  skill: () => request<Skill>('/skills/summary'),
  saveSkill: (text: string, expected_revision: string | null) =>
    request<Skill>('/skills/summary', {
      method: 'PUT',
      body: JSON.stringify({ text, expected_revision }),
    }),
  relatedToNote: (id: string) =>
    request<RelatedToNote>(`/related?note_id=${encodeURIComponent(id)}`),
  relatedToPaper: (id: string) =>
    request<RelatedToPaper>(`/related?document_id=${encodeURIComponent(id)}`),
  setDetails: (
    id: string,
    details: { title?: string; authors?: string; year?: number },
  ) =>
    request<DocumentRecord>(`/documents/${encodeURIComponent(id)}/details`, {
      method: 'PUT',
      body: JSON.stringify(details),
    }),
  deleteDocument: (id: string) =>
    request<{ deleted: string; references_marked_missing: string[] }>(
      `/documents/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  search: (query: string) =>
    request<{ query: string; passages: SearchHit[]; notes: { note_id: string; title: string; snippet: string }[] }>(
      `/search?q=${encodeURIComponent(query)}`,
    ),

  listReferences: (documentId?: string) =>
    request<{ references: ReferenceRecord[] }>(
      documentId ? `/references?document_id=${encodeURIComponent(documentId)}` : '/references',
    ),
  getReference: (id: string) => request<ReferenceRecord>(`/references/${encodeURIComponent(id)}`),
  createReference: (payload: {
    document_id: string
    page_number: number
    quote?: string
    prefix?: string
    suffix?: string
    start?: number
    end?: number
    allow_page_only?: boolean
  }) =>
    request<ReferenceRecord & { markdown_link: string; message: string | null }>('/references', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  bibliography: (citedOnly = false) =>
    request<Bibliography>(`/bibliography?cited_only=${citedOnly}`),
  writeBibliography: (citedOnly = false) =>
    request<{ path: string; entries: number; written: boolean; warnings: string[] }>(
      '/bibliography',
      { method: 'POST', body: JSON.stringify({ cited_only: citedOnly }) },
    ),
  bibliographyUrl: (citedOnly = false) =>
    `/api/bibliography?format=bibtex&cited_only=${citedOnly}&token=${encodeURIComponent(getSessionToken())}`,

  conversation: (id: string) => request<Conversation>(`/conversations/${encodeURIComponent(id)}`),
  listConversations: () =>
    request<{ conversations: ConversationSummary[] }>('/conversations'),
  createConversation: (title?: string) =>
    request<Conversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    }),
  renameConversation: (id: string, title: string) =>
    request<ConversationSummary>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  /** Remember what is on screen with a session. Sent even as the page is left. */
  saveView: (id: string, view: unknown) =>
    request<void>(`/conversations/${encodeURIComponent(id)}/view`, {
      method: 'PUT',
      body: JSON.stringify({ view }),
      keepalive: true,
    }),
  setClosed: (id: string, closed: boolean) =>
    request<ConversationSummary>(`/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ closed }),
    }),
  deleteConversation: (id: string) =>
    request<{ conversation_id: string; deleted: boolean }>(
      `/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  sendMessage: (id: string, prompt: string, context: MessageContext) =>
    request<{ run_id: string; conversation_id: string; status: string }>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: JSON.stringify({ prompt, context }) },
    ),
  setAgentChoice: (id: string, model: string | null, effort: string | null) =>
    request<ConversationSummary>(`/conversations/${encodeURIComponent(id)}/agent`, {
      method: 'PUT',
      body: JSON.stringify({ model, effort }),
    }),
  setDownloads: (downloads: DownloadMode) =>
    request<{ downloads: DownloadMode }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ downloads }),
    }),
  answerPermission: (requestId: string, answer: PermissionAnswer) =>
    request<{ request_id: string; answer: string }>(
      `/permissions/${encodeURIComponent(requestId)}`,
      { method: 'POST', body: JSON.stringify({ answer }) },
    ),
  cancelRun: (runId: string) =>
    request<{ run_id: string; status: string }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
  exportUrl: (id: string, format: 'markdown' | 'json') =>
    `/api/conversations/${encodeURIComponent(id)}/export?format=${format}&token=${encodeURIComponent(getSessionToken())}`,

  syncStatus: () => request<SyncState>('/sync'),
  syncNow: (resolve?: 'mine' | 'theirs') =>
    request<SyncState & { pulled: string[]; problems: string[] }>('/sync', {
      method: 'POST',
      body: JSON.stringify(resolve ? { resolve } : {}),
    }),

  changes: () => request<{ changes: ChangeRecord[] }>('/changes'),
  undo: (changeId: string, expected_revision?: string) =>
    request<{ change_id: string; revision: string; undone: boolean }>(
      `/changes/${encodeURIComponent(changeId)}/undo`,
      { method: 'POST', body: JSON.stringify({ expected_revision: expected_revision ?? null }) },
    ),
}
