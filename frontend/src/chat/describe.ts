/**
 * What a step was, in the reader's terms.
 *
 * The agent's tools are named for the code that implements them; a person
 * following along wants "read Mobility Restrictions, pp. 3–5", and wants a
 * click on it to open those pages. The raw call and its arguments are still
 * there, verbatim, in the transcript view.
 */

import type { ChangeEntry, Entry, ToolEntry, Turn } from './turns'

/** Somewhere in the project a step was about, that the interface can open. */
export type OpenTarget =
  | { kind: 'document'; documentId: string; page: number }
  | { kind: 'note'; noteId: string }
  | { kind: 'summary'; documentId: string }
  | { kind: 'reference'; referenceId: string }
  /** The summarizing skill: how the reader wants papers summarized. */
  | { kind: 'skill' }

export type Tone = '' | 'busy' | 'ok' | 'warn' | 'bad'

export interface Activity {
  verb: string
  target: string
  tone: Tone
  /** Longer than fits on the line: the refusal, the quotation in full. */
  detail?: string
  open?: OpenTarget
}

/** Titles for the IDs the tools speak in. */
export interface Names {
  document: (id: string) => string
  note: (id: string) => string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const shorten = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value

/** `[3, 4, 5, 9]` as "pp. 3–5, 9". */
export function pageRange(pages: unknown): string {
  const numbers = (Array.isArray(pages) ? pages : [pages])
    .map((page) => Number(page))
    .filter((page) => Number.isFinite(page))
    .sort((a, b) => a - b)
  if (numbers.length === 0) return ''
  const spans: string[] = []
  let start = numbers[0]!
  let end = start
  for (const page of numbers.slice(1)) {
    if (page <= end + 1) {
      end = page
      continue
    }
    spans.push(start === end ? `${start}` : `${start}–${end}`)
    start = end = page
  }
  spans.push(start === end ? `${start}` : `${start}–${end}`)
  return `${numbers.length === 1 ? 'p.' : 'pp.'} ${spans.join(', ')}`
}

/** The tags a step was kept to, for saying so: `field:labor, jmp:2026`. */
function tagList(value: unknown): string {
  return Array.isArray(value) ? value.map(String).filter(Boolean).join(', ') : ''
}

function count(result: Record<string, unknown> | null, one: string, many: string): string {
  const n = result?.count
  if (typeof n !== 'number') return ''
  return ` — ${n} ${n === 1 ? one : many}`
}

export function describeTool(entry: ToolEntry, names: Names): Activity {
  const { input, result } = entry
  const documentId = text(input.document_id)
  const noteId = text(input.note_id)
  const refusal = entry.isError ? text(result?.message) || 'This step failed.' : undefined
  const tone: Tone = !entry.finished ? 'busy' : entry.isError ? 'bad' : ''
  const base = { tone, detail: refusal }

  switch (entry.tool) {
    case 'list_documents': {
      const tags = tagList(input.tags)
      return {
        ...base,
        verb: 'listed',
        target: `${tags ? `papers tagged ${tags}` : 'the papers'}${count(result, 'paper', 'papers')}`,
      }
    }

    case 'tag_documents': {
      const ids = Array.isArray(input.document_ids) ? input.document_ids.map(String) : []
      const changes = [
        ...(Array.isArray(input.add) ? input.add : []).map((tag) => `+${String(tag)}`),
        ...(Array.isArray(input.remove) ? input.remove : []).map((tag) => `−${String(tag)}`),
      ].join(', ')
      const which = ids.length === 1 ? names.document(ids[0]!) : `${ids.length} papers`
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? 'tagged — refused' : 'tagged',
        target: changes ? `${which} — ${changes}` : which,
        open: ids.length === 1 ? { kind: 'document', documentId: ids[0]!, page: 1 } : undefined,
      }
    }

    case 'set_document_details': {
      const said = text(result?.cite_as) || text(result?.title)
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? 'named — refused' : 'named',
        target: said ? `${names.document(documentId)} — ${said}` : names.document(documentId),
        open: documentId ? { kind: 'document', documentId, page: 1 } : undefined,
      }
    }

