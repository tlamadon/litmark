/**
 * An editor that shows the text whatever happens to the preview.
 *
 * The preview dresses Markdown as it is read. What it is given is not under
 * its control — notes are written by agents, with quotations lifted from PDFs —
 * and when the editor library refuses something the preview asked for, it
 * refuses by throwing while it draws. Left alone, that takes the whole note
 * with it: nothing is shown, not even the source, though nothing is wrong with
 * the text. It has happened once, over a line break inside a citation.
 *
 * So the editor is put up through here. If drawing fails, at the start or at
 * any later change, the editor is put up again without the preview, holding
 * the same text: plain Markdown, readable and editable. A note is never blank
 * because of how it would have been decorated.
 */

import { EditorState, type Extension, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface ResilientEditorOptions {
  parent: HTMLElement
  doc: string
  /** The editor's extensions: with the preview, or — once it has failed — without it. */
  extensions: (preview: boolean) => Extension[]
  /**
   * The preview failed and the text is now shown as written. Given what failed,
   * and the changes that were being applied when it did: they were kept.
   */
  onFallback?: (error: unknown, applying: readonly Transaction[]) => void
}

export interface ResilientEditor {
  /** The editor on screen. A different one after a fallback, so never hold on to it. */
  readonly view: EditorView
  /** Whether the text is shown as written because the preview failed. */
  readonly plain: boolean
  destroy(): void
}

export function mountResilientEditor(options: ResilientEditorOptions): ResilientEditor {
  let preview = true
  let view: EditorView | null = null

  const build = (doc: string): EditorView =>
    new EditorView({
      state: EditorState.create({ doc, extensions: options.extensions(preview) }),
      parent: options.parent,
      dispatchTransactions: (transactions, target) => {
        try {
          target.update(transactions)
        } catch (error) {
          // Without the preview there is nothing left to take away.
          if (!preview || transactions.length === 0) throw error
          // What was being applied is kept: the text the change led to.
          const text = transactions[transactions.length - 1]!.state.doc.toString()
          fallBack(error, text, transactions)
        }
      },
    })

  const fallBack = (error: unknown, doc: string, applying: readonly Transaction[]): void => {
    console.error('litmark: the preview failed; the text is shown as written', error)
    preview = false
    try {
      view?.destroy()
    } catch {
      // Half drawn, it may not come down cleanly; what it left is cleared below.
    }
    options.parent.replaceChildren()
    view = build(doc)
    options.onFallback?.(error, applying)
  }

  try {
    view = build(options.doc)
  } catch (error) {
    fallBack(error, options.doc, [])
  }

  return {
    get view(): EditorView {
      return view!
    },
    get plain(): boolean {
      return !preview
    },
    destroy(): void {
      view?.destroy()
      view = null
    },
  }
}
