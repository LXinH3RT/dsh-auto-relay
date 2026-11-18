// Asking the LLM registry whether the continuation's model exists.
//
// The failure this guards against is specific and was observed: the profile's
// default model named a model its provider no longer advertised, so the relay
// session was created, its very first model call rejected with `UNKNOWN_MODEL`,
// and the work stopped. One lookup before creating anything turns that into a
// skipped hand-off with a warning.
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

test('a resolvable model passes', async () => {
  const { ctx } = context({ selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } })
  const result = await preflightModel(ctx, session())
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'workbuddy')
  assert.equal(result.model, 'deepseek-v4.1-flash')
})

test('the running route wins over the profile default', async () => {
  const { ctx, calls } = context({
    selection: { provider: 'default-provider', model: 'default-model' },
    resolve: () => ({}),
  })
  await preflightModel(ctx, session({ provider: 'header-provider', model: 'header-model' }))
  assert.deepEqual(
    calls,
    [{ provider: 'header-provider', model: 'header-model' }],
    'the successor continues on the model that was doing the work',
  )
})

test('the resolved context answers when no header was recorded yet', async () => {
  const { ctx, calls } = context({ resolve: () => ({}) })
  await preflightModel(ctx, session(undefined, { provider: 'ctx-provider', model: 'ctx-model' }))
  assert.deepEqual(calls, [{ provider: 'ctx-provider', model: 'ctx-model' }])
})

test('the profile default answers for a session that never made a call', async () => {
  const { ctx, calls } = context({ selection: { provider: 'default-provider', model: 'default-model' }, resolve: () => ({}) })
  await preflightModel(ctx, session())
  assert.deepEqual(calls, [{ provider: 'default-provider', model: 'default-model' }])
})

test('a configured relay pair outranks the running route', async () => {
  const { ctx, calls } = context({ resolve: () => ({}) })
  await preflightModel(ctx, session({ provider: 'header-provider', model: 'header-model' }), {
    selection: { provider: 'pinned-provider', model: 'pinned-model' },
  })
  assert.deepEqual(calls, [{ provider: 'pinned-provider', model: 'pinned-model' }])
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