    case 'delete_note':
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? 'deleted — refused' : 'deleted',
        // By the title it had: the note is gone, and with it its name.
        target: `note “${text(result?.title) || names.note(noteId)}”`,
      }

    case 'list_notes':
      return { ...base, verb: 'listed', target: 'the notes' }

    case 'search_documents': {
      const within = Array.isArray(input.document_ids) ? input.document_ids : []
      const tags = tagList(input.tags)
      const where =
        within.length === 1
          ? ` in ${names.document(String(within[0]))}`
          : tags
            ? ` in papers tagged ${tags}`
            : ''
      return {
        ...base,
        verb: 'searched',
        target: `“${shorten(text(input.query), 60)}”${where}${count(result, 'match', 'matches')}`,
      }
    }

    case 'recall': {
      const tags = tagList(input.tags)
      return {
        ...base,
        verb: 'recalled',
        target: `“${shorten(text(input.query), 60)}”${tags ? ` in papers tagged ${tags}` : ''}${count(
          result,
          'thing found',
          'things found',
        )}`,
      }
    }

    case 'read_pages': {
      const pages = (Array.isArray(input.pages) ? input.pages : [])
        .map(Number)
        .filter((page) => Number.isFinite(page))
      const range = pageRange(pages)
      return {
        ...base,
        verb: 'read',
        target: [names.document(documentId), range].filter(Boolean).join(', '),
        open: documentId
          ? { kind: 'document', documentId, page: pages.length > 0 ? Math.min(...pages) : 1 }
          : undefined,
      }
    }

    case 'read_note':
      return {
        ...base,
        verb: 'read',
        target: `note “${names.note(noteId)}”`,
        open: noteId ? { kind: 'note', noteId } : undefined,
      }

    case 'read_summary':
      return {
        ...base,
        verb: 'read',
        target: `summary of ${names.document(documentId)}`,
        open: documentId ? { kind: 'summary', documentId } : undefined,
      }

    case 'resolve_source': {
      const page = Number(input.page_number)
      const quote = text(result?.quote) || text(input.quote)
      const where = [names.document(documentId), Number.isFinite(page) ? `p. ${page}` : '']
        .filter(Boolean)
        .join(', ')
      const target = quote ? `${where} — “${shorten(quote, 70)}”` : where
      const status = text(result?.status)
      const referenceId = text(result?.reference_id)
      const fallback: OpenTarget | undefined = documentId
        ? { kind: 'document', documentId, page: Number.isFinite(page) ? page : 1 }
        : undefined
      if (!entry.finished) return { ...base, verb: 'locating', target, open: fallback }
      if (status === 'resolved' || status === 'page_only') {
        return {
          ...base,
          tone: 'ok',
          verb: status === 'resolved' ? 'cited' : 'cited the page',
          target,
          detail: quote || undefined,
          open: referenceId ? { kind: 'reference', referenceId } : fallback,
        }
      }
      // Not located: the agent was told, and is expected to quote again.
      return {
        ...base,
        tone: entry.isError ? 'bad' : 'warn',
        verb: status === 'ambiguous' ? 'found twice' : 'could not locate',
        target,
        detail: text(result?.message) || refusal,
        open: fallback,
      }
    }

    case 'write_note':
    case 'append_note':
    case 'patch_note': {
      const title = text(result?.title) || names.note(noteId)
      const verb = result?.created
        ? 'created'
        : entry.tool === 'patch_note'
          ? 'edited'
          : entry.tool === 'append_note'
            ? 'added to'
            : 'rewrote'
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? `${verb} — refused` : verb,
        target: `note “${title}”`,
        detail: refusal ?? (text(input.summary) || undefined),
        open: noteId ? { kind: 'note', noteId } : undefined,
      }
    }

    case 'read_skill':
      return {
        ...base,
        verb: 'read',
        target: 'how you want papers summarized',
        open: { kind: 'skill' },
      }

    case 'write_skill':
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? 'learned — refused' : 'learned',
        // What was learned, in the words it was recorded with.
        target: shorten(text(input.learned), 120) || 'how you want papers summarized',
        open: { kind: 'skill' },
      }

    case 'write_summary':
      return {
        ...base,
        tone: entry.finished && !entry.isError ? 'ok' : tone,
        verb: entry.isError ? 'wrote — refused' : 'wrote',
        target: `summary of ${names.document(documentId)}`,
        open: documentId ? { kind: 'summary', documentId } : undefined,
      }

    default: {
      const first = Object.values(input).find((value) => typeof value === 'string')
      return { ...base, verb: entry.tool, target: shorten(text(first), 80) }
    }
  }
}

export function describeChange(entry: ChangeEntry, names: Names): Activity {
  if (entry.targetKind === 'skill') {
    // What it says was learned is the line beside it; this names where it went.
    return {
      verb: 'learned',
      tone: 'ok',
      target: 'how you want papers summarized',
      detail: entry.summary || undefined,
      open: { kind: 'skill' },
    }
  }
  const isNote = entry.targetKind === 'note'
  if (isNote && entry.summary === 'Deleted note') {
    // Nothing to open: what the line names is no longer there.
    return { verb: 'deleted', tone: 'ok', target: `note “${names.note(entry.targetId)}”` }
  }
  return {
    verb: 'saved',
    tone: 'ok',
    target: isNote
      ? `note “${names.note(entry.targetId)}”`
      : `summary of ${names.document(entry.targetId)}`,
    detail: entry.summary || undefined,
    open: isNote
      ? { kind: 'note', noteId: entry.targetId }
      : { kind: 'summary', documentId: entry.targetId },
  }
}

