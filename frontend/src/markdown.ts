/**
 * A small Markdown renderer for read-only surfaces (chat bubbles).
 *
 * The note editor never uses this — it renders in place over the real source.
 * Here the input can include agent output, so the text is HTML-escaped first
 * and only a fixed set of constructs is re-introduced. Link destinations are
 * restricted to `http(s)`, `mailto:`, and the application's own `source:`
 * scheme, so no `javascript:` URL can survive.
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
      // Inline math: the opening `$` must not be followed by whitespace or a
      // digit, and the closing one must not be preceded by whitespace. Without
      // the digit rule, prose like "it cost $5 and then $7" parses as math.
      // The cost is that `$5x$` is not treated as math — rare, and preferable
      // to mangling currency.
      /(^|[^\\$])\$(?![\s\d])([^$\n]*[^\s$])\$/g,
      (_match, lead: string, tex: string) => lead + katexOrRaw(tex, false),
    )
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

  out = out.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (match, label: string, href: string): string => {
      if (href.startsWith('source:')) {
        const id = href.slice('source:'.length)
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) return match
        return `<a class="source-link" role="button" tabindex="0" data-source-ref="${id}" title="${id}">${label || id}</a>`
      }
      if (!ALLOWED_SCHEME.test(decodeEntities(href))) return match
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>`
    },
  )

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')

  return out.replace(
    /\u0000(\d+)\u0000/g,
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  )
}

/** The cells of a pipe-table row, or null when the line is not one. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  // `\|` is a literal bar inside a cell, not the end of one.
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source)
  const lines = escaped.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inFence = false
  let fence: string[] = []

  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const closeList = (): void => {
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
    const header = tableCells(line)
    const rule = lines[index + 1]
    if (header && rule !== undefined && TABLE_RULE.test(rule) && rule.includes('-')) {
      closeParagraph()
      closeList()
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index]!.trim() !== '' && tableCells(lines[index]!)) {
        rows.push(tableCells(lines[index]!)!)
        index += 1
      }
      index -= 1
      const cellsOf = (cells: string[], tag: 'th' | 'td'): string =>
        header.map((_, column) => `<${tag}>${inline(cells[column] ?? '')}</${tag}>`).join('')
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
      html.push(`<li>${inline((bullet ?? ordered)![1]!)}</li>`)
      continue
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeParagraph()
      closeList()
      html.push('<hr />')
      continue
    }

    paragraph.push(line.trim())
  }

  if (inFence) html.push(`<pre><code>${fence.join('\n')}</code></pre>`)
  closeParagraph()
  closeList()
  return html.join('\n')
}
