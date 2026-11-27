/**
 * The phone's layout, apart from how it is drawn: when it applies, which pane
 * is on show, where an action leads, and what the Chat tab says. See
 * `Phone.tsx` for the bars, and `App.tsx` for where the panes are put.
 *
 * A window too narrow for the panes side by side — a phone, a tablet held
 * upright — shows one at a time — the text, the paper, the chat — and a bar
 * along the bottom goes between them.
 * The three stay as they were left: a pane not on show is hidden, not taken
 * away, so coming back to it is coming back to the same place.
 */

/**
 * Narrower than this many CSS pixels, a window is laid out as a phone. The one
 * place the cutoff is said: the stylesheet hangs off the `phone` class the
 * shell is given from it, and has no width of its own to keep in step.
 *
 * A tablet held upright is on this side of it — an iPad is 744 to 834 wide
 * that way — and has the layout too: one pane with the whole width, which is
 * what a page of a paper wants there. On its side, 1024 wide and more, it has
 * the room for the panes side by side.
 */
export const PHONE_BELOW = 900

/** Just short of the cutoff, so a window of exactly that width is not a phone. */
export const PHONE_QUERY = `(max-width: ${PHONE_BELOW - 0.02}px)`

/** The panes, in the order they sit on a wide window, left to right. */
export type PhoneTab = 'text' | 'paper' | 'chat'
export const PHONE_TABS: readonly PhoneTab[] = ['text', 'paper', 'chat']

/** What fills the screen: one of the panes, or the library laid over them. */
export type PhonePane = PhoneTab | 'library'

/** Whether there is anything behind the two tabs that can be empty. */
export interface Behind {
  /** A note, a summary or the summarizing skill is open. */
  text: boolean
  /** A paper is open. */
  paper: boolean
}

/**
 * What is on show.
 *
 * A tab the reader chose is shown, whatever is behind it: a pane with nothing
 * open says so, and offers the way to open something. Until one is chosen — a
 * session just come to — it is whichever reading pane has something in it,
 * the text first; and with neither, the library, which is where one starts.
 */
export function shownPane(tab: PhoneTab | null, behind: Behind, library: boolean): PhonePane {
  if (library) return 'library'
  if (tab !== null) return tab
  return behind.text ? 'text' : behind.paper ? 'paper' : 'library'
}

/** The two kinds of thing the library holds, each on a tab of its own there. */
export type LibraryKind = 'papers' | 'notes'

/** What a pane is filled from: notes for the text, papers for the paper. */
export function kindFor(tab: PhoneTab): LibraryKind | null {
  return tab === 'text' ? 'notes' : tab === 'paper' ? 'papers' : null
}

/** How long a tab must have been the one on before a press on it means more. */
export const RETAP_AFTER_MS = 700

/**
 * What a press on the tab that is already on opens in the library: the kind
 * that tab is filled from. Not straight after the tab came on — the second
 * press of a double tap is the first one again, not a request for something
 * else — and never for the chat, which is not opened from the library.
 */
export function retapOpens(tab: PhoneTab, onForMs: number): LibraryKind | null {
  return onForMs < RETAP_AFTER_MS ? null : kindFor(tab)
}

/** What a session holds besides its conversation, as it is said in the menu. */
export interface Held {
  text: string | null
  paper: string | null
}

/**
 * What a session holds: the text open in it and the paper, by name. A session
 * is the set of them, and the menu that goes between sessions says so for
 * each. What is no longer in the project is not named.
 */
export function heldIn(
  view: {
    target:
      | { kind: 'note'; noteId: string }
      | { kind: 'summary'; documentId: string }
      | { kind: 'skill' }
      | { kind: 'empty' }
    documentId: string | null
  },
  names: { note: (id: string) => string | null; paper: (id: string) => string | null },
): Held {
  const paper = view.documentId ? names.paper(view.documentId) : null
  const { target } = view
  let text: string | null = null
  if (target.kind === 'note') text = names.note(target.noteId)
  else if (target.kind === 'skill') text = 'Summarizing skill'
  else if (target.kind === 'summary') {
    const of = names.paper(target.documentId)
    // The summary of the paper beside it needs no second naming.
    if (of !== null) text = target.documentId === view.documentId ? 'Summary' : `Summary of ${of}`
  }
  return { text, paper }
}

