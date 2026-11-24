/**
 * Where the project stands with its git remote and its paper storage.
 *
 * The application commits and exchanges on its own, so most of the time this
 * is one quiet word in the top bar. It speaks up when there is something to
 * know: edits not yet saved to git, a remote that could not be reached, or the
 * one case that needs a decision — the same lines changed here and elsewhere.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import type { SyncState } from './api'
import { ago } from './chat/ConversationMenu'

export interface SyncStatusProps {
  sync: SyncState
  onSync: (resolve?: 'mine' | 'theirs') => Promise<void>
  onOpened: () => void
}

function summary(sync: SyncState, busy: boolean): { label: string; tone: string } {
  const git = sync.git
  if (busy || sync.running) return { label: 'Syncing…', tone: 'busy' }
  if (git.state === 'conflict') return { label: 'Needs a decision', tone: 'bad' }
  if (git.state === 'error' || sync.storage.error) return { label: 'Sync problem', tone: 'warn' }
  if (sync.storage.problem) return { label: 'Storage problem', tone: 'warn' }
  if (git.state === 'dirty') return { label: `${git.dirty} to save`, tone: 'pending' }
  if (git.state === 'ahead') return { label: `${git.ahead} to publish`, tone: 'pending' }
  if (git.state === 'behind') return { label: `${git.behind} to bring in`, tone: 'pending' }
  if (git.state === 'local') return { label: 'Saved locally', tone: 'ok' }
  if (git.state === 'synced') return { label: 'Synced', tone: 'ok' }
  return { label: 'Papers synced', tone: 'ok' }
}

export function SyncStatus({ sync, onSync, onOpened }: SyncStatusProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const { git, storage } = sync
  // Neither git nor storage: there is nothing to say, so say nothing.
  if (git.state === 'off' && !storage.enabled && !storage.problem) return null

  const run = async (resolve?: 'mine' | 'theirs'): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await onSync(resolve)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Sync failed.')
    } finally {
      setBusy(false)
    }
  }

  const { label, tone } = summary(sync, busy)
  return (
    <div class="sync-wrap" ref={wrap}>
      <button
        type="button"
        class={`sync-button ${tone}${open ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Where the project stands with git and paper storage"
        onClick={() => {
          if (!open) onOpened()
          setOpen(!open)
        }}
      >
        <span class={`dot ${tone === 'busy' ? 'working' : tone}`} />
        {label}
      </button>

      {open && (
        <div class="sync-panel" role="dialog" aria-label="Sync">
          {git.state !== 'off' && (
            <section>
              <div class="menu-kicker">Text · git</div>
              {/* The conflict has a box of its own below; do not say it twice. */}
              <div class="sync-line">
                {git.conflict ? 'Waiting for you to choose a side' : git.message}
              </div>
              {git.remote ? (
                <div class="menu-note">
                  {git.remote} · {git.branch}
                </div>
              ) : (
                <div class="menu-note">
                  No remote. Add one with <code>litmark sync --git-remote URL</code>.
                </div>
              )}
              {git.last_commit && (
                <div class="menu-note" title={git.last_commit.sha}>
                  Last saved: “{git.last_commit.subject}” · {ago(git.last_commit.committed_at)}
                </div>
              )}
              {git.automatic === false && (
                <div class="menu-note">Automatic sync is off; use the button below.</div>
              )}
              {git.conflict && (
                <div class="sync-conflict">
                  <p>
                    Changed both here and on the remote:{' '}
                    <strong>{git.conflict.files.join(', ')}</strong>. Keep which version of the
                    lines that clash? Everything else from both sides is kept, and the other
                    version stays in the history.
                  </p>
                  <div class="sync-choices">
                    <button type="button" disabled={busy} onClick={() => void run('mine')}>
                      Keep this copy’s
                    </button>
                    <button type="button" disabled={busy} onClick={() => void run('theirs')}>
                      Keep the remote’s
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {(storage.enabled || storage.problem) && (
            <section>
              <div class="menu-kicker">Papers · storage</div>
              {storage.enabled ? (
                <>
                  <div class="sync-line">{storage.where}</div>
                  <div class="menu-note">
                    {storage.pdfs_here} of {storage.documents} PDFs on this machine
                    {storage.pdfs_here < storage.documents ? '; the rest are fetched when opened' : ''}
                  </div>
                </>
              ) : (
                <div class="sync-problem">{storage.problem}</div>
              )}
              {storage.error && <div class="sync-problem">{storage.error}</div>}
            </section>
          )}

          {problem !== null && (
            <div class="sync-problem" role="alert">
              {problem}
            </div>
          )}
          <div class="sync-foot">
            <span class="menu-note">
              {git.synced_at ? `Checked ${ago(git.synced_at)}` : 'Not checked yet this session'}
            </span>
            <button type="button" class="primary" disabled={busy} onClick={() => void run()}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
