// Mount-level test: the whole plugin wired to a stub context.
//
// `test/smoke.mjs` covers the watchdog in isolation. This file covers what that
// unit test cannot: that `apply()` registers the two listeners a real profile
// would deliver, that they are handed the objects the Host actually passes, and
// that a run of qualifying compressions reaches `schedule.create` with the
// incremented title. No DSH process is involved.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

/**
 * A context with just enough surface for `apply()`: an event bus, the effect
 * registry, and the services the plugin reads through `ctx.get()`.
 *
 * @returns the context plus the hooks the test drives it through.
 */
function stubContext({ percent = 62, title = 'test-3', openTurn = false } = {}) {
  const listeners = new Map()
  const effects = []
  const created = []
  const warnings = []

  const ctx = {
    logger: {
      info: () => {},
      warn: (message) => warnings.push(String(message)),
    },
    get(name) {
      if (name === 'sessionProjections') {
        return {
          snapshot: () => ({
            asOfSeq: 10,
            values: { contextPressure: { contextWindow: 100000, pressureTokens: percent * 1000 } },
          }),
        }
      }
      if (name === 'tokenMeter') return { contextPressure: () => ({ contextWindow: 100000, pressureTokens: percent * 1000 }) }
      if (name === 'sessionTitle') return { get: () => ({ title, source: { kind: 'user' }, eventSeq: 1 }) }
      if (name === 'agents') return { turnBoundaryOf: () => ({ openTurnStartSeq: openTurn ? 7 : null }) }
      if (name === 'schedule') {
        return {
          create: async (request) => {
            created.push(request)
            return {
              record: { title: request.title },
              target: { kind: 'new_once', sessionId: 'session-new-1', create: {} },
            }
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const at = current.indexOf(listener)
        if (at >= 0) current.splice(at, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }

  return {
    ctx,
    created,
    warnings,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    dispose() {
      for (const dispose of effects) if (typeof dispose === 'function') dispose()
    },
  }
}

/** The session shape the Host passes to `session/event`. */
const session = { id: 'session-a', header: { cwd: '/repo', agentPreset: 'default' } }

function start(id) {
  return { type: 'compaction/start', seq: 1, time: 0, data: { compactionId: id, turn: 1 } }
}
function end(id) {
  return { type: 'compaction/end', seq: 2, time: 0, data: { compactionId: id, turn: 1 } }
}

/**
 * A `compress` tool call, the shape a profile that replaces DSH's compaction
 * leaves in the log instead of `compaction/*` events.
 */
function compressCall(callId) {
  return { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId, name: 'compress', arguments: '{}' } }
}

/** The matching successful result. */
function compressResult(callId, text = '[Compressed m1–m2 → 1 block(s), ~1000 tokens saved.]') {
  return {
    type: 'tool/result',
    seq: 2,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
        id: 'msg-1',
      },
    },
  }
}

test('a run of five qualifying compressions relays through schedule.create', async () => {
  const stub = stubContext({ percent: 62, title: 'test-3' })
  apply(stub.ctx, {})
  for (let i = 1; i <= 5; i += 1) {
    stub.emit('session/event', session, start(`c${i}`))
    stub.emit('session/event', session, end(`c${i}`))
  }
  // The hand-off is asynchronous; let its single microtask chain finish.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 1, 'exactly one continuation')
  const request = stub.created[0]
  assert.equal(request.title, 'test-4', 'the title continues the current series')
  assert.equal(request.timing.kind, 'after')
  assert.equal(request.timing.after_seconds, 1)
  assert.deepEqual(request.target, {
    kind: 'new_once',
    create: { cwd: '/repo', agentPreset: 'default' },
  }, 'the continuation starts where the work is, with the same preset')
  assert.match(request.prompt, /session-a/u, 'the prompt names the predecessor')
  assert.match(request.prompt, /5 次/u, 'the prompt reports the run length')
  assert.match(request.prompt, /62%/u, 'the prompt reports the measured occupancy')
  assert.deepEqual(stub.warnings, [])
  stub.dispose()
})

test('four qualifying compressions do not relay', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, {})
  for (let i = 1; i <= 4; i += 1) {
    stub.emit('session/event', session, start(`c${i}`))
    stub.emit('session/event', session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0)
  stub.dispose()
})

test('low-occupancy compressions never relay', async () => {
  const stub = stubContext({ percent: 30 })
  apply(stub.ctx, {})
  for (let i = 1; i <= 20; i += 1) {
    stub.emit('session/event', session, start(`c${i}`))
    stub.emit('session/event', session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0, 'the threshold gates the count')
  stub.dispose()
})

test('the configured threshold and count are honoured', async () => {
  const stub = stubContext({ percent: 80 })
  apply(stub.ctx, { thresholdPercent: 75, consecutiveCount: 2 })
  for (let i = 1; i <= 2; i += 1) {
    stub.emit('session/event', session, start(`c${i}`))
    stub.emit('session/event', session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1)
  stub.dispose()
})

test('a running turn defers the relay to agent/turn-stopping', async () => {
  const stub = stubContext({ percent: 62, openTurn: true })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0, 'the open turn holds it')

  // The boundary event is emitted while `turn/end` is still uncommitted, so the
  // probe below still reports an open turn; the boundary flush must not consult
  // it, or a deferred hand-off would never fire.
  stub.emit('agent/turn-stopping', { agent: { session, id: session.id }, turn: 1, signal: undefined })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the boundary releases it')
  stub.dispose()
})

test('a custom separator and title are used', async () => {
  const stub = stubContext({ percent: 62, title: 'build_6' })
  apply(stub.ctx, { consecutiveCount: 1, separator: '_' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created[0].title, 'build_7')
  stub.dispose()
})

test('an unnumbered title starts a series at 1 with the configured separator', async () => {
  const stub = stubContext({ percent: 62, title: 'test' })
  apply(stub.ctx, { consecutiveCount: 1, separator: '-' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created[0].title, 'test-1', 'test → test-1')
  stub.dispose()
})

test('an unnumbered title uses the custom separator when starting its series', async () => {
  const stub = stubContext({ percent: 62, title: 'test' })
  apply(stub.ctx, { consecutiveCount: 1, separator: '_' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created[0].title, 'test_1', 'the connector is the user setting, not a hard-coded dash')
  stub.dispose()
})

test('incrementTitle off falls back to the default title', async () => {
  // Turning the rule off must not keep numbering: the point of the switch is to
  // stop deriving a title from the predecessor at all.
  const stub = stubContext({ percent: 62, title: 'test-3' })
  apply(stub.ctx, { consecutiveCount: 1, incrementTitle: false, defaultTitle: '接力' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created[0].title, '接力')
  stub.dispose()
})

test('incrementTitle off also suppresses the fresh-series rule', async () => {
  const stub = stubContext({ percent: 62, title: 'test' })
  apply(stub.ctx, { consecutiveCount: 1, incrementTitle: false, defaultTitle: '接力' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created[0].title, '接力', 'the switch disables all title derivation')
  stub.dispose()
})

test('a disabled plugin relays nothing, and enabling it live works', async () => {
  const settings = { consecutiveCount: 1, enabled: false }
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, settings)
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0)

  // A panel edit arrives as a volatile update on the same settings object.
  settings.enabled = true
  stub.emit('loader/volatile-update')
  stub.emit('session/event', session, start('c2'))
  stub.emit('session/event', session, end('c2'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 're-enabling needs no remount')
  stub.dispose()
})

test('a missing schedule service is reported, not thrown into the bus', async () => {
  const stub = stubContext({ percent: 62 })
  const without = stub.ctx.get
  stub.ctx.get = (name) => (name === 'schedule' ? undefined : without(name))
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  // A listener that throws would be contained by the Host, but the plugin's own
  // wrapper turns it into a warning instead of an unhandled rejection.
  assert.doesNotThrow(() => {
    stub.emit('session/event', session, end('c1'))
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0)
  assert.equal(stub.warnings.length, 1, 'one warning about the failed relay')
  assert.match(stub.warnings[0], /创建接力会话失败/u)
  stub.dispose()
})

test('compress tool calls drive the count in a profile without compaction events', async () => {
  // This is the shape the desktop profile actually produces: billion-context
  // replaces DSH compaction, so no `compaction/*` events are ever appended.
  const stub = stubContext({ percent: 62, title: 'test-3' })
  apply(stub.ctx, {})
  for (let i = 1; i <= 5; i += 1) {
    stub.emit('session/event', session, compressCall(`call-${i}`))
    stub.emit('session/event', session, compressResult(`call-${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 1, 'the tool vocabulary is counted')
  assert.equal(stub.created[0].title, 'test-4')
  stub.dispose()
})

test('a failed compress result neither counts nor breaks a run', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 3 })
  // Two good ones, a failure, then the third good one must reach the limit.
  for (const id of ['a', 'b']) {
    stub.emit('session/event', session, compressCall(id))
    stub.emit('session/event', session, compressResult(id))
  }
  stub.emit('session/event', session, compressCall('bad'))
  stub.emit('session/event', session, compressResult('bad', '[Compression refused: nothing to do]'))
  assert.equal(stub.created.length, 0, 'the failure did not count')
  stub.emit('session/event', session, compressCall('c'))
  stub.emit('session/event', session, compressResult('c'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the run survived the failure')
  stub.dispose()
})

test('a low-occupancy compress call resets the run', async () => {
  const stub = stubContext({ percent: 30 })
  apply(stub.ctx, { consecutiveCount: 2 })
  for (const id of ['a', 'b', 'c']) {
    stub.emit('session/event', session, compressCall(id))
    stub.emit('session/event', session, compressResult(id))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0, 'below-threshold compressions break the run')
  stub.dispose()
})

test('a custom compressTools list replaces the default names', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 1, compressTools: 'shrink' })
  stub.emit('session/event', session, compressCall('c1'))
  stub.emit('session/event', session, compressResult('c1'))
  assert.equal(stub.created.length, 0, 'the default `compress` name no longer counts')

  stub.emit('session/event', session, { ...compressCall('c2'), data: { ...compressCall('c2').data, name: 'shrink' } })
  stub.emit('session/event', session, compressResult('c2'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the configured name counts')
  stub.dispose()
})

test('a live edit to compressTools is picked up without a remount', async () => {
  // The tool list is resolved once per mount, so a panel edit has to refresh it
  // explicitly; otherwise a renamed tool would be silently ignored until restart.
  const settings = { consecutiveCount: 1, compressTools: 'compress' }
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, settings)

  settings.compressTools = 'shrink'
  stub.emit('loader/volatile-update')

  stub.emit('session/event', session, compressCall('c1'))
  stub.emit('session/event', session, compressResult('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 0, 'the old name was dropped')

  const renamed = compressCall('c2')
  renamed.data.name = 'shrink'
  stub.emit('session/event', session, renamed)
  stub.emit('session/event', session, compressResult('c2'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the new name is recognised')
  stub.dispose()
})
