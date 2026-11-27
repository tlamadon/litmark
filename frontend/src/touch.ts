/**
 * Whether the page is worked by touch: a finger, not a mouse.
 *
 * A touch screen selects text with a long press and a pair of handles, and
 * sends no mouse or touch release when the handles are let go, so what waits
 * for a release to see a selection never sees one there. It shows its own menu
 * by the selection too, which a page cannot turn off. Asked when needed, not
 * once: an iPad with a trackpad attached may answer either way.
 */
export const touchFirst = (): boolean =>
  window.matchMedia?.('(pointer: coarse)').matches ?? false

/** How long a selection must stay put before it counts as made, by touch. */
export const SELECTION_SETTLES_MS = 350
