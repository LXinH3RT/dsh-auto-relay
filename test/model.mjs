// Tests for `lib/model.js` — pinning the continuation session's model.
//
// The interesting behaviour is not the happy path but the two ways this must
// stay quiet: the successor does not exist until the scheduled delivery creates
// it, so "never appeared" is normal, and a pin that fails must not fail the
// hand-off that already happened.

import test from 'node:test'
import assert from 'node:assert/strict'

import { bindRelayModel, selectionOf, runningSelection, DEFAULT_ATTEMPTS, DEFAULT_DELAY_MS } from '../lib/model.js'

/** A context whose `agents.get` answers from a scripted queue of lookups. */
function stubContext({ answers, select } = {}) {
  const lookups = []
  const remaining = [...(answers ?? [])]
  const warnings = []
  const logs = []
  return {
    ctx: {
      get(name) {
        if (name !== 'agents') return undefined
        return {
          get(id) {
            lookups.push(id)
            const next = remaining.length > 0 ? remaining.shift() : undefined
            if (typeof next === 'function') return next(id)
            if (next !== undefined) return next
            return undefined
          },
        }
      },
    },
    lookups,
    warnings,
    logs,
    warn: (message) => warnings.push(String(message)),
    log: (message) => logs.push(String(message)),
    select,
  }
}

const pinned = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }

test('runningSelection reads the header first, because only it carries the effort', () => {
  const session = {
    requestHeader: () => ({ config: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } }),
    requestContext: () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', contextWindow: 1000000 }),
  }
  assert.deepEqual(runningSelection(session), {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'max',
  })
})

test('runningSelection falls back to the resolved context', () => {
  const session = {
    requestHeader: () => undefined,
    requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 500000 }),
  }
  assert.deepEqual(runningSelection(session), { provider: 'p', model: 'm' })
})

test('runningSelection prefers a header that has no effort over a context that does', () => {
  const session = {
    requestHeader: () => ({ config: { provider: 'header-p', model: 'header-m' } }),
    requestContext: () => ({ provider: 'ctx-p', model: 'ctx-m', reasoningEffort: 'high' }),
  }
  assert.deepEqual(runningSelection(session), { provider: 'header-p', model: 'header-m' })
})

test('runningSelection reports nothing for a session that never made a call', () => {
  assert.equal(runningSelection({ requestHeader: () => undefined, requestContext: () => undefined }), null)
  assert.equal(runningSelection({}), null)
  assert.equal(runningSelection(undefined), null)
})

test('runningSelection survives sources that throw or answer half a route', () => {
  const throwing = {
    requestHeader: () => {
      throw new Error('log unavailable')
    },
    requestContext: () => ({ provider: 'p', model: 'm' }),
  }
  assert.deepEqual(runningSelection(throwing), { provider: 'p', model: 'm' }, 'the other source still answers')
  assert.equal(runningSelection({ requestHeader: () => ({ config: { provider: 'p' } }) }), null)
  assert.equal(runningSelection({ requestHeader: () => ({ config: { provider: '', model: 'm' } }) }), null)
  assert.deepEqual(runningSelection({ requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: '  ' } }) }),
    { provider: 'p', model: 'm' }, 'a blank effort is not carried as an empty string')
})

test('selectionOf needs both halves of the pair', () => {
  assert.deepEqual(selectionOf('workbuddy', 'hy4free', ''), { provider: 'workbuddy', model: 'hy4free' })
  assert.deepEqual(
    selectionOf('workbuddy', 'hy4free', 'high'),
    { provider: 'workbuddy', model: 'hy4free', reasoningEffort: 'high' },
  )
  assert.equal(selectionOf('', 'hy4free', ''), null, 'a model without a provider is not a selection')
  assert.equal(selectionOf('workbuddy', '', ''), null, 'a provider without a model is not a selection')
  assert.equal(selectionOf(undefined, undefined, undefined), null)
  assert.equal(selectionOf('   ', '   ', '   '), null, 'whitespace counts as empty')
})

