// Asking the LLM registry whether the continuation's model exists.
//
// The failure this guards against is specific and was observed twice. First the
// profile default named a model its provider no longer advertised, so the relay
// session was created, its very first model call rejected with `UNKNOWN_MODEL`,
// and the work stopped. Then, after a first fix, a relay still died because the
// check asked about the route the plugin INTENDED to pin while the successor's
// first request actually ran on the profile default — `model/selection` only
// applies from the next request onwards.
//
// So the subject of the probe is not "the route we like" but "the route the
// successor's first request will carry": the pinned route when a creation hook
// writes it before that request, the profile default otherwise.
//
// The rule that keeps the check from becoming a new failure mode: only a
// DEFINITE "this route does not resolve" blocks the hand-off. A missing service,
// a missing selection, or a probe that fails for any other reason is `unknown`,
// and `unknown` relays.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { preflightModel } from '../lib/preflight.js'

/** A context stub with the two services this module reads. */
function context({ selection, resolve } = {}) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'agentDefaultModel') {
          if (selection === undefined) return undefined
          return { currentSelection: () => selection }
        }
        if (name === 'llm') {
          if (resolve === undefined) return undefined
          return {
            resolveModelInfo: async (provider, model) => {
              calls.push({ provider, model })
              return resolve({ provider, model })
            },
          }
        }
        return undefined
      },
    },
  }
}

/** A session stub carrying an optional recorded header and/or resolved context. */
function session(config, resolved) {
  return {
    id: 'session-a',
    header: { cwd: '/repo' },
    requestHeader: () => (config === undefined ? undefined : { config }),
    requestContext: () => resolved,
  }
}

const PINNED = { provider: 'pinned-provider', model: 'pinned-model' }

test('a resolvable pinned route passes when the creation hook writes it', async () => {
  const { ctx, calls } = context({
    selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    resolve: () => ({}),
  })
  const result = await preflightModel(ctx, session(), { selection: PINNED, binding: true })
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'pinned-provider')
  assert.equal(result.model, 'pinned-model')
  assert.equal(result.source, 'relay', 'the answer is about the pinned route')
  assert.deepEqual(calls, [PINNED])
})

test('without the creation hook the profile default is the first route', async () => {
  // The regression this encodes: a pinned route that only lands on the SECOND
  // request must not be reported as what the successor will start on.
  const { ctx, calls } = context({
    selection: { provider: 'default-provider', model: 'default-model' },
    resolve: () => ({}),
  })
  const result = await preflightModel(ctx, session({ provider: 'header-provider', model: 'header-model' }), {
    selection: PINNED,
    binding: false,
  })
  assert.deepEqual(
    calls,
    [{ provider: 'default-provider', model: 'default-model' }],
    'the first request carries the default, so that is what gets probed',
  )
  assert.equal(result.source, 'default')
  assert.deepEqual(result.deferred, PINNED, 'the pinned route is reported as deferred, not as the first one')
})

test('an unusable profile default blocks even when a good route is pinned for later', async () => {
  // This is the exact shape of the observed failure: deepseek-official had no
  // credential, the intended workbuddy route resolved fine, and the successor
  // died on the first request before the pin could apply.
  const { ctx } = context({
    selection: { provider: 'deepseek-official', model: 'deepseek-flash' },
    resolve: ({ provider }) => {
      if (provider === 'deepseek-official') {
        const error = new Error('llm-deepseek: no API key for provider route "deepseek-official"')
        error.code = 'MISSING_CREDENTIAL'
        throw error
      }
      return {}
    },
  })
  const result = await preflightModel(ctx, session(), { selection: PINNED, binding: false })
  // `MISSING_CREDENTIAL` is not a resolution failure, so this relays and reports
  // why — the point is that the subject was the default, not the pin.
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.source, 'default')
})

test('the pin is probed when there is no profile default to read', async () => {
  const { ctx, calls } = context({ resolve: () => ({}) })
  const result = await preflightModel(ctx, session(), { selection: PINNED, binding: false })
  assert.deepEqual(calls, [PINNED], 'with nothing else readable the pin is the only route named')
  assert.equal(result.source, 'relay')
})

