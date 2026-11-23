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
// WHEN the selection lands is as load-bearing as what it says. `model/selection`
// only becomes the route of the NEXT request: the `modelSelection` projection
// parks it in `pending` and the following `request/header` is what retires it. So
// a selection written after the successor's first request is one request too
// late — and the first request is the only one that matters here, because a
// successor created against an unusable default dies on it.
//
// A 500 ms poll loses that race on this machine: a delivered session goes from
// "created" to `request/header` in about 1.5 s, and one relay landed its
// `model/selection` four milliseconds AFTER the header it was supposed to
// prevent. Polling is therefore the fallback, not the mechanism. The mechanism is
// `agent/created`: the agent factory awaits that serial dispatch while the agent
// is entered but before the loop's first turn, so a selection appended there is
// in place before `lib/agent-loop` reads `model.current()` — the same seam
// `@deepseek-ai/dsh-tool-subagent` uses to authorize routes for fresh sessions.

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
 * Pin the successor's route before its first request instead of after it.
 *
 * `expect(sessionId, selection)` records what a reserved session should run on;
 * the `agent/created` listener applies it the instant the delivery creates that
 * session. The agent factory awaits this dispatch while the agent is entered but
 * before the loop's first turn, so the selection is in the log before
 * `model.current()` is read — which is what makes the very first request use it.
 *
 * The reservation is dropped as soon as it is applied, and entries that never
 * meet their session are forgotten after `ttlMs` so a cancelled task cannot leak.
 *
 * @param options.ctx - the plugin context (needs `on` and optional `effect`).
 * @param options.log - informational sink.
 * @param options.warn - warning sink.
 * @param options.now - clock, injectable for tests.
 * @param options.ttlMs - how long an unmatched expectation is kept.
 * @returns `{expect, dispose, inspect}` — `dispose` unsubscribes.
 */
export function createCreationBinding(options = {}) {
  const ctx = options.ctx
  const log = typeof options.log === 'function' ? options.log : () => {}
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 10 * 60 * 1000

  /** Reserved session id to the selection waiting for it. */
  const expected = new Map()

  function forgetStale() {
    const cutoff = now() - ttlMs
    for (const [id, entry] of expected) {
      if (entry.at < cutoff) expected.delete(id)
    }
  }

  const dispose = typeof ctx?.on === 'function'
    ? ctx.on('agent/created', ({ agent }) => {
      const id = agent?.id
      if (typeof id !== 'string' || id === '') return
      forgetStale()
      const entry = expected.get(id)
      if (entry === undefined) return
      expected.delete(id)
      const model = agent.model
      if (model === undefined || typeof model.select !== 'function') {
        warn(`dsh-auto-relay: 接力会话 ${id} 没有可用的模型接口，无法在首次请求前固定模型`)
        return
      }
      try {
        model.select(entry.selection)
        log(`dsh-auto-relay: 接力会话 ${id} 已在首次请求前固定在 ${entry.selection.provider}/${entry.selection.model}`)
      } catch (error) {
        warn(`dsh-auto-relay: 为接力会话 ${id} 指定模型失败 — ${String(error?.message ?? error)}`)
      }
    })
    : () => {}

  return {
    /**
     * Remember the route a reserved session should start on.
     *
     * @param sessionId - the id `schedule.create` reserved.
     * @param selection - `{provider, model, reasoningEffort?}`, or null to skip.
     */
    expect(sessionId, selection) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (selection === null || selection === undefined) return
      forgetStale()
      expected.set(sessionId, { selection, at: now() })
    },

    /** Read-only view, for diagnostics and tests. */
    inspect() {
      return Array.from(expected.entries()).map(([id, entry]) => ({ sessionId: id, selection: entry.selection }))
    },

    dispose() {
      if (typeof dispose === 'function') dispose()
      expected.clear()
    },
  }
}

/**
 * Bind a selection onto a session once it exists — the FALLBACK path.
 *
 * Prefer {@link createCreationBinding}: it applies the selection from
 * `agent/created`, before the successor's first request. This poll cannot win that
 * race (a delivered session reaches `request/header` in about 1.5 s, and the poll
 * only notices the session once it exists), so it is kept for the case the
 * creation hook cannot cover — a session that was created while no expectation
 * was registered (a resumed delivery, or a host that announced it late).
 *
 * `agent.model.select` records a `model/selection` event, which the request
 * header retires on the next request — so a session pinned here starts on the
 * pinned route only if its first request has not gone out yet.
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
