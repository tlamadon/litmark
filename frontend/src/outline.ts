/**
 * The headings of a Markdown text: its table of contents.
 *
 * Read from the text itself, the same way wherever it is needed — by the
 * panel that lists them and by the editor that goes to one — so "the third
 * heading" is the same heading to both.
 */

export interface Heading {
  level: number
  text: string
  /** One-based line the heading is on. */
  line: number
}

/** What a heading says, without the Markdown it is written in. */
function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function headingsOf(markdown: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  markdown.split('\n').forEach((line, index) => {
    const opening = /^\s*(```+|~~~+)/.exec(line)
    if (opening) {
      // Inside a code block a `#` is a comment, not a heading.
      const mark = opening[1]!.slice(0, 3)
      fence = fence === null ? mark : fence === mark ? null : fence
      return
    }
    if (fence !== null) return
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!match) return
    const text = plain(match[2]!)
    if (text) headings.push({ level: match[1]!.length, text, line: index + 1 })
  })
  return headings
}