/**
 * Where the reader is once a request about a passage has been sent: taken to
 * the chat, where the answer is read, or left with the passage and a dot on
 * the Chat tab. The one switch to change it.
 */
export const AFTER_ASK: 'chat' | 'stay' = 'chat'

/**
 * A paper opened from the library, or from what it is related to, lands on
 * its summary when it has one, with the PDF behind the Paper tab; a paper
 * with nothing written about it yet lands on the PDF.
 */
export function tabForPaper(summaryStatus: string | null | undefined): PhoneTab {
  return summaryStatus === 'ready' ? 'text' : 'paper'
}

/** What the Chat tab says of the conversation behind it. */
export type ChatSign = 'working' | 'answered' | 'failed' | null

/**
 * The sign on the Chat tab: the agent at work while a run is going; a reply
 * that came in since the chat was last looked at, once it has stopped.
 */
export function chatSign(
  conversation: { status: string; last_run_status?: string | null } | null | undefined,
  waiting: boolean,
): ChatSign {
  if (conversation && conversation.status !== 'idle') return 'working'
  if (!waiting) return null
  return conversation?.last_run_status === 'failed' ? 'failed' : 'answered'
}

/**
 * The conversations with a reply nobody has looked at yet, after a run in one
 * of them finished. `looking` is the conversation whose chat is on show at
 * that moment, if any is: a reply read as it arrives is not one that waits.
 */
export function afterReply(
  waiting: ReadonlySet<string>,
  finished: string,
  looking: string | null,
): ReadonlySet<string> {
  if (finished === looking || waiting.has(finished)) return waiting
  return new Set(waiting).add(finished)
}

/** The same, once the chat of a conversation has been looked at. */
export function afterLooking(waiting: ReadonlySet<string>, looked: string | null): ReadonlySet<string> {
  if (looked === null || !waiting.has(looked)) return waiting
  const next = new Set(waiting)
  next.delete(looked)
  return next
}

/**
 * Whether what has the focus is somewhere text is typed: the on-screen
 * keyboard is up for it, and the bar along the bottom gets out of its way.
 * A button, a checkbox or a list to pick from brings up no keyboard.
 */
export function takesTyping(element: Element | null): boolean {
  if (!element || !element.isConnected) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA') return !(element as HTMLTextAreaElement).readOnly
  if (tag === 'INPUT') {
    const input = element as HTMLInputElement
    return !input.readOnly && !NOT_TYPED_IN.has(input.type)
  }
  // The editor, once it is being edited: reading, it only holds the focus.
  const editable = element.closest('[contenteditable]')?.getAttribute('contenteditable')
  return editable === 'true' || editable === '' || editable === 'plaintext-only'
}

/** What is known of the keyboard on the screen: nothing, that it is up, or that it was put away. */
export type Keyboard = 'unknown' | 'up' | 'down'

/**
 * What is known of the keyboard after the part of the window that can be seen
 * changed, as a share of the window's height.
 *
 * Some phones put the keyboard away and leave the box with the focus: going
 * by the focus alone, the bar along the bottom would stay away with nothing
 * in its place. A keyboard seen to come up — it covered a good part of the
 * window — and then seen gone is one that was put away. Where the browser
 * shrinks the window itself for the keyboard, nothing is ever seen covered,
 * and nothing is concluded: the focus is then all there is to go by.
 */
export function keyboardAfter(before: Keyboard, seen: number): Keyboard {
  if (seen < 0.8) return 'up'
  if (before === 'up' && seen > 0.9) return 'down'
  return before
}

const NOT_TYPED_IN = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])
