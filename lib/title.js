// Title continuation for the session this plugin hands off to.
//
// A conversation that keeps compressing is usually one long-running piece of
// work that the user already numbers by hand ("build-6", "test-3"). Handing the
// work to a fresh session should therefore not invent a name: it should take
// the next number in that same series, so the two sessions read as consecutive
// parts of one job rather than as unrelated conversations.
//
// A title WITHOUT a trailing number starts a series instead of being copied
// verbatim: `test` hands off to `test-1`, then `test-2`, and so on. Copying an
// unnumbered title unchanged would give two different sessions the same name,
// and falling back to a generic default would lose the work's identity.
//
// The separator is configuration, not a constant: `-` is only the common case.
// Any non-empty string works (`_`, `·`, ` v`, ` #`), and it is matched literally
// — a separator that happens to contain regex metacharacters escapes them here
// instead of quietly changing the pattern. It is also the connector appended
// when a title has no number yet, so the user only configures it once.
//
// A title that already carries a parenthesised counter (`build-2（1）`) is
// numbered the way DSH itself numbers a forked session: the counter inside the
// brackets is incremented in place, keeping the bracket style, so the title
// becomes `build-2（2）` rather than `build-2（1）(1)` or `build-2（1）-1`. This is
// checked BEFORE the separator, because `report-3（2）` belongs to the bracket
// series of `report-3`, not to a `-` series of `report-3（2）`.

/** The trailing bracket counter of `stem(N)`, if the title has one. */
function splitParenTitle(title) {
  const trimmed = title.trimEnd()
  // ASCII brackets and their full-width counterparts are separate styles: a
  // title written with one continues with the same one.
  for (const [open, close] of [['(', ')'], ['（', '）']]) {
    if (!trimmed.endsWith(close)) continue
    const marker = trimmed.lastIndexOf(open)
    if (marker <= 0) continue
    const digits = trimmed.slice(marker + open.length, trimmed.length - close.length)
    if (!/^\d+$/u.test(digits)) continue
    const stem = trimmed.slice(0, marker)
    // A bare counter (`(3)`) has no name to continue.
    if (stem.trim() === '') continue
    return { stem, digits, value: Number(digits), open, close }
  }
  return null
}

/** The trailing number of `stem<separator>N`, if the title has one. */
function splitNumberedTitle(title, separator) {
  if (separator === '') return null
  const trimmed = title.trimEnd()
  // The number must be the LAST thing in the title: `report-3-final` is a name
  // whose own series the plugin cannot continue, so it starts its own series.
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
 * @returns `{title, matched, started, from, to, style}`; `matched` is true when
 *   the current title carried a trailing number, `started` when a fresh series
 *   was begun at 1 for an unnumbered title, and `style` names which counter was
 *   advanced (`bracket`, `separator`, or `none`).
 */
export function nextTitle(title, separator, fallback) {
  const current = typeof title === 'string' ? title.trim() : ''
  if (current === '') {
    const bare = typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : ''
    return { title: bare, matched: false, started: false, from: null, to: null, style: 'none' }
  }
  // An empty separator turns numbering off entirely, bracket counters included:
  // one switch, one meaning. The title is then copied unchanged.
  if (separator === '') {
    return { title: current, matched: false, started: false, from: null, to: null, style: 'none' }
  }
  // A bracket counter wins over the separator: `build-2（1）` continues as
  // `build-2（2）`, not as `build-2（1）-1`.
  const bracketed = splitParenTitle(current)
  if (bracketed !== null) {
    const next = bracketed.value + 1
    // Zero padding inside the brackets is preserved for the same reason as for
    // separator numbers: it is how these names sort.
    const padded = bracketed.digits.length > 1 && bracketed.digits.startsWith('0')
      ? String(next).padStart(bracketed.digits.length, '0')
      : String(next)
    return {
      title: `${bracketed.stem}${bracketed.open}${padded}${bracketed.close}`,
      matched: true,
      started: false,
      from: bracketed.value,
      to: next,
      style: 'bracket',
    }
  }
  const split = splitNumberedTitle(current, separator)
  if (split !== null) {
    const next = split.value + 1
    // Preserve zero padding (`test-007` → `test-008`) because the padding is part
    // of how the user sorts these names, but never pad a number that outgrew it.
    const padded = split.digits.length > 1 && split.digits.startsWith('0')
      ? String(next).padStart(split.digits.length, '0')
      : String(next)
    return {
      title: `${split.stem}${separator}${padded}`,
      matched: true,
      started: false,
      from: split.value,
      to: next,
      style: 'separator',
    }
  }
  // No trailing number: begin the series at 1 using the same connector the user
  // configured for numbered titles. (The empty-separator case already returned
  // above, so there is always a connector here.)
  // A title that already ends in the separator (`test-`) must not get a doubled
  // one (`test--1`).
  const stem = current.endsWith(separator) ? current : `${current}${separator}`
  return {
    title: `${stem}1`,
    matched: false,
    started: true,
    from: null,
    to: 1,
    style: 'separator',
  }
}

/** Exported for tests: the raw splits, without the increment. */
export { splitNumberedTitle, splitParenTitle }
