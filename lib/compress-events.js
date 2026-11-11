// Recognising "a context compression just happened" in the session log.
//
// DSH's own compaction leaves a pair of durable markers:
//
//   compaction/start  { compactionId, sourceCommandId?, turn }
//   compaction/end    { …same fields, plus `error` when it failed }
//
// A profile that replaces DSH compaction with a proxy-side implementation — the
// common case is billion-context, which disables `dsh-compaction-basic` — never
// appends those. There the compression is a MODEL-DRIVEN TOOL CALL instead, and
// the log carries the ordinary pair:
//
//   tool/call    { turn, step, callId, name: 'compress', arguments }
//   tool/result  { turn, step, message: { toolCallId, isError, content: […text] } }
//
// `name` may also arrive MCP-prefixed as `mcp__bili__compress`. The result text
// is the report: `[Compressed m00001–m00002 → 2 block(s), …]` on success, and a
// `[Compression FAILED …]` / `refused` / `no-op` prefix otherwise.
//
// Both shapes are normalised here into one marker so the watchdog never has to
// know which implementation the profile runs. Keeping the recognition in a
// separate module also means the state machine stays testable with plain
// objects.
//
// Reading the occupancy is still the caller's job and still has to happen at
// the START marker: by the end marker the surface already holds the summary, so
// the meter would read small and every compression would look harmless.

/** billion-context's compress tool, in both the plain and MCP-prefixed spelling. */
export const DEFAULT_COMPRESS_TOOLS = ['compress', 'mcp__bili__compress']

/** Result prefixes billion-context uses when a compress call did NOT fold anything. */
const FAILURE_PREFIXES = ['[Compression FAILED', '[Compression refused', '[Compression no-op']

/** The success report prefix billion-context writes into the tool result. */
const SUCCESS_PREFIX = '[Compressed'

/**
 * Parse the configured tool-name list.
 *
 * Accepts a comma- or whitespace-separated string so the settings panel can
 * offer it as one text field. An unrecognised spelling simply matches nothing,
 * which degrades to "only DSH's own markers count".
 *
 * @param raw - the configured value.
 * @returns a Set of tool names to treat as a compression.
 */
export function parseCompressTools(raw) {
  const names = new Set()
  const text = typeof raw === 'string' ? raw : DEFAULT_COMPRESS_TOOLS.join(',')
  for (const part of text.split(/[\s,]+/u)) {
    const name = part.trim()
    if (name !== '') names.add(name)
  }
  // Without at least one name the tool path could never match; falling back
  // keeps a mistyped setting from silently disabling half the detection.
  if (names.size === 0) for (const name of DEFAULT_COMPRESS_TOOLS) names.add(name)
  return names
}

/** Join the text parts of a tool-result message. */
function resultText(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text
  }
  return text
}

/** A usable correlation id, or null when the event carries none. */
function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Classify one session event.
 *
 * @param event - `{type, seq, time, data}`.
 * @param toolNames - Set from {@link parseCompressTools}.
 * @returns `{phase:'start'|'end', id, failed?, source}` or null when the event
 *   is not a compression marker at all. `phase:'end'` with `failed:true` means
 *   the attempt changed nothing — it must neither count nor break a run.
 */
export function compressionMarker(event, toolNames) {
  const type = event?.type
  const data = event?.data ?? {}
  if (type === 'compaction/start') {
    return { phase: 'start', id: idOf(data.compactionId), source: 'compaction' }
  }
  if (type === 'compaction/end') {
    return { phase: 'end', id: idOf(data.compactionId), failed: data.error !== undefined, source: 'compaction' }
  }
  if (type === 'tool/call') {
    if (!toolNames.has(data.name)) return null
    return { phase: 'start', id: idOf(data.callId), source: 'tool' }
  }
  if (type === 'tool/result') {
    const id = idOf(data.message?.toolCallId)
    if (id === null) return null
    if (data.message?.isError === true) return { phase: 'end', id, failed: true, source: 'tool' }
    const text = resultText(data)
    if (text.startsWith(SUCCESS_PREFIX)) return { phase: 'end', id, failed: false, source: 'tool' }
    // A refusal or no-op is explicit evidence that nothing was folded, so it is
    // ignored rather than counted — but it also must not break the run, which is
    // why it reports `failed` instead of disappearing.
    if (FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      return { phase: 'end', id, failed: true, source: 'tool' }
    }
    // Any other result belongs to a different tool that happens to share an id
    // shape; the caller's id match already rejects it, and answering null keeps
    // "no evidence" distinct from "evidence of failure".
    return null
  }
  return null
}