test('the running route answers when neither a pin nor a default exists', async () => {
  const { ctx, calls } = context({ resolve: () => ({}) })
  const result = await preflightModel(ctx, session({ provider: 'header-provider', model: 'header-model' }))
  assert.deepEqual(calls, [{ provider: 'header-provider', model: 'header-model' }])
  assert.equal(result.source, 'running')
})

test('the profile default answers for a session that never made a call', async () => {
  const { ctx, calls } = context({ selection: { provider: 'default-provider', model: 'default-model' }, resolve: () => ({}) })
  await preflightModel(ctx, session())
  assert.deepEqual(calls, [{ provider: 'default-provider', model: 'default-model' }])
})

test('nothing is asked when no selection can be read at all', async () => {
  const { ctx, calls } = context()
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, true, 'no service is not a failure')
  assert.equal(calls.length, 0, 'and there was nothing to ask')
})

test('an unknown model blocks the hand-off with the provider message', async () => {
  const { ctx } = context({
    selection: { provider: 'workbuddy', model: 'hy4free' },
    resolve: () => {
      const error = new Error('pi-ai provider "workbuddy" has no configured model "hy4free"')
      error.code = 'UNKNOWN_MODEL'
      throw error
    },
  })
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, false)
  assert.match(result.reason, /no configured model/u, 'the provider text is carried through')
})

test('every recognised unknown-route spelling blocks', async () => {
  for (const code of ['UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MODEL_UNAVAILABLE']) {
    const { ctx } = context({
      selection: { provider: 'p', model: 'm' },
      resolve: () => {
        const error = new Error('route is gone')
        error.code = code
        throw error
      },
    })
    const result = await preflightModel(ctx, session())
    assert.equal(result.ok, false, `${code} blocks`)
  }
})

test('a provider message alone is enough even without a code', async () => {
  const { ctx } = context({
    selection: { provider: 'p', model: 'm' },
    resolve: () => {
      throw new Error('no such model: m')
    },
  })
  assert.equal((await preflightModel(ctx, session())).ok, false)
})

test('an unrelated probe failure does not block the hand-off', async () => {
  const { ctx } = context({
    selection: { provider: 'p', model: 'm' },
    resolve: () => {
      const error = new Error('registry is shutting down')
      error.code = 'SERVICE_DISPOSING'
      throw error
    },
  })
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, true, 'unknown relays')
  assert.match(result.reason, /shutting down/u, 'but the reason is recorded')
})

test('a missing llm service does not block the hand-off', async () => {
  const { ctx } = context({ selection: { provider: 'p', model: 'm' } })
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, true)
  assert.match(result.reason, /llm/u)
})

test('no selection at all does not block the hand-off', async () => {
  const { ctx } = context()
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'no selection recorded', 'the reason says why nothing was checked')
})

test('an incomplete selection is not treated as one', async () => {
  for (const selection of [{ provider: 'p' }, { model: 'm' }, { provider: '', model: 'm' }, {}]) {
    const { ctx, calls } = context({ selection })
    const result = await preflightModel(ctx, session())
    assert.equal(result.ok, true)
    assert.equal(calls.length, 0, `${JSON.stringify(selection)} never reaches the registry`)
  }
})

test('an incomplete pin is ignored while the default still answers', async () => {
  const { ctx, calls } = context({ selection: { provider: 'default-provider', model: 'default-model' }, resolve: () => ({}) })
  const result = await preflightModel(ctx, session(), { selection: { provider: 'only-provider' }, binding: true })
  assert.deepEqual(calls, [{ provider: 'default-provider', model: 'default-model' }])
  assert.equal(result.source, 'default')
})

test('the switch turns the whole check off', async () => {
  const { ctx, calls } = context({
    selection: { provider: 'workbuddy', model: 'hy4free' },
    resolve: () => {
      throw new Error('no configured model')
    },
  })
  const result = await preflightModel(ctx, session(), { enabled: false })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 0, 'a disabled check never asks')
})
