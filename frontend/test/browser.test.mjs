/**
 * Real-browser checks against a running server.
 *
 * These cover the criteria nothing else can answer: Markdown live preview
 * (A2), and opening a citation to a highlighted PDF passage at more than one
 * zoom level (A6/A8).
 *
 * Firefox, not Chromium: headless Chromium cannot reach loopback HTTP in every
 * sandbox — it returns an empty document where curl succeeds — so it silently
 * verifies nothing. See test/marionette.mjs.
 *
 * Run against a project that has at least one note containing a `source:`
 * citation:
 *
 *   LITMARK_BASE_URL=http://127.0.0.1:8765/ npm run test:browser
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { click, launchFirefox, navigate, script, waitFor } from './marionette.mjs'

const BASE_URL = process.env.LITMARK_BASE_URL
const describeOrSkip = BASE_URL ? describe : describe.skip

describeOrSkip('the application in Firefox', () => {
  let firefox
  let client

  before(async () => {
    firefox = await launchFirefox({ binary: process.env.LITMARK_FIREFOX ?? 'firefox' })
    client = firefox.client
    await navigate(client, BASE_URL)
    // The page holds an SSE connection open, so wait on the UI, not on load.
    await waitFor(client, `!!document.querySelector('.sidebar')`, {
      timeoutMs: 30000,
      label: 'the sidebar to render',
    })
  })

  after(async () => {
    await firefox?.close()
  })

  test('renders the project shell', async () => {
    const project = await script(client, `return document.querySelector('.topbar h1')?.textContent`)
    assert.ok(project, 'the project name is missing')

    const entries = await script(
      client,
      `return [...document.querySelectorAll('.sidebar .entry strong')].map((n) => n.textContent)`,
    )
    assert.ok(entries.length > 0, 'the sidebar listed nothing')
  })

  test('the event stream connects, so live updates work', async () => {
    // "Reconnecting…" showing steadily means the SSE response never opened.
    await waitFor(client, `!document.querySelector('.badge.warn')`, {
      timeoutMs: 10000,
      label: 'the reconnecting badge to clear',
    })
  })

  test('a note opens for reading, and a click does not start an edit', async () => {
    await waitFor(client, `!!document.querySelector('.cm-content')`, {
      label: 'the editor to mount',
    })
    assert.ok(
      await script(client, `return !!document.querySelector('.editor.reading')`),
      'the note did not open in reading mode',
    )
    // Click on a line of prose, and on the heading: reading, neither opens
    // the Markdown under the click, and nothing becomes editable.
    await script(
      client,
      `for (const line of document.querySelectorAll('.cm-content .cm-line')) {
         const box = line.getBoundingClientRect()
         if (box.width === 0) continue
         const at = { bubbles: true, cancelable: true, view: window, clientX: box.left + 12, clientY: box.top + box.height / 2, detail: 1 }
         line.dispatchEvent(new MouseEvent('mousedown', at))
         line.dispatchEvent(new MouseEvent('mouseup', at))
         line.dispatchEvent(new MouseEvent('click', at))
       }`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = await script(
      client,
      `return {
         reading: !!document.querySelector('.editor.reading'),
         editable: document.querySelector('.cm-content').getAttribute('contenteditable'),
         text: document.querySelector('.cm-content').textContent,
       }`,
    )
    assert.ok(after.reading, 'a click left reading mode')
    assert.equal(after.editable, 'false', 'the text is editable while reading')
    assert.ok(!after.text.includes('](source:'), `a click opened a citation's syntax: ${after.text.slice(0, 200)}`)
    assert.ok(!/(^|\n)#/.test(after.text), `a click opened a heading's syntax: ${after.text.slice(0, 80)}`)
  })

  test('double-clicking the text starts editing there, and Escape goes back to reading', async () => {
    const where = await script(
      client,
      `const line = [...document.querySelectorAll('.cm-content .cm-line')].find(
         (n) => n.textContent.trim().length > 20 && !n.classList.contains('cm-heading'),
       )
       const box = line.getBoundingClientRect()
       const at = { bubbles: true, cancelable: true, view: window, clientX: box.left + 40, clientY: box.top + box.height / 2, detail: 2 }
       line.dispatchEvent(new MouseEvent('dblclick', at))
       return line.textContent.slice(0, 30)`,
    )
    await waitFor(client, `!document.querySelector('.editor.reading')`, {
      timeoutMs: 5000,
      label: `editing to start after a double-click on "${where}"`,
    })
    const editing = await script(
      client,
      `return {
         editable: document.querySelector('.cm-content').getAttribute('contenteditable'),
         focused: document.querySelector('.cm-editor').classList.contains('cm-focused'),
         pressed: document.querySelector('.mode-tabs [data-mode="edit"]').getAttribute('aria-pressed'),
       }`,
    )
    assert.equal(editing.editable, 'true', 'double-clicking did not make the text editable')
    assert.ok(editing.focused, 'the editor does not have the keyboard after a double-click')
    assert.equal(editing.pressed, 'true', 'the mode switch does not show Edit')

    await script(
      client,
      `document.querySelector('.cm-content').dispatchEvent(
         new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
       )`,
    )
    await waitFor(client, `!!document.querySelector('.editor.reading')`, {
      timeoutMs: 5000,
      label: 'Escape to return to reading',
    })
  })

  test('A2: Markdown renders in place, and Source mode shows the text', async () => {
    await waitFor(client, `!!document.querySelector('.cm-content')`, {
      label: 'the editor to mount',
    })
    // Revealing syntax around the cursor, and the Source view, belong to editing.
    await click(client, '.mode-tabs [data-mode="edit"]')
    await waitFor(client, `!document.querySelector('.editor.reading')`, { label: 'edit mode' })
    assert.ok(
      await script(client, `return !!document.querySelector('.cm-heading')`),
      'no heading decoration was applied',
    )

    // Move the cursor onto a body line, so the heading's own markers hide.
    await script(
      client,
      `const el = document.querySelector('.cm-content');
       const line = [...el.querySelectorAll('.cm-line')].find(
         (n) => !n.textContent.trim().startsWith('#') && n.textContent.trim().length > 20,
       );
       if (line) {
         const range = document.createRange();
         range.setStart(line.firstChild ?? line, 0);
         range.collapse(true);
         const sel = window.getSelection();
         sel.removeAllRanges();
         sel.addRange(range);
       }
       return true;`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))

    const heading = await script(
      client,
      `return document.querySelector('.cm-heading')?.textContent ?? ''`,
    )
    assert.ok(!heading.trimStart().startsWith('#'), `heading markers still visible: ${heading}`)

    await click(client, '.editor-actions .toggle:not(.open-source)')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const source = await script(
      client,
      `return document.querySelector('.cm-content')?.textContent ?? ''`,
    )
    assert.ok(source.includes('#'), 'Source mode did not reveal the Markdown syntax')
    assert.ok(source.includes('(source:'), 'Source mode did not reveal the citation syntax')

    await click(client, '.editor-actions .toggle:not(.open-source)')
    await new Promise((resolve) => setTimeout(resolve, 300))
  })

  test('a plain click on a citation arms the visible Open source action', async () => {
    assert.ok(
      await script(client, `return !!document.querySelector('.cm-source-link')`),
      'the open note contains no citation to click',
    )

    // A rendered citation is an atomic range; a plain click must still put the
    // cursor inside it rather than leaving the action disabled.
    await click(client, '.cm-source-link')
    await waitFor(client, `!document.querySelector('[data-action="open-source"]')?.disabled`, {
      timeoutMs: 5000,
      label: 'the Open source action to become enabled',
    })
    const label = await script(
      client,
      `return document.querySelector('[data-action="open-source"]')?.textContent ?? ''`,
    )
    assert.match(label, /Open source · ref-/, `unexpected action label: ${label}`)
  })

  test('A6/A8: opening a citation highlights the passage in the PDF', async () => {
    await click(client, '[data-action="open-source"]')

    await waitFor(client, `!!document.querySelector('.pdf canvas')`, {
      timeoutMs: 30000,
      label: 'the PDF canvas to render',
    })
    const canvas = await script(
      client,
      `const c = document.querySelector('.pdf canvas');
       return c ? { width: c.width, height: c.height } : null`,
    )
    assert.ok(canvas.width > 100 && canvas.height > 100, `PDF not drawn: ${JSON.stringify(canvas)}`)

    const highlights = await waitFor(
      client,
      `return (() => {
         const nodes = [...document.querySelectorAll('.pdf-highlight')]
         return nodes.length
           ? nodes.map((n) => ({
               left: parseFloat(n.style.left),
               top: parseFloat(n.style.top),
               width: parseFloat(n.style.width),
               height: parseFloat(n.style.height),
             }))
           : null
       })()`,
      { timeoutMs: 20000, label: 'a highlight overlay' },
    )
    for (const rect of highlights) {
      assert.ok(rect.width > 1 && rect.height > 1, `degenerate highlight: ${JSON.stringify(rect)}`)
      assert.ok(
        rect.left >= 0 && rect.top >= 0,
        `highlight outside the page: ${JSON.stringify(rect)}`,
      )
    }
  })

  test('reading, one click on a citation opens what it cites', async () => {
    await click(client, '.mode-tabs [data-mode="read"]')
    await waitFor(client, `!!document.querySelector('.editor.reading')`, { label: 'reading mode' })
    // Put the paper away, so that opening it again is plainly the click's doing.
    await click(client, '.pdf-bar button[title="Close the source panel"]')
    await waitFor(client, `!document.querySelector('.pdf')`, { label: 'the source panel to close' })

    await click(client, '.cm-source-link')
    await waitFor(client, `!!document.querySelector('.pdf canvas')`, {
      timeoutMs: 30000,
      label: 'the cited paper to open from a single click',
    })
    await waitFor(client, `!!document.querySelector('.pdf-highlight.active')`, {
      timeoutMs: 15000,
      label: 'the cited passage to be highlighted',
    })
    const state = await script(
      client,
      `return {
         reading: !!document.querySelector('.editor.reading'),
         text: document.querySelector('.cm-content').textContent,
         active: !!document.querySelector('.cm-citation.active'),
       }`,
    )
    assert.ok(state.reading, 'opening a citation left reading mode')
    assert.ok(!state.text.includes('](source:'), 'the click opened the citation for editing')
    assert.ok(state.active, 'the citation that was opened is not picked out in the note')
  })

  test('the document scrolls continuously, rendering pages lazily', async () => {
    const layout = await script(
      client,
      `return (() => {
         const scroll = document.querySelector('.pdf-scroll')
         const pages = [...document.querySelectorAll('.pdf-page')]
         return {
           pages: pages.length,
           drawn: pages.filter((p) => {
             const c = p.querySelector('canvas')
             return c && c.width > 0
           }).length,
           scrollHeight: scroll.scrollHeight,
           clientHeight: scroll.clientHeight,
           numbered: pages.map((p) => Number(p.dataset.page)),
         }
       })()`,
    )
    assert.ok(layout.pages > 1, 'only one page was laid out; the view is not continuous')
    assert.deepEqual(
      layout.numbered,
      Array.from({ length: layout.pages }, (_unused, index) => index + 1),
      'pages are not laid out in order',
    )
    assert.ok(
      layout.scrollHeight > layout.clientHeight,
      'the page stack does not exceed the viewport, so nothing can scroll',
    )
    assert.ok(layout.drawn >= 1, 'no page was rasterised')
  })

  test('scrolling updates the page indicator', async () => {
    const target = await script(
      client,
      `return (() => {
         const page = [...document.querySelectorAll('.pdf-page')].find(
           (n) => n.dataset.page === '2',
         )
         if (!page) return null
         page.scrollIntoView({ block: 'start' })
         return 2
       })()`,
    )
    if (target === null) return // single-page fixture

    // The indicator is measured from element rectangles, not the observer's
    // ratio, which a generous rootMargin would inflate to 1 for every page.
    await waitFor(client, `document.querySelector('.pdf-controls input')?.value === '2'`, {
      timeoutMs: 8000,
      label: 'the page indicator to follow the scroll',
    })
  })

  test('every mark in the document is shown, coloured by where it is cited', async () => {
    const tones = await script(
      client,
      `return (() => {
         const out = {}
         for (const node of document.querySelectorAll('.pdf-highlight')) {
           const tone = node.dataset.tone
           out[tone] = (out[tone] ?? 0) + 1
         }
         return out
       })()`,
    )
    const total = Object.values(tones).reduce((sum, n) => sum + n, 0)
    assert.ok(total > 1, `expected marks beyond the active one, saw ${JSON.stringify(tones)}`)

    // Marks from more than one origin must be distinguishable.
    const distinct = Object.keys(tones).filter((tone) => tones[tone] > 0)
    assert.ok(distinct.length >= 2, `only one kind of mark is drawn: ${distinct.join(', ')}`)

    const legend = await script(
      client,
      `return [...document.querySelectorAll('.pdf-legend .key')].map((n) => n.textContent.trim())`,
    )
    assert.ok(legend.length >= 2, `the key does not explain the colours: ${legend.join(' | ')}`)

    // The colours must actually differ, not merely carry different classes.
    const colours = await script(
      client,
      `return (() => {
         const seen = {}
         for (const node of document.querySelectorAll('.pdf-highlight')) {
           seen[node.dataset.tone] = getComputedStyle(node).backgroundColor
         }
         return seen
       })()`,
    )
    const values = Object.values(colours)
    assert.equal(
      new Set(values).size,
      values.length,
      `two mark kinds render identically: ${JSON.stringify(colours)}`,
    )
  })

  test('a mark carries a tooltip naming where it is cited', async () => {
    const titles = await script(
      client,
      `return [...document.querySelectorAll('.pdf-highlight')].map((n) => n.title).filter(Boolean)`,
    )
    assert.ok(titles.length > 0, 'marks carry no tooltip')
    assert.ok(
      titles.some((title) => /ref-/.test(title)),
      `tooltips do not name the reference: ${titles[0]}`,
    )
  })

  test('A6: the highlight stays on the passage across zoom levels', async () => {
    const measure = `(() => {
      const c = document.querySelector('.pdf canvas')
      const h = document.querySelector('.pdf-highlight')
      if (!c || !h) return null
      // The page as it is on screen. (The canvas fills its page by stylesheet,
      // so it has no inline size of its own to read.)
      const box = c.getBoundingClientRect()
      return {
        pageWidth: box.width,
        pageHeight: box.height,
        left: parseFloat(h.style.left),
        top: parseFloat(h.style.top),
        width: parseFloat(h.style.width),
      }
    })()`

    const before = await script(client, `return ${measure}`)
    assert.ok(before, 'no highlight to measure')

    await click(client, '.pdf-controls button[title="Zoom in"]')
    await waitFor(
      client,
      `return (() => {
         const c = document.querySelector('.pdf canvas')
         return c && c.getBoundingClientRect().width > ${before.pageWidth + 1}
       })()`,
      { timeoutMs: 15000, label: 'the page to grow after zooming in' },
    )
    await new Promise((resolve) => setTimeout(resolve, 400))

    const after = await script(client, `return ${measure}`)
    assert.ok(after, 'the highlight disappeared after zooming')

    // Normalized geometry means the highlight's position relative to the page
    // is invariant under zoom. Drift here is a coordinate-conversion bug.
    const relative = (m) => ({
      left: m.left / m.pageWidth,
      top: m.top / m.pageHeight,
      width: m.width / m.pageWidth,
    })
    const a = relative(before)
    const b = relative(after)
    assert.ok(Math.abs(a.left - b.left) < 0.01, `x drifted: ${a.left} -> ${b.left}`)
    assert.ok(Math.abs(a.top - b.top) < 0.01, `y drifted: ${a.top} -> ${b.top}`)
    assert.ok(Math.abs(a.width - b.width) < 0.01, `width drifted: ${a.width} -> ${b.width}`)
  })

  test('every page in view is drawn, wherever the document is scrolled', async () => {
    // Which pages have a picture with ink on it, among those in view. A page
    // can be laid out, sized, and numbered, and still be blank.
    const blankInView = `(() => {
      const scroll = document.querySelector('.pdf-scroll')
      const view = scroll.getBoundingClientRect()
      const blank = []
      for (const page of document.querySelectorAll('.pdf-page')) {
        const box = page.getBoundingClientRect()
        const shown = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)
        if (shown <= 20) continue
        const canvas = page.querySelector('canvas')
        let inked = false
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 0; i < data.length; i += 4 * 97) {
            if (data[i] < 200) { inked = true; break }
          }
        }
        if (!inked) blank.push(Number(page.dataset.page))
      }
      return blank
    })()`

    // The top, the middle, the end, and back: a page that scrolled away and
    // came back must be drawn again, and one sharing the view with another
    // must be drawn at all.
    for (const fraction of [0, 0.5, 1, 0.25, 0]) {
      await script(
        client,
        `const scroll = document.querySelector('.pdf-scroll')
         scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * arguments[0]`,
        [fraction],
      )
      await waitFor(client, `${blankInView}.length === 0`, {
        timeoutMs: 15000,
        label: `every page in view to be drawn at ${Math.round(fraction * 100)}% (blank: see last)`,
      })
    }
    const pagesInView = await script(
      client,
      `return (() => {
         const view = document.querySelector('.pdf-scroll').getBoundingClientRect()
         return [...document.querySelectorAll('.pdf-page')].filter((page) => {
           const box = page.getBoundingClientRect()
           return Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top) > 20
         }).length
       })()`,
    )
    assert.ok(pagesInView >= 1, 'no page is in view at the top of the document')
  })

  test('the text one selects is the size of the text one sees', async () => {
    // PDF.js sizes its text-layer spans as a multiple of a custom property the
    // page must define. Without it they fall back to the page's font size, and
    // a selection covers the wrong part of the page.
    const sizes = await waitFor(
      client,
      `(() => {
         const page = [...document.querySelectorAll('.pdf-page')].find((p) =>
           p.querySelector('.pdf-text-layer span'),
         )
         if (!page) return null
         const span = page.querySelector('.pdf-text-layer span')
         const declared = /\\*\\s*([\\d.]+)px/.exec(span.style.fontSize)
         return {
           factor: Number(getComputedStyle(page).getPropertyValue('--scale-factor')),
           declaredPx: declared ? Number(declared[1]) : null,
           computedPx: parseFloat(getComputedStyle(span).fontSize),
           inline: span.style.fontSize,
         }
       })()`,
      { timeoutMs: 15000, label: 'a text layer to be built' },
    )
    assert.ok(sizes.factor > 0, `the page defines no scale for its text layer: ${JSON.stringify(sizes)}`)
    if (sizes.declaredPx !== null) {
      const expected = sizes.declaredPx * sizes.factor
      assert.ok(
        Math.abs(sizes.computedPx - expected) < 1,
        `text-layer spans are ${sizes.computedPx}px, expected ${expected.toFixed(1)}px: ${JSON.stringify(sizes)}`,
      )
    }
  })

  test('A13: the sidebar writes a bibliography and reports what it found', async () => {
    const actions = await script(
      client,
      `return [...document.querySelectorAll('.sidebar .head-actions *')].map((n) =>
         n.textContent.trim(),
       )`,
    )
    assert.ok(actions.includes('Write .bib'), `no bibliography action: ${actions.join(' | ')}`)

    await click(client, '.sidebar .head-actions button')
    const banner = await waitFor(
      client,
      `return document.querySelector('.banner span')?.textContent ?? null`,
      { timeoutMs: 10000, label: 'the bibliography result banner' },
    )
    assert.match(banner, /references\.bib/, `unexpected banner: ${banner}`)
    assert.match(banner, /entr(y|ies)/, `the banner does not report a count: ${banner}`)

    // The download link must carry the session credential, or the browser
    // fetches it without the header the API requires and gets a 401.
    const href = await script(
      client,
      `return document.querySelector('.sidebar .head-actions a')?.getAttribute('href') ?? ''`,
    )
    assert.match(href, /format=bibtex/, `unexpected download link: ${href}`)
    assert.match(href, /token=./, `the download link carries no credential: ${href}`)
  })

  test('a highlight in the paper leads to where it is cited', async (t) => {
    // The other direction of A6: from the passage back to the sentence that
    // cites it. Needs a passage cited somewhere other than the note that is
    // open — in another note, or in a summary.
    const reference = await script(
      client,
      `return document.querySelector('.pdf-highlight[data-tone="other-note"]')?.dataset.reference ?? null`,
    )
    if (!reference) {
      t.skip('no passage in the open paper is cited outside the open note')
      return
    }
    const before = await script(
      client,
      `return document.querySelector('.main-head h2')?.textContent ?? ''`,
    )

    // Where the cursor is, and whether the editor has the keyboard, beforehand.
    await script(client, `document.activeElement?.blur?.()`)

    await click(client, `.pdf-highlight[data-reference="${reference}"]`)
    const landed = await waitFor(
      client,
      `(() => {
         const mark = document.querySelector('.cm-citation.active.revealed')
         if (!mark) return null
         const at = mark.getBoundingClientRect()
         const view = document.querySelector('.cm-scroller').getBoundingClientRect()
         const middle = (at.top + at.bottom) / 2
         return {
           title: document.querySelector('.main-head h2')?.textContent ?? '',
           inView: at.top >= view.top && at.bottom <= view.bottom,
           // Centred, when the note is long enough to scroll that far.
           offCentre: Math.abs(middle - (view.top + view.bottom) / 2) / view.height,
           scrolled: document.querySelector('.cm-scroller').scrollTop,
           colour: getComputedStyle(mark).backgroundColor,
           focused: document.querySelector('.cm-editor').classList.contains('cm-focused'),
           editing: (window.getSelection()?.toString() ?? '').length > 0,
           syntaxShown: mark.textContent.includes('](source:'),
         }
       })()`,
      { timeoutMs: 10000, label: `the citation of ${reference} to be marked in the editor` },
    )
    assert.notEqual(landed.title, before, 'the note that cites the passage was not opened')
    assert.ok(landed.inView, `the citation is marked but out of view: ${JSON.stringify(landed)}`)
    if (landed.scrolled > 0) {
      assert.ok(landed.offCentre < 0.2, `the citation is not centred: ${JSON.stringify(landed)}`)
    }
    // Shown, not entered: no cursor put there, no keyboard taken, no syntax opened.
    assert.equal(landed.focused, false, 'going to a citation took the keyboard focus')
    assert.equal(landed.editing, false, 'going to a citation selected text in the note')
    assert.equal(landed.syntaxShown, false, 'the citation was opened for editing')

    // The passage on show is one colour on both sides; other citations another.
    const colours = await script(
      client,
      `return (() => {
         const of = (selector) => {
           const node = document.querySelector(selector)
           return node ? getComputedStyle(node).backgroundColor : null
         }
         return {
           noteActive: of('.cm-citation.active'),
           pdfActive: of('.pdf-highlight.active'),
           pdfOther: of('.pdf-highlight.other-note'),
         }
       })()`,
    )
    assert.equal(colours.noteActive, colours.pdfActive, JSON.stringify(colours))
    assert.notEqual(colours.noteActive, colours.pdfOther, JSON.stringify(colours))
  })

  test('citations not on show carry the colour of the paper\'s other highlights', async () => {
    const colours = await script(
      client,
      `return (() => {
         const other = document.querySelector('.cm-citation.other')
         const pdf = document.querySelector('.pdf-highlight.other-note')
         return other && pdf
           ? { note: getComputedStyle(other).backgroundColor, pdf: getComputedStyle(pdf).backgroundColor }
           : null
       })()`,
    )
    if (colours === null) return // nothing else is cited in the open note
    assert.equal(colours.note, colours.pdf, JSON.stringify(colours))
  })

  test('closing the sidebar gives its room to the note', async () => {
    const width = `return Math.round(document.querySelector('.main').getBoundingClientRect().width)`
    const before = await script(client, width)
    await click(client, '.topbar .ghost')
    await waitFor(client, `!document.querySelector('.sidebar')`, { label: 'the sidebar to close' })
    const after = await script(client, width)
    await click(client, '.topbar .ghost')
    await waitFor(client, `!!document.querySelector('.sidebar')`, { label: 'the sidebar to reopen' })
    assert.ok(
      after > before,
      `the note is ${after}px wide with the sidebar closed and ${before}px with it open`,
    )
    assert.equal(await script(client, width), before, 'reopening the sidebar did not restore the layout')
  })

  test('what was typed just before leaving a note is saved', async (t) => {
    const notes = await script(
      client,
      `return [...document.querySelectorAll('.sidebar section')]
         .find((section) => section.querySelector('h3')?.textContent === 'Notes')
         ?.querySelectorAll('.entry').length ?? 0`,
    )
    if (notes < 2) {
      t.skip('needs two notes to leave one for the other')
      return
    }
    const noteEntries = `[...document.querySelectorAll('.sidebar section')]
      .find((section) => section.querySelector('h3')?.textContent === 'Notes')
      .querySelectorAll('.entry')`
    await script(client, `${noteEntries}[0].click()`)
    await waitFor(client, `!!document.querySelector('.cm-content')`, { label: 'the note to open' })
    await click(client, '.mode-tabs [data-mode="edit"]')
    await waitFor(client, `!document.querySelector('.editor.reading')`, { label: 'edit mode' })
    const marker = `typed-then-left-${Date.now()}`

    // Type, and leave at once: well inside the autosave delay.
    const noteId = await script(
      client,
      `const content = document.querySelector('.cm-content')
       content.focus()
       const selection = window.getSelection()
       selection.selectAllChildren(content)
       selection.collapseToEnd()
       document.execCommand('insertText', false, ' ' + arguments[0])
       const entries = ${noteEntries}
       const id = entries[0].querySelector('.muted')?.textContent.replace(/\.md$/, '')
       entries[1].click()
       return id`,
      [marker],
    )
    const saved = await waitFor(
      client,
      `(() => {
         const token = document.querySelector('meta[name="litmark-token"]').content
         const request = new XMLHttpRequest()
         request.open('GET', '/api/notes/' + encodeURIComponent(${JSON.stringify('NOTE')}), false)
         request.setRequestHeader('x-litmark-token', token)
         request.send()
         return request.status === 200 && JSON.parse(request.responseText).text.includes(${JSON.stringify('MARK')})
       })()`
        .replace(JSON.stringify('NOTE'), JSON.stringify(noteId))
        .replace(JSON.stringify('MARK'), JSON.stringify(marker)),
      { timeoutMs: 8000, label: `the text typed into ${noteId} to reach the file` },
    )
    assert.ok(saved)
    // And it went to the note it was typed in, not the one now open.
    const open = await script(client, `return document.querySelector('.cm-content')?.textContent ?? ''`)
    assert.ok(!open.includes(marker), 'the text typed in one note appears in the other')
  })
})
