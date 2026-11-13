// The one piece of information the Host half must hand to the browser half.
//
// Archiving the old conversation and switching the interface to the new one are
// CLIENT-side actions: only the browser holds the visible selection, and only
// `ctx.uiWorkspace` can move it. The Host plugin, which is what decides the
// hand-off, cannot call into a client service and cannot push a custom event
// (`ctx.remote.$on` accepts a fixed list of forwarded names), so the intent has
// to travel on something both sides already share.
//
// It travels on the delivered prompt. The prompt is the only field of a
// scheduled task that the plugin both writes and the client can read back
// through `ctx.remote.schedule.catalog()`, and reading it is side-effect free.
// One line, written once, at the end of the prompt, carries the three facts the
// client cannot derive on its own:
//
//     [dsh-auto-relay] from=session-abc open=1 archive=1
//
// `from` is the session that handed off — the client must not archive "whatever
// is on screen", because by the time it acts the user may have moved elsewhere.
// `open` asks it to show the relay session; `archive` asks it to archive `from`.
// Nothing to ask for means the line is not written at all, and a prompt without
// the line is a prompt the client must not act on — which is what keeps it from
// reacting to tasks the user created by hand.
//
// The line also reads honestly to the continuation model: it names the plugin
// that created the session. The parsing rule is deliberately trivial (find the
// line, read the three tokens) because the client bundle cannot import this
// module — it is a standalone classic script — so the two implementations stay
// in agreement by inspection and a test in `test/mount.mjs` asserts the pair.

/** The line prefix that marks a relay prompt. */
export const MARKER_PREFIX = '[dsh-auto-relay]'

/**
 * Render the marker line for one hand-off.
 *
 * @param {{from?: string, open?: boolean, archive?: boolean}} intent - what the
 *   client should do and which session handed off.
 * @returns the marker line, or `''` when there is nothing to ask for.
 */
export function relayMarker(intent) {
  const from = typeof intent?.from === 'string' ? intent.from.trim() : ''
  const open = intent?.open === true
  const archive = intent?.archive === true
  if (!open && !archive) return ''
  // Archiving without showing the successor would blank the conversation pane:
  // the client clears the main view when the archived session is the open one.
  // The Host does not encode that as an error; it encodes the dependency.
  const show = open || archive
  const parts = [MARKER_PREFIX]
  if (from !== '') parts.push(`from=${from}`)
  parts.push(`open=${show ? 1 : 0}`, `archive=${archive ? 1 : 0}`)
  return parts.join(' ')
}

/**
 * Read the marker line back out of a prompt.
 *
 * @param {unknown} prompt - the task prompt, possibly user-authored.
 * @returns {{from: string | null, open: boolean, archive: boolean} | null} the
 *   intent, or null when the prompt was not written by this plugin.
 */
export function parseMarker(prompt) {
  if (typeof prompt !== 'string' || !prompt.includes(MARKER_PREFIX)) return null
  const line = prompt.split('\n').find((entry) => entry.startsWith(MARKER_PREFIX))
  if (line === undefined) return null
  const from = /\bfrom=(\S+)/u.exec(line)
  return {
    from: from?.[1] === undefined ? null : from[1],
    open: /\bopen=1\b/u.test(line),
    archive: /\barchive=1\b/u.test(line),
  }
}

/**
 * Append the marker to a rendered prompt.
 *
 * @param {string} prompt - the prompt the user's template produced.
 * @param {{from?: string, open?: boolean, archive?: boolean}} intent - what the
 *   client should do and which session handed off.
 * @returns the prompt, with the marker as its own trailing line when needed.
 */
export function withMarker(prompt, intent) {
  const line = relayMarker(intent)
  if (line === '') return prompt
  return `${prompt.replace(/\s+$/u, '')}\n\n${line}`
}
