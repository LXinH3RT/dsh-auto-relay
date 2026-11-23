// Tests for `lib/model.js` — pinning the continuation session's model.
//
// The interesting behaviour is not the happy path but the two ways this must
// stay quiet: the successor does not exist until the scheduled delivery creates
// it, so "never appeared" is normal, and a pin that fails must not fail the
// hand-off that already happened.

import test from 'node:test'
import assert from 'node:assert/strict'

import { bindRelayModel, createCreationBinding, selectionOf, runningSelection, DEFAULT_ATTEMPTS, DEFAULT_DELAY_MS } from '../lib/model.js'

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

// ---------------------------------------------------------------------------
// createCreationBinding — writing the route from `agent/created`.
//
// This is the mechanism that closes the first-request race: the agent factory
// awaits `agent/created` while the agent is entered but before the loop's first
// turn, so a selection recorded there is in the log before `model.current()` is
// read. Waiting for the session to exist (what the poll does) is always too late.
// ---------------------------------------------------------------------------

/** A context that lets the test fire `agent/created` by hand. */
function creationContext() {
  const listeners = new Map()
  return {
    ctx: {
      on(event, handler) {
        listeners.set(event, handler)
        return () => {
          listeners.delete(event)
        }
      },
    },
    fire(agent) {
      const handler = listeners.get('agent/created')
      if (handler === undefined) throw new Error('no agent/created listener was registered')
      return handler({ agent, source: 'startup' })
    },
    get wired() {
      return listeners.has('agent/created')
    },
  }
}

test('the creation hook selects the route the instant the successor appears', () => {
  const stub = creationContext()
  const selected = []
  const binding = createCreationBinding({
    ctx: stub.ctx,
    log: () => {},
    warn: () => {},
  })
  binding.expect('session-new', pinned)
  stub.fire({ id: 'session-new', model: { select: (selection) => selected.push(selection) } })
  assert.deepEqual(selected, [pinned], 'the selection is applied before any request')
  assert.deepEqual(binding.inspect(), [], 'the expectation is consumed')
})

test('an expectation for another session does not match', () => {
  const stub = creationContext()
  const selected = []
  const binding = createCreationBinding({ ctx: stub.ctx })
  binding.expect('session-new', pinned)
  stub.fire({ id: 'session-other', model: { select: (selection) => selected.push(selection) } })
  assert.deepEqual(selected, [], 'nothing is pinned onto an unrelated session')
  assert.equal(binding.inspect().length, 1, 'the expectation is still waiting')
})

test('the hook is idempotent: a second creation for the same id does nothing', () => {
  const stub = creationContext()
  const selected = []
  const binding = createCreationBinding({ ctx: stub.ctx })
  binding.expect('session-new', pinned)
  const agent = { id: 'session-new', model: { select: (selection) => selected.push(selection) } }
  stub.fire(agent)
  stub.fire(agent)
  assert.deepEqual(selected, [pinned], 'the second creation has nothing left to apply')
})

test('selecting nothing when there is no expectation', () => {
  const stub = creationContext()
  const selected = []
  const binding = createCreationBinding({ ctx: stub.ctx })
  stub.fire({ id: 'session-any', model: { select: (selection) => selected.push(selection) } })
  assert.deepEqual(selected, [])
})

test('an agent without a model surface is warned about, not thrown', () => {
  const stub = creationContext()
  const warnings = []
  const binding = createCreationBinding({ ctx: stub.ctx, warn: (message) => warnings.push(message) })
  binding.expect('session-new', pinned)
  stub.fire({ id: 'session-new' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /没有可用的模型接口/u)
})

test('a throwing select is warned about and never propagates', () => {
  const stub = creationContext()
  const warnings = []
  const binding = createCreationBinding({ ctx: stub.ctx, warn: (message) => warnings.push(message) })
  binding.expect('session-new', pinned)
  stub.fire({
    id: 'session-new',
    model: { select: () => { throw new Error('route is busy') } },
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /route is busy/u)
})

test('stale expectations are forgotten so a cancelled task cannot leak', () => {
  let clock = 1000
  const stub = creationContext()
  const binding = createCreationBinding({ ctx: stub.ctx, now: () => clock, ttlMs: 1000 })
  binding.expect('session-old', pinned)
  clock += 5000
  const selected = []
  stub.fire({ id: 'session-old', model: { select: (selection) => selected.push(selection) } })
  assert.deepEqual(selected, [], 'an expectation older than the ttl is not applied')
})

test('an incomplete selection or empty id is never recorded', () => {
  const stub = creationContext()
  const binding = createCreationBinding({ ctx: stub.ctx })
  binding.expect('', pinned)
  binding.expect(undefined, pinned)
  binding.expect('session-new', null)
  binding.expect('session-new', undefined)
  assert.deepEqual(binding.inspect(), [])
})

test('dispose unsubscribes and forgets what was waiting', () => {
  const stub = creationContext()
  const binding = createCreationBinding({ ctx: stub.ctx })
  binding.expect('session-new', pinned)
  binding.dispose()
  assert.equal(stub.wired, false, 'the listener is gone')
  assert.deepEqual(binding.inspect(), [])
})

test('a context without `on` still returns a usable, inert binding', () => {
  const binding = createCreationBinding({ ctx: {} })
  binding.expect('session-new', pinned)
  assert.equal(binding.inspect().length, 1, 'recording works')
  binding.dispose()
  assert.deepEqual(binding.inspect(), [])
})