/**
 * Who made an edit, as a reader would say it. The record keeps `user`,
 * `agent`, or `mcp:<client>` for a session elsewhere that wrote over MCP.
 */
export function describeOrigin(origin: string): { label: string; outside: boolean; title: string } {
  if (origin.startsWith('mcp:')) {
    const client = origin.slice(4) || 'another session'
    return {
      label: client,
      outside: true,
      title: `Written from outside Litmark, by a session calling itself “${client}” (over MCP)`,
    }
  }
  if (origin === 'user') return { label: 'you', outside: false, title: 'Saved from the editor' }
  if (origin === 'agent') {
    return { label: 'Litmark', outside: false, title: 'Written by the agent in this window' }
  }
  return { label: origin, outside: false, title: origin }
}

/* ----------------------------------------------------------- transcript */

function indent(value: string, by: string): string {
  return value
    .split('\n')
    .map((line) => `${by}${line}`)
    .join('\n')
}

const MAX_DETAIL_LINES = 20

function detail(value: Record<string, unknown>): string {
  const lines = Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined && item !== '')
    .map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
    .join('\n')
    .split('\n')
  const shown = lines.slice(0, MAX_DETAIL_LINES)
  if (lines.length > MAX_DETAIL_LINES) shown.push(`… ${lines.length - MAX_DETAIL_LINES} more lines`)
  return shown.join('\n')
}

/** One line of what came back, in the manner of a terminal log. */
function gist(entry: ToolEntry): string {
  if (!entry.finished) return 'running…'
  const result = entry.result ?? {}
  if (entry.isError) return text(result.message) || 'failed'
  if (typeof result.count === 'number') return `${result.count} found`
  if (text(result.status)) {
    const id = text(result.reference_id)
    return id ? `${text(result.status)} → ${id}` : text(result.status)
  }
  if (Array.isArray(result.pages)) return `${result.pages.length} page(s) of text`
  if (text(result.revision)) return `ok · revision ${text(result.revision).slice(0, 8)}`
  if (Array.isArray(result.notes)) return `${result.notes.length} note(s)`
  return 'ok'
}

export interface TranscriptLine {
  /** Styles the line: who is speaking, or what kind of step it was. */
  tone: 'rule' | 'user' | 'text' | 'tool' | 'result' | 'detail' | 'change' | 'notice' | 'error' | 'meta'
  text: string
}

export function usageLine(turn: Turn): string {
  const bits: string[] = [turn.status]
  const usage = turn.usage
  if (usage?.num_turns) bits.push(`${usage.num_turns} step${usage.num_turns === 1 ? '' : 's'}`)
  if (usage?.duration_ms) bits.push(`${(usage.duration_ms / 1000).toFixed(1)}s`)
  if (usage?.cost_usd) bits.push(`$${usage.cost_usd.toFixed(4)}`)
  return bits.join(' · ')
}

/** A turn the way a terminal session would show it: every step, in order. */
export function transcriptOf(turn: Turn): TranscriptLine[] {
  const lines: TranscriptLine[] = [{ tone: 'rule', text: `──── ${turn.runId} ────` }]
  if (turn.prompt !== null) lines.push({ tone: 'user', text: `› ${turn.prompt}` })
  else if (turn.label) lines.push({ tone: 'user', text: `› (${turn.label})` })

  const push = (entry: Entry): void => {
    switch (entry.kind) {
      case 'text':
        lines.push({ tone: 'text', text: `● ${entry.text}${entry.unfinished ? ' ⋯' : ''}` })
        break
      case 'tool': {
        lines.push({ tone: entry.isError ? 'error' : 'tool', text: `⏵ ${entry.tool}` })
        const args = detail(entry.input)
        if (args) lines.push({ tone: 'detail', text: indent(args, '    ') })
        lines.push({ tone: entry.isError ? 'error' : 'result', text: `  ⎿ ${gist(entry)}` })
        break
      }
      case 'change':
        lines.push({
          tone: 'change',
          text: `✎ ${entry.targetKind} ${entry.targetId}${entry.summary ? ` — ${entry.summary}` : ''}`,
        })
        break
      case 'notice':
        lines.push({ tone: 'notice', text: `  ${entry.text}` })
        break
    }
  }
  turn.entries.forEach(push)
  if (turn.streaming) lines.push({ tone: 'text', text: `● ${turn.streaming}▍` })
  if (turn.error) lines.push({ tone: 'error', text: `✗ ${turn.error}` })
  if (turn.status !== 'queued' && turn.status !== 'running') {
    lines.push({ tone: 'meta', text: `──── ${usageLine(turn)} ────` })
  }
  return lines
}
