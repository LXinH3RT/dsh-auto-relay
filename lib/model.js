// Pin the model a continuation session runs on.
//
// Why this cannot ride on the reservation: `schedule.create()`'s
// `new_once` target carries only `{cwd, agentPreset}`. There is no model
// field, so the successor is created with whatever the profile's default
// model is — which is exactly how a session once got created against a
// model that did not resolve, and died on its first call.
//
// Two ways out exist once the session is alive: `sessionController.selectModel`
// (the path the model picker uses) and `agent.model.select` (the path that
// records a selection without touching the saved default). This module takes the
// second one deliberately: a relay pinning its own successor's route must not
// rewrite the user's global default model behind their back.
//
// The successor does not exist until the scheduled delivery creates it, so
// binding is a short retry loop rather than a single call. Giving up quietly is
// correct: the relay already ran, and the pre-flight is what protects the case
// that matters.

/**
 * How many times to look for the session, and how long to wait between looks.
 *
 * Together these cover the scheduled delivery floor and then some: the successor
 * is created by the delivery, which the schedule service will not run sooner than
 * its own floor. Looking for a minute at half-second intervals covers that window
 * without polling hard.
 */
export const DEFAULT_ATTEMPTS = 120
export const DEFAULT_DELAY_MS = 500

/**
 * A selection from loose configuration values.
 *
 * @param provider - provider id, or a blank/absent value for "no opinion".
 * @param model - model id, or a blank/absent value for "no opinion".
 * @param reasoningEffort - optional effort id.
 * @returns the selection, or `null` when no complete pair was configured.
 */
export function selectionOf(provider, model, reasoningEffort) {
  const cleanProvider = typeof provider === 'string' ? provider.trim() : ''
  const cleanModel = typeof model === 'string' ? model.trim() : ''
  if (cleanProvider === '' || cleanModel === '') return null
  const effort = typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
  return effort === ''
    ? { provider: cleanProvider, model: cleanModel }
    : { provider: cleanProvider, model: cleanModel, reasoningEffort: effort }
}

/** One default sleep that a test can replace without touching timers. */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}

/**
 * The route a session is actually running on.
 *
 * Two sources, in this order. `requestHeader().config` is the header this
 * session's next request would carry: it is where a per-session `model/selection`
 * lands, and it is the only one of the two that names the reasoning effort.
 * `requestContext()` is what the provider itself returned for the last request, so
 * it names what really ran — but it carries no effort, which is why it is the
 * fallback rather than the first look.
 *
 * Reading the live session rather than the profile default is the whole point:
 * the profile default is a machine-wide setting, while what the predecessor was
 * doing is the job the successor is meant to continue. They diverge as soon as a
 * session picks another model in the picker, and they diverge permanently once
 * the default names a model that no longer resolves.
 *
 * @param session - the session handing off.
 * @returns `{provider, model, reasoningEffort?}` or null when unreadable.
 */
export function runningSelection(session) {
  const clean = (provider, model, effort) => {
    if (typeof provider !== 'string' || provider === '') return null
    if (typeof model !== 'string' || model === '') return null
    const trimmedEffort = typeof effort === 'string' ? effort.trim() : ''
    return trimmedEffort === ''
      ? { provider, model }
      : { provider, model, reasoningEffort: trimmedEffort }
  }
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const fromHeader = clean(header?.config?.provider, header?.config?.model, header?.config?.reasoningEffort)
    if (fromHeader !== null) return fromHeader
  } catch {
    // Unreadable header is not a failure: try the resolved context next.
  }
  try {
    const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
    const fromContext = clean(context?.provider, context?.model, context?.reasoningEffort)
    if (fromContext !== null) return fromContext
  } catch {
    // Fall through: nothing to read.
  }
  return null
}

/**
 * Bind a selection onto a session once it exists.
 *
 * `agent.model.select` records a `model/selection` event, which the request
 * header retires on the next request — so a session pinned before its first
 * model call starts on the pinned route, and one pinned after it switches on the
 * next turn. Both are useful; neither is guaranteed, which is why the caller
 * also runs the pre-flight.
 *
 * @param ctx - the plugin context.
 * @param sessionId - the reserved successor session id.
 * @param selection - the complete selection to apply, or `null` to do nothing.
 * @param options - `attempts`, `delayMs`, `sleep`, `log`, `warn` overrides.
 * @returns `{bound: boolean, reason?: string}`.
 */
export async function bindRelayModel(ctx, sessionId, selection, options = {}) {
  if (selection === null || selection === undefined) return { bound: false, reason: 'no selection configured' }
  if (typeof sessionId !== 'string' || sessionId === '') return { bound: false, reason: 'no session id' }
  const agents = ctx.get?.('agents')
  if (agents === undefined || typeof agents.get !== 'function') {
    return { bound: false, reason: 'agents service unavailable' }
  }
  const attempts = Number.isSafeInteger(options.attempts) && options.attempts > 0 ? options.attempts : DEFAULT_ATTEMPTS
  const delayMs = Number.isSafeInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : DEFAULT_DELAY_MS
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep
  const log = typeof options.log === 'function' ? options.log : () => {}
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let agent
    try {
      agent = agents.get(sessionId)
    } catch (error) {
      return { bound: false, reason: `lookup failed: ${String(error?.message ?? error)}` }
    }
    if (agent !== undefined && agent !== null) {
      const model = agent.model
      if (model === undefined || typeof model.select !== 'function') {
        return { bound: false, reason: 'agent has no model selection surface' }
      }
      try {
        model.select(selection)
        log(`dsh-auto-relay: 接力会话 ${sessionId} 已固定在 ${selection.provider}/${selection.model}`)
        return { bound: true }
      } catch (error) {
        warn(`dsh-auto-relay: 为接力会话 ${sessionId} 指定模型失败 — ${String(error?.message ?? error)}`)
        return { bound: false, reason: 'select threw' }
      }
    }
    if (attempt + 1 < attempts) await sleep(delayMs)
  }
  // Not finding the session is the normal outcome when the delivery never
  // happens (the floor is 60 s, and a cancelled task never creates one).
  return { bound: false, reason: 'session never appeared' }
}
