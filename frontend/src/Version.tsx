/**
 * Which version is running, at the end of the top bar.
 *
 * Mostly one quiet number: enough to see, after a deploy, that the server is
 * the one meant. Two things make it speak up. A later release than the one
 * running puts a small mark beside it, leading to what changed. And a server
 * updated beneath a page left open — the number changes while the page is the
 * old one — offers to reload, which is what brings the new page in.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { api, type VersionInfo } from './api'

const ASK_EVERY_MS = 60 * 60 * 1000

export function Version({ connected }: { connected: boolean }) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  /** The version this page was loaded from: the first one the server gave. */
  const loaded = useRef<string | null>(null)

  // Asked on arrival, each time the server comes back (a restart is when the
  // version changes), and now and then for a page left open.
  useEffect(() => {
    let stopped = false
    const ask = (): void => {
      api
        .version()
        .then((next) => {
          if (stopped) return
          loaded.current ??= next.version
          setInfo(next)
        })
        .catch(() => {
          // Not worth a word: the number stays as it was, or is not shown.
        })
    }
    ask()
    const timer = window.setInterval(ask, ASK_EVERY_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [connected])

  if (!info) return null
  const stale = loaded.current !== null && loaded.current !== info.version

  return (
    <span class="version">
      <span
        class="version-number"
        title={
          info.update_available
            ? `Litmark ${info.version} is running; ${info.latest} has been released`
            : info.latest
              ? `Litmark ${info.version}, the latest release`
              : `Litmark ${info.version}`
        }
      >
        v{info.version}
      </span>
      {stale && (
        <button
          type="button"
          class="version-reload"
          data-action="reload"
          title={`The server is now ${info.version}; this page was loaded from ${loaded.current}. Reload to bring it up to date.`}
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      )}
      {info.update_available && info.release_url && (
        <a
          class="version-update"
          href={info.release_url}
          target="_blank"
          rel="noreferrer"
          title={`Litmark ${info.latest} is available — see what changed`}
          aria-label={`Litmark ${info.latest} is available — see what changed`}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path
              d="M8 11.5v-7M5 7.3l3-3 3 3"
              fill="none"
              stroke="var(--panel)"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </a>
      )}
    </span>
  )
}
