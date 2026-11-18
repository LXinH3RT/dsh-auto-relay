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
// Everything here is optional-service tolerant. A deployment with no
// `agentDefaultModel` or no `llm` service answers `unknown`, and `unknown` never
// blocks a hand-off: refusing to relay because a probe is missing would disable
// the feature on every stripped-down deployment.

import { runningSelection } from './model.js'

/**
 * Read the model selection the continuation session would start with.
 *
 * Order matters, and the second step is the one that changed: with nothing
 * configured the probe asks about **the route the predecessor is actually
 * running on**, not the profile default. Those differ whenever the session picked
 * another model in the picker, and they differ permanently once the profile
 * default names something the provider no longer advertises — the case this whole
 * check exists for. The successor is meant to continue this session's work, so
 * this session's route is the honest subject.
 *
 * A configured relay model still wins outright: when the user pinned
 * `relayProvider`/`relayModel`, that is what the successor will be bound to, so
 * probing anything else would answer a question nobody asked. The profile default
 * is the last resort, for a session that has never made a call.
 *
 * @param ctx - plugin context.
 * @param session - the session handing off.
 * @param pinned - a configured selection, or null/undefined for none.
 * @returns `{provider, model}` or null when no selection can be read.
 */
function selectionFor(ctx, session, pinned) {
  if (pinned !== null && pinned !== undefined) {
    if (typeof pinned.provider === 'string' && pinned.provider !== ''
      && typeof pinned.model === 'string' && pinned.model !== '') {
      return { provider: pinned.provider, model: pinned.model }
    }
  }
  const running = runningSelection(session)
  if (running !== null) return { provider: running.provider, model: running.model }
  const defaults = ctx.get?.('agentDefaultModel')
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      const current = defaults.currentSelection()
      if (current !== null && typeof current === 'object'
        && typeof current.provider === 'string' && current.provider !== ''
        && typeof current.model === 'string' && current.model !== '') {
        return { provider: current.provider, model: current.model }
      }
    } catch {
      // Nothing readable: report no selection.
    }
  }
  return null
}

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
 * @param options - `{ enabled, selection }`: `enabled: false` skips the probe
 *   entirely (the answer is always `ok`, so a user whose registry probe is wrong
 *   can still relay); `selection` is the configured relay model, which wins over
 *   everything else when present.
 * @returns a promise of `{ok, provider?, model?, reason?}`. `ok` is false only
 *   when the route is known to be unusable.
 */
export async function preflightModel(ctx, session, options = {}) {
  if (options.enabled === false) return { ok: true }
  const selection = selectionFor(ctx, session, options.selection)
  if (selection === null) return { ok: true, reason: 'no selection recorded' }
  const verdict = await probe(ctx, selection)
  if (verdict.state === 'ok') return { ok: true, provider: selection.provider, model: selection.model }
  if (verdict.state === 'unknown') {
    return { ok: true, provider: selection.provider, model: selection.model, reason: verdict.reason }
  }
  return {
    ok: false,
    provider: selection.provider,
    model: selection.model,
    reason: verdict.reason ?? `${selection.provider}/${selection.model} 不可用`,
  }
}
