/**
 * A small Markdown renderer for read-only surfaces (chat bubbles).
 *
 * The note editor never uses this — it renders in place over the real source.
 * Here the input can include agent output, so the text is HTML-escaped first
 * and only a fixed set of constructs is re-introduced. Link destinations are
 * restricted to `http(s)`, `mailto:`, and the application's own `source:`,
 * `paper:` and `note:` schemes, so no `javascript:` URL can survive.
 */

import katex from 'katex'

const ALLOWED_SCHEME = /^(https?:\/\/|mailto:)/i

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderMath(text: string): string {
  // Display math first, so `$$…$$` is not consumed by the inline rule.
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => katexOrRaw(tex, true))
    .replace(
      // Inline math, told from money as Pandoc tells them: no whitespace
      // just inside either `$`, and no digit just after the closing one. That
      // leaves "it cost $5 and then $7" and "$5–$7" as prose, and lets a
      // number be math — `$0.758$`, which is how an estimate is written.
      /(^|[^\\$])\$(?!\s)([^$\n]*[^\s$])\$(?!\d)/g,
      (_match, lead: string, tex: string) => lead + katexOrRaw(tex, false),
    )
}

/**
 * Text with no Markdown in it but its math: a heading, where it is listed.
 * Escaped first, like everything here.
 */
export function renderMathText(source: string): string {
  return renderMath(escapeHtml(source))
}

function katexOrRaw(tex: string, display: boolean): string {
  try {
    return katex.renderToString(decodeEntities(tex), {
      displayMode: display,
      throwOnError: false,
      output: 'html',
    })
  } catch {
    const fence = display ? '$$' : '$'
    return `<code class="math-error">${escapeHtml(fence + tex + fence)}</code>`
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * `[label](destination)`. The label of a citation is a quotation, and papers
 * say `E[g|G]`: so a label may hold brackets of its own, paired, and brackets
 * written with a backslash before them.
 */
const LINK = /\[((?:\\.|[^[\]\\\n]|\[(?:\\.|[^[\]\\\n])*\])*)\]\(([^)\s]+)\)/g
/** A backslash before punctuation says "this character, as it is". */
const ESCAPED = /\\([!-/:-@[-`{-~])/g

function inline(text: string): string {
  let out = text

  // Inline code first; its contents must not be further transformed. The
  // placeholder is a NUL-delimited index, so ordinary prose cannot collide
  // with it.
  const codeSpans: string[] = []
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `\u0000${codeSpans.length - 1}\u0000`
  })

  out = renderMath(out)

  out = out.replace(LINK, (match, written: string, href: string): string => {
    const label = written.replace(ESCAPED, '$1')
    if (href.startsWith('source:')) {
      const id = href.slice('source:'.length)
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return match
      return `<a class="source-link" role="button" tabindex="0" data-source-ref="${id}" title="${id}">${label || id}</a>`
    }
    if (href.startsWith('paper:')) {
      // A paper of the library, named in passing: a click opens it.
      const id = href.slice('paper:'.length)
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return match
      return `<a class="paper-link" role="button" tabindex="0" data-paper="${id}" title="Open this paper">${label || id}</a>`
    }
    if (href.startsWith('note:')) {
      // Another note of the project: a click opens it.
      const id = href.slice('note:'.length)
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return match
      return `<a class="note-link" role="button" tabindex="0" data-note="${id}" title="Open this note">${label || id}</a>`
    }
    if (!ALLOWED_SCHEME.test(decodeEntities(href))) return match
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>`
  })

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')

  return out.replace(
    /\u0000(\d+)\u0000/g,
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  )
}

/**
 * One line of inline Markdown — emphasis, code, math, links — as HTML.
 *
 * For text that sits inside something else that is drawn as HTML: the cell of
 * a table in a note. Escaped first, like everything here.
 */
export function renderInline(source: string): string {
  return inline(escapeHtml(source))
}

/** The cells of a pipe-table row, or null when the line is not one. */
export function tableCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  // `\|` is a literal bar inside a cell, not the end of one.
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * Whether two lines open a table: a row of cells, and under it a rule of
 * dashes with as many columns. The count is what tells a table from a line
 * that happens to hold a bar and is followed by a rule across the page.
 */
export function opensTable(first: string, second: string | undefined): string[] | null {
  const header = tableCells(first)
  if (!header || second === undefined || !TABLE_RULE.test(second)) return null
  return tableCells(second)?.length === header.length ? header : null
}

export type Alignment = 'left' | 'center' | 'right' | null

/** How each column is set, from the colons in the rule under the header. */
export function alignmentsOf(rule: string): Alignment[] {
  return (tableCells(rule) ?? []).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })
}

