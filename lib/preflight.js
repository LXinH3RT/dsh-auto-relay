// Does the continuation session have a model it can actually call?
//
// The hand-off is only worth making if the session it creates can run. On this
// machine one relay died on its very first model call — `turn/end` carried
// `UNKNOWN_MODEL: pi-ai provider "workbuddy" has no configured model "hy4free"` —
// because the profile's default model was a name the provider had stopped
// advertising. The task was delivered, the successor session existed, and it was
// empty: the old session had already handed its work over and the new one could
// do nothing with it.
//
// The check is a pre-flight, not a guarantee: it asks the registry whether the
// selection RESOLVES, which is exactly what the first request would do. A route
// that resolves now can still fail later (quota, outage), which is why the
// watchdog also watches the successor's first turn (see `lib/watch.js`).
//
// WHICH selection to ask about is the subtle part, and getting it wrong is how a
// relay died on this machine: the reservation (`new_once`) carries only
// `{cwd, agentPreset}`, so a successor is created with the profile default model
// — and `model/selection` written afterwards does not change the request that is
// already in flight. Probing the route we INTENDED to pin therefore answered a
// question nobody asked, and said "fine" about a successor that was about to run
// on `deepseek-official/deepseek-flash` with no credential for it.
//
// So this module asks about the route the successor's FIRST request will carry:
// the pinned selection when `lib/model.js`'s creation hook is in place (it writes
// `model/selection` from `agent/created`, before the loop's first turn), and the
// profile default otherwise.
//
// Everything here is optional-service tolerant. A deployment with no
// `agentDefaultModel` or no `llm` service answers `unknown`, and `unknown` never
// blocks a hand-off: refusing to relay because a probe is missing would disable
// the feature on every stripped-down deployment.

import { runningSelection } from './model.js'

/** Read the profile default route, or null when the service is absent/empty. */
function defaultSelection(ctx) {
  const defaults = ctx.get?.('agentDefaultModel')
  if (defaults === undefined || typeof defaults.currentSelection !== 'function') return null
  try {
    const current = defaults.currentSelection()
    if (current !== null && typeof current === 'object'
      && typeof current.provider === 'string' && current.provider !== ''
      && typeof current.model === 'string' && current.model !== '') {
      return { provider: current.provider, model: current.model }
    }
  } catch {
    // Nothing readable.
  }
  return null
}

/**
 * The route the successor's first request will carry.
 *
 * `binding` records whether a `model/selection` is guaranteed to be written before
 * that request — which is exactly what `createCreationBinding` does. With it, the
 * pinned route IS the first route. Without it, the pinned route only takes effect
 * from the next request onwards, so the first route is the profile default and
 * saying anything else about it would be a lie.
 *
 * @param ctx - plugin context.
 * @param session - the session handing off (used only when neither is readable).
 * @param options - `{selection, binding}`.
 * @returns `{route, source, deferred}` where `source` names where the answer came
 *   from and `deferred` is a pinned route that will only apply after a call.
 */
function firstRouteFor(ctx, session, options = {}) {
  const pinned = options.selection ?? null
  const validPinned = pinned !== null
    && typeof pinned.provider === 'string' && pinned.provider !== ''
    && typeof pinned.model === 'string' && pinned.model !== ''
    ? { provider: pinned.provider, model: pinned.model }
    : null

  if (validPinned !== null && options.binding === true) {
    return { route: validPinned, source: 'relay', deferred: null }
  }

  const fallback = defaultSelection(ctx)
  if (fallback !== null) {
    // Without the creation hook the reservation's session starts on the default
    // and only switches on the request after next — if it survives that far.
    return { route: fallback, source: 'default', deferred: options.binding === true ? null : validPinned }
  }

  if (validPinned !== null) return { route: validPinned, source: 'relay', deferred: null }

  const running = runningSelection(session)
  if (running !== null) return { route: { provider: running.provider, model: running.model }, source: 'running', deferred: null }
  return { route: null, source: 'none', deferred: null }
}

/**
 * Read the model selection the continuation session would start with.
/**
 * Ask the registry whether one route resolves.
 *
 * @param ctx - plugin context.
 * @param selection - `{provider, model}`.
 * @returns a promise of `{state, reason?}` where state is `ok`, `unavailable`,
 *   or `unknown` (no `llm` service, or the lookup itself threw something that is
 *   not a model-resolution failure).
 */
async function probe(ctx, selection) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    return { state: 'unknown', reason: 'no llm service' }
  }
  try {
    await llm.resolveModelInfo(selection.provider, selection.model)
    return { state: 'ok' }
  } catch (error) {
    const message = String(error?.message ?? error)
    // A registry that is merely busy or shutting down must not read as "this
    // model is broken": only a resolution failure does.
    const code = String(error?.code ?? '')
    const looksUnresolvable = /UNKNOWN_MODEL|UNKNOWN_PROVIDER|MODEL_UNAVAILABLE|no configured model|unknown provider|no such model/iu.test(`${code} ${message}`)
    return looksUnresolvable ? { state: 'unavailable', reason: message } : { state: 'unknown', reason: message }
  }
}

/**
 * Decide whether a hand-off may proceed.
 *
 * @param ctx - plugin context.
 * @param session - the session handing off.
 * @param options - `{ enabled, selection, binding }`. `enabled: false` skips the
 *   probe entirely (the answer is always `ok`, so a user whose registry probe is
 *   wrong can still relay). `selection` is the configured/inherited relay route.
 *   `binding` says whether a creation hook will write that route before the
 *   successor's first request; when it will not, the first request runs on the
 *   profile default and that is what gets probed.
 * @returns a promise of `{ok, provider?, model?, reason?, deferred?}`. `ok` is
 *   false only when the route the successor will actually start on is known to be
 *   unusable.
 */
export async function preflightModel(ctx, session, options = {}) {
  if (options.enabled === false) return { ok: true }
  const { route, source, deferred } = firstRouteFor(ctx, session, {
    selection: options.selection ?? null,
    binding: options.binding === true,
  })
  if (route === null) return { ok: true, reason: 'no selection recorded' }
  const verdict = await probe(ctx, route)
  const base = { provider: route.provider, model: route.model, source, ...(deferred === null ? {} : { deferred }) }
  if (verdict.state === 'ok') return { ok: true, ...base }
  if (verdict.state === 'unknown') return { ok: true, ...base, reason: verdict.reason }
  return {
    ok: false,
    ...base,
    reason: verdict.reason ?? `${route.provider}/${route.model} 不可用`,
  }
}
