/**
 * The ink on the paper that is open: read when it opens, held while it is
 * drawn on, and saved a moment after each change.
 *
 * The strokes on screen are this window's own, and are ahead of the server
 * between a stroke and its save. A save says which revision it was made on;
 * when another window has saved since — the desk beside the tablet — the
 * server refuses it, and what was done here is done again on what the other
 * window saved (`rebase` in `ink.ts`), then saved. The same happens when the
 * server says the ink has moved while nothing here was waiting.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { api, ApiError } from '../api'
import {
  applyChange,
  NO_HISTORY,
  rebase,
  record,
  redo,
  sameStrokes,
  undo,
  type InkChange,
  type InkHistory,
  type Stroke,
} from './ink'

/** After the last change, so that a word written in one go is one save. */
const SAVE_DELAY_MS = 800
const RETRY_DELAY_MS = 5000
/** Browsers refuse a body past 64 KiB on a request that is to outlive its page. */
const KEEPALIVE_LIMIT = 60_000

/** Word from the server that a paper's ink is at a revision — or just that it moved. */
export interface InkNews {
  /** The paper it is about; null when it could be any of them. */
  documentId: string | null
  revision: string | null
  /** Changes with every piece of news, so the same revision told twice is still heard. */
  tick: number
}

export interface InkState {
  strokes: Stroke[]
  /** `unavailable`: the ink could not be read, so none is shown and none is saved over it. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Why, when it is unavailable. */
  problem: string | null
  /** Whether a save has failed and is waiting to be tried again. */
  unsaved: boolean
  canUndo: boolean
  canRedo: boolean
  draw: (stroke: Stroke) => void
  erase: (ids: string[]) => void
  undo: () => void
  redo: () => void
  /** Whether there are strokes here that the server does not have yet. */
  waiting: () => boolean
  /** Save what is waiting, now. Resolves once the server has it, or has refused. */
  flush: () => Promise<void>
}

/** One paper's ink, for as long as it is open. Nothing of the page in it. */
class Session {
  /** The strokes at the revision held: what the server has, as far as is known. */
  saved: Stroke[] = []
  revision: string | null = null
  local: Stroke[] = []
  history: InkHistory = NO_HISTORY
  ready = false
  closed = false
  private timer: number | null = null
  private saving: Promise<void> | null = null

  constructor(
    readonly documentId: string,
    private readonly show: (session: Session, failed: boolean) => void,
  ) {}

  get dirty(): boolean {
    return this.ready && !sameStrokes(this.local, this.saved)
  }

  change(change: InkChange, history: InkHistory): void {
    this.local = applyChange(this.local, change)
    this.history = history
    this.changed()
  }

  /** Something here is different: show it, and save it shortly. */
  changed(): void {
    this.show(this, false)
    this.schedule(SAVE_DELAY_MS)
  }

  private schedule(delay: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.save()
    }, delay)
  }

  /** Take in what another window saved, keeping what was done here since. */
  private adopt(theirs: Stroke[], revision: string | null): void {
    this.local = rebase(this.saved, this.local, theirs)
    this.saved = theirs
    this.revision = revision
    this.show(this, false)
  }

  /** The ink moved on the server. Read it, unless it is our own save being told back. */
  async heard(revision: string | null): Promise<void> {
    if (!this.ready) return
    // A save on its way settles first: it may be the very one the news is of,
    // or be refused for it and read the ink itself.
    if (this.saving) await this.saving
    if (this.closed || (revision !== null && revision === this.revision)) return
    try {
      const theirs = await api.ink(this.documentId)
      if (this.closed || theirs.revision === this.revision) return
      this.adopt(theirs.strokes, theirs.revision)
      if (this.dirty) this.schedule(SAVE_DELAY_MS)
    } catch {
      /* The next save, or the next news, reads it again. */
    }
  }

  save(leaving = false): Promise<void> {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    if (this.saving) {
      // One at a time: the second would be refused for the first's revision.
      return this.saving.then(() => (this.dirty ? this.save(leaving) : undefined))
    }
    if (!this.dirty) return Promise.resolve()
    const sending = this.local
    const small = JSON.stringify(sending).length < KEEPALIVE_LIMIT
    let refused = false
    this.saving = (async () => {
      try {
        const { revision } = await api.saveInk(
          this.documentId,
          sending,
          this.revision,
          leaving && small,
        )
        this.saved = sending
        this.revision = revision
        this.show(this, false)
      } catch (error) {
        if (!(error instanceof ApiError && error.isConflict)) throw error
        // Another window saved first. Put what was done here on what it saved.
        refused = true
        const theirs = await api.ink(this.documentId)
        this.adopt(theirs.strokes, theirs.revision)
      }
    })()
      .catch(() => {
        // Offline, or the server is restarting. The strokes stay on screen,
        // marked as not saved, and are sent again.
        if (!this.closed) {
          this.show(this, true)
          this.schedule(RETRY_DELAY_MS)
        }
      })
      .finally(() => {
        this.saving = null
        if (!this.dirty || this.timer !== null) return
        // Drawn on while it was being saved, or put back on another window's.
        if (!this.closed) this.schedule(SAVE_DELAY_MS)
        // Closed since, and refused: what was put back is still owed.
        else if (refused) void this.save(leaving)
      })
    return this.saving
  }

  /** The paper is being closed: save what is waiting, and say no more about it. */
  close(): void {
    void this.save(true)
    this.closed = true
  }
}