export interface TableBlock {
  /** Zero-based indices of its first and last lines. */
  fromLine: number
  toLine: number
  header: string[]
  align: Alignment[]
  rows: string[][]
}

/**
 * The pipe tables in a text: a row of cells, a rule of dashes, then the rows.
 *
 * Found by reading the lines, the same way wherever tables are drawn. What
 * looks like one inside a code block is an example, and is left alone.
 */
export function findTables(lines: string[]): TableBlock[] {
  const tables: TableBlock[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const opening = /^\s*(```|~~~)/.exec(line)
    if (opening) {
      fence = fence === null ? opening[1]! : fence === opening[1] ? null : fence
      continue
    }
    if (fence !== null) continue
    const rule = lines[index + 1]
    const header = opensTable(line, rule)
    if (!header || rule === undefined) continue
    const rows: string[][] = []
    let last = index + 1
    while (last + 1 < lines.length && lines[last + 1]!.trim() !== '' && tableCells(lines[last + 1]!)) {
      last += 1
      rows.push(tableCells(lines[last]!)!)
    }
    tables.push({ fromLine: index, toLine: last, header, align: alignmentsOf(rule), rows })
    index = last
  }
  return tables
}

export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source)
  const lines = escaped.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  // The item being read: it may run on to further lines, as a paragraph does.
  let item: string[] | null = null
  let inFence = false
  let fence: string[] = []

  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const closeItem = (): void => {
    if (item) {
      html.push(`<li>${inline(item.join(' '))}</li>`)
      item = null
    }
  }
  const closeList = (): void => {
    closeItem()
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^```/.test(line.trim())) {
      if (inFence) {
        html.push(`<pre><code>${fence.join('\n')}</code></pre>`)
        fence = []
        inFence = false
      } else {
        closeParagraph()
        closeList()
        inFence = true
      }
      continue
    }
    if (inFence) {
      fence.push(line)
      continue
    }

    if (line.trim() === '') {
      closeParagraph()
      closeList()
      continue
    }

    // A table: a row of cells, then a rule of dashes, then the rows.
    const rule = lines[index + 1]
    const header = opensTable(line, rule)
    if (header && rule !== undefined) {
      closeParagraph()
      closeList()
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index]!.trim() !== '' && tableCells(lines[index]!)) {
        rows.push(tableCells(lines[index]!)!)
        index += 1
      }
      index -= 1
      const align = alignmentsOf(rule)
      const cellsOf = (cells: string[], tag: 'th' | 'td'): string =>
        header
          .map((_, column) => {
            const set = align[column] ? ` style="text-align:${align[column]}"` : ''
            return `<${tag}${set}>${inline(cells[column] ?? '')}</${tag}>`
          })
          .join('')
      html.push(
        '<div class="table-wrap"><table>' +
          `<thead><tr>${cellsOf(header, 'th')}</tr></thead>` +
          `<tbody>${rows.map((row) => `<tr>${cellsOf(row, 'td')}</tr>`).join('')}</tbody>` +
          '</table></div>',
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeParagraph()
      closeList()
      const level = heading[1]!.length
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const quote = /^&gt;\s?(.*)$/.exec(line)
    if (quote) {
      closeParagraph()
      closeList()
      html.push(`<blockquote>${inline(quote[1]!)}</blockquote>`)
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      closeParagraph()
      const wanted: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      if (listType !== wanted) {
        closeList()
        html.push(`<${wanted}>`)
        listType = wanted
      }
      closeItem()
      item = [(bullet ?? ordered)![1]!]
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeParagraph()
      closeList()
      html.push('<hr />')
      continue
    }

    // A line that opens nothing carries on what came before it.
    if (item) item.push(line.trim())
    else paragraph.push(line.trim())
  }

  if (inFence) html.push(`<pre><code>${fence.join('\n')}</code></pre>`)
  closeParagraph()
  closeList()
  return html.join('\n')
}
