// Title continuation for the session this plugin hands off to.
//
// A conversation that keeps compressing is usually one long-running piece of
// work that the user already numbers by hand ("build-6", "test-3"). Handing the
// work to a fresh session should therefore not invent a name: it should take
// the next number in that same series, so the two sessions read as consecutive
// parts of one job rather than as unrelated conversations.
//
// The separator is configuration, not a constant: `-` is only the common case.
// Any non-empty string works (`_`, `·`, ` v`, ` #`), and it is matched literally
// — a separator that happens to contain regex metacharacters escapes them here
// instead of quietly changing the pattern.

/** The trailing number of `stem<separator>N`, if the title has one. */
function splitNumberedTitle(title, separator) {
  if (separator === '') return null
  const trimmed = title.trimEnd()
  // The number must be the LAST thing in the title: `report-3-final` is a name
  // whose own series the plugin cannot guess, so it is left alone.
  const marker = trimmed.lastIndexOf(separator)
  if (marker <= 0) return null
  const digits = trimmed.slice(marker + separator.length)
  if (!/^\d+$/u.test(digits)) return null
  const stem = trimmed.slice(0, marker)
  // A bare separator with no stem (`-3`) has nothing to continue.
  if (stem.trim() === '') return null
  return { stem, digits, value: Number(digits) }
}

/**
 * Compute the title for the continuation session.
 *
 * @param title - the current session's title, or undefined when it has none.
 * @param separator - the configured stem/number separator.
 * @param fallback - the title to use when the current one is missing entirely.
 * @returns `{title, matched, from, to}`; `matched` is false when the current
 *   title carried no trailing number and is therefore reused unchanged.
 */
export function nextTitle(title, separator, fallback) {
  const current = typeof title === 'string' ? title.trim() : ''
  if (current === '') {
    const bare = typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : ''
    return { title: bare, matched: false, from: null, to: null }
  }
  const split = splitNumberedTitle(current, separator)
  if (split === null) return { title: current, matched: false, from: null, to: null }
  const next = split.value + 1
  // Preserve zero padding (`test-007` → `test-008`) because the padding is part
  // of how the user sorts these names, but never pad a number that outgrew it.
  const padded = split.digits.length > 1 && split.digits.startsWith('0')
    ? String(next).padStart(split.digits.length, '0')
    : String(next)
  return {
    title: `${split.stem}${separator}${padded}`,
    matched: true,
    from: split.value,
    to: next,
  }
}

/** Exported for tests: the raw split, without the increment. */
export { splitNumberedTitle }