export function useInk(documentId: string, news: InkNews | null): InkState {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [history, setHistory] = useState<InkHistory>(NO_HISTORY)
  const [status, setStatus] = useState<InkState['status']>('loading')
  const [problem, setProblem] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const session = useRef<Session | null>(null)

  useEffect(() => {
    const current = new Session(documentId, (from, failed) => {
      if (session.current !== from) return
      setStrokes(from.local)
      setHistory(from.history)
      setUnsaved(failed)
    })
    session.current = current
    setStrokes([])
    setHistory(NO_HISTORY)
    setStatus('loading')
    setProblem(null)
    setUnsaved(false)

    api.ink(documentId).then(
      (ink) => {
        if (current.closed) return
        current.saved = ink.strokes
        current.local = ink.strokes
        current.revision = ink.revision
        current.ready = true
        setStrokes(ink.strokes)
        setStatus('ready')
      },
      (error: unknown) => {
        if (current.closed) return
        setStatus('unavailable')
        setProblem(error instanceof Error ? error.message : 'The ink could not be read.')
      },
    )

    // Leaving the page, or putting the tablet down: there may be no later.
    const leaving = (): void => {
      if (document.visibilityState === 'hidden') void current.save(true)
    }
    const gone = (): void => void current.save(true)
    document.addEventListener('visibilitychange', leaving)
    window.addEventListener('pagehide', gone)
    return () => {
      document.removeEventListener('visibilitychange', leaving)
      window.removeEventListener('pagehide', gone)
      current.close()
      if (session.current === current) session.current = null
    }
  }, [documentId])

  useEffect(() => {
    if (news && (news.documentId === null || news.documentId === documentId)) {
      void session.current?.heard(news.revision)
    }
  }, [news?.tick, documentId])

  const change = useCallback((change: InkChange): void => {
    const current = session.current
    if (!current?.ready) return
    current.change(change, record(current.history, change))
  }, [])

  const step = useCallback((back: boolean): void => {
    const current = session.current
    if (!current?.ready) return
    const stepped = back
      ? undo(current.local, current.history)
      : redo(current.local, current.history)
    if (!stepped) return
    current.local = stepped.strokes
    current.history = stepped.history
    current.changed()
  }, [])

  return {
    strokes,
    status,
    problem,
    unsaved,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    draw: useCallback((stroke: Stroke) => change({ add: [stroke], remove: [] }), [change]),
    erase: useCallback(
      (ids: string[]) => {
        const gone = new Set(ids)
        const remove = (session.current?.local ?? []).filter((stroke) => gone.has(stroke.id))
        if (remove.length > 0) change({ add: [], remove })
      },
      [change],
    ),
    undo: useCallback(() => step(true), [step]),
    redo: useCallback(() => step(false), [step]),
    waiting: useCallback(() => session.current?.dirty ?? false, []),
    flush: useCallback(() => session.current?.save() ?? Promise.resolve(), []),
  }
}
