/**
 * Whether a media query holds for a window of a given size, for the tests
 * that have no browser to ask: the few things the layout asks about — how
 * wide the window is, whether it is taller than wide, whether it is worked
 * by touch. Anything else it is asked, it says no to.
 */
export function mediaMatches(query, { width, height = 0, touch = false }) {
  return query.split(',').some((one) =>
    one
      .trim()
      .split(/\s+and\s+/)
      .every((part) => {
        const limit = /^\(max-width: ([\d.]+)px\)$/.exec(part)
        if (limit) return width <= Number(limit[1])
        if (part === '(orientation: portrait)') return height >= width
        if (part === '(any-pointer: coarse)' || part === '(pointer: coarse)') return touch
        return false
      }),
  )
}