test('selectionOf trims what the user typed', () => {
  assert.deepEqual(selectionOf('  workbuddy  ', '  hy4free  ', '  high  '), {
    provider: 'workbuddy',
    model: 'hy4free',
    reasoningEffort: 'high',
  })
})

test('an absent selection binds nothing', async () => {
  const stub = stubContext({ answers: [{ id: 'session-x', model: { select: () => {} } }] })
  const result = await bindRelayModel(stub.ctx, 'session-x', null)
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'no selection configured')
  assert.deepEqual(stub.lookups, [], 'and does not even look the session up')
})

test('the selection is applied as soon as the session exists', async () => {
  const seen = []
  const stub = stubContext({ answers: [{ id: 'session-x', model: { select: (value) => seen.push(value) } }] })
  const result = await bindRelayModel(stub.ctx, 'session-x', pinned, { log: stub.log })
  assert.deepEqual(result, { bound: true })
  assert.deepEqual(seen, [pinned])
  assert.equal(stub.logs.length, 1, 'a successful pin is recorded once')
})

test('it waits for a session that appears late', async () => {
  const seen = []
  const asleep = []
  const stub = stubContext({
    answers: [undefined, undefined, { id: 'session-x', model: { select: (value) => seen.push(value) } }],
  })
  const result = await bindRelayModel(stub.ctx, 'session-x', pinned, {
    delayMs: 250,
    sleep: async (ms) => { asleep.push(ms) },
  })
  assert.deepEqual(result, { bound: true })
  assert.equal(stub.lookups.length, 3)
  assert.deepEqual(asleep, [250, 250], 'it sleeps between looks only')
  assert.deepEqual(seen, [pinned])
})

test('a session that never appears gives up quietly', async () => {
  const stub = stubContext({ answers: [] })
  const result = await bindRelayModel(stub.ctx, 'session-x', pinned, {
    attempts: 3,
    delayMs: 0,
    sleep: async () => {},
  })
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'session never appeared')
  assert.equal(stub.lookups.length, 3, 'it tried exactly the allowed number of times')
  assert.deepEqual(stub.warnings, [], 'giving up is normal, not a warning')
})

test('a session without a model surface is reported, not thrown', async () => {
  const stub = stubContext({ answers: [{ id: 'session-x' }], warn: stub => stub })
  const result = await bindRelayModel(stub.ctx, 'session-x', pinned, { warn: stub.warn })
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'agent has no model selection surface')
})

test('a throwing select is warned about and never propagates', async () => {
  const stub = stubContext({
    answers: [{ id: 'session-x', model: { select: () => { throw new Error('route is busy') } } }],
  })
  const result = await bindRelayModel(stub.ctx, 'session-x', pinned, { warn: stub.warn })
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'select threw')
  assert.equal(stub.warnings.length, 1)
  assert.match(stub.warnings[0], /route is busy/u)
})

test('a missing agents service binds nothing', async () => {
  const ctx = { get: () => undefined }
  const result = await bindRelayModel(ctx, 'session-x', pinned)
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'agents service unavailable')
})

test('an empty session id binds nothing', async () => {
  const stub = stubContext({ answers: [] })
  const result = await bindRelayModel(stub.ctx, '', pinned)
  assert.equal(result.bound, false)
  assert.equal(result.reason, 'no session id')
})

test('the defaults cover the delivery floor rather than an instant', () => {
  // The scheduled delivery floor is 60 s, so the wait window must be at least
  // that long; anything shorter would give up on every relay that waits for it.
  assert.equal(DEFAULT_DELAY_MS, 500)
  assert.ok(
    DEFAULT_ATTEMPTS * DEFAULT_DELAY_MS >= 60 * 1000,
    `${DEFAULT_ATTEMPTS} looks every ${DEFAULT_DELAY_MS} ms must span the 60 s floor`,
  )
})
