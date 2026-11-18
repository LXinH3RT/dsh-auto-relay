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
import { parseMarker } from '../lib/marker.js'

/**
 * A context with just enough surface for `apply()`: an event bus, the effect
 * registry, and the services the plugin reads through `ctx.get()`.
 *
 * @param options - `percent`, `title`, `openTurn` shape the compactor and the
 *   title service; `queue` seeds the session's inbox so the carry-over path has
 *   something to move; `model` installs a default-model service plus an LLM
 *   registry whose `resolveModelInfo` either answers or rejects; `registry`
 *   installs an archiving registry that records what it is asked to unarchive;
 *   `pinnable` makes the reserved successor id resolvable through `agents.get`,
 *   with a `model.select` that records what it was pinned to.
 * @returns the context plus the hooks the test drives it through.
 */
function stubContext({
  percent = 62,
  title = 'test-3',
  openTurn = false,
  queue = [],
  model,
  registry = false,
  pinnable = false,
  running,
} = {}) {
  // The predecessor's live route, as `requestHeader()`/`requestContext()` report
  // it. Reset per stub so a test cannot inherit the previous one's route.
  activeRoute = running === undefined ? undefined : { config: running }
  activeContext = undefined
  const listeners = new Map()
  const effects = []
  const created = []
  const warnings = []
  const unarchived = []
  const removed = []
  const prepended = []
  const pinned = []
  let scheduleFails = false
  // The inbox is a live list, so `remove`/`prepend` are observable exactly as the
  // real driver-owned inbox would be.
  let nextTurn = queue.map((message) => ({ ...message }))
  let nextStep = []

  const inbox = {
    get nextTurn() {
      return nextTurn
    },
    get nextStep() {
      return nextStep
    },
    get hasPending() {
      return nextTurn.length > 0 || nextStep.length > 0
    },
    remove(id) {
      const before = nextTurn.length + nextStep.length
      nextTurn = nextTurn.filter((message) => message.id !== id)
      nextStep = nextStep.filter((message) => message.id !== id)
      const after = nextTurn.length + nextStep.length
      if (after !== before) removed.push(id)
      return after !== before
    },
    prepend(target, message) {
      prepended.push({ target, message })
      nextTurn = [message, ...nextTurn]
      return true
    },
  }

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
      if (name === 'agents') {
        return {
          turnBoundaryOf: () => ({ openTurnStartSeq: openTurn ? 7 : null }),
          get: (id) => {
            if (id === session.id) return { id, inbox }
            // The reserved successor id only becomes a live agent once the
            // delivery creates the session; `pinnable` stands in for that.
            if (pinnable && id === 'session-new-1') {
              return { id, model: { select: (selection) => pinned.push(selection) } }
            }
            return undefined
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return model === undefined ? undefined : { currentSelection: () => model }
      }
      if (name === 'llm') {
        if (model === undefined) return undefined
        return {
          resolveModelInfo: async (provider, which) => {
            if (typeof model.resolve === 'function') return model.resolve({ provider, model: which })
            return {}
          },
        }
      }
      if (name === 'workspaceRegistry') {
        if (!registry) return undefined
        return {
          unarchiveSession: (id) => {
            unarchived.push(id)
            return Promise.resolve()
          },
        }
      }
      if (name === 'schedule') {
        return {
          create: async (request) => {
            created.push(request)
            if (typeof request === 'object' && request !== null && scheduleFails) {
              throw new Error('schedule 服务拒绝预订')
            }
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
    unarchived,
    removed,
    prepended,
    inbox,
    pinned,
    failSchedule() {
      scheduleFails = true
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    dispose() {
      for (const dispose of effects) if (typeof dispose === 'function') dispose()
    },
  }
}

/** The session shape the Host passes to `session/event`. */
const session = {
  id: 'session-a',
  header: { cwd: '/repo', agentPreset: 'default' },
  requestHeader: () => activeRoute,
  requestContext: () => activeContext,
}

/** The predecessor's live route for the stub currently under test. */
let activeRoute
let activeContext

/** A queued user message, the shape `agent/inbox/spliced` carries. */
function queued(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${id}` } }
}

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

test('the delivered prompt carries the marker the browser half reads', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1)
  const marker = parseMarker(stub.created[0].prompt)
  assert.notEqual(marker, null, 'the prompt is recognisably ours')
  assert.deepEqual(marker, { from: 'session-a', open: true, archive: true }, 'both switches default on')
  stub.dispose()
})

test('turning both follow switches off keeps the marker out of the prompt', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 1, switchToRelay: false, archiveOldSession: false })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the relay still happens')
  assert.equal(parseMarker(stub.created[0].prompt), null, 'the browser half is told nothing')
  stub.dispose()
})

test('archiving alone still asks the browser to show the successor', async () => {
  // Archiving the conversation on screen blanks the pane, so the Host must never
  // ask for `archive` without `open`.
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 1, switchToRelay: false, archiveOldSession: true })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  const marker = parseMarker(stub.created[0].prompt)
  assert.deepEqual(marker, { from: 'session-a', open: true, archive: true })
  stub.dispose()
})

// ---------------------------------------------------------------------------
// Queued input travels with the hand-off
// ---------------------------------------------------------------------------

test('queued input is transcribed into the delivered prompt and then removed', async () => {
  const stub = stubContext({
    percent: 62,
    queue: [queued('q1', '把光标移动改成按行'), queued('q2', '顺便补一个测试')],
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 1)
  const prompt = stub.created[0].prompt
  assert.match(prompt, /把光标移动改成按行/u, 'the first queued message travels')
  assert.match(prompt, /顺便补一个测试/u, 'so does the second')
  assert.match(prompt, /不要当成用户刚刚说的话重复确认/u, 'and is framed as an instruction, not a fresh ask')
  assert.deepEqual(stub.removed, ['q1', 'q2'], 'both left the old queue')
  assert.equal(stub.inbox.hasPending, false, 'the old queue is empty')
  stub.dispose()
})

test('an empty queue adds nothing to the prompt', async () => {
  const stub = stubContext({ percent: 62 })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.doesNotMatch(stub.created[0].prompt, /排队输入/u, 'no queue section was written')
  assert.deepEqual(stub.removed, [])
  stub.dispose()
})

test('turning carryQueue off leaves the queue in the old session', async () => {
  const stub = stubContext({ percent: 62, queue: [queued('q1', '别搬我')] })
  apply(stub.ctx, { consecutiveCount: 1, carryQueue: false })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the relay still happens')
  assert.doesNotMatch(stub.created[0].prompt, /别搬我/u, 'the message did not travel')
  assert.deepEqual(stub.removed, [], 'and was not removed either')
  assert.equal(stub.inbox.hasPending, true)
  stub.dispose()
})

test('a failed reservation leaves the queue untouched', async () => {
  // This is the failure actually observed: the successor could not be created,
  // so draining first would have destroyed what the user typed.
  const stub = stubContext({ percent: 62, queue: [queued('q1', '这条不能丢')] })
  stub.failSchedule()
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stub.removed, [], 'nothing was drained')
  assert.equal(stub.inbox.hasPending, true, 'the message is still queued')
  assert.equal(stub.warnings.length, 1)
  stub.dispose()
})

test('a bounded queue carries only what fits', async () => {
  const stub = stubContext({
    percent: 62,
    queue: [queued('q1', 'a'.repeat(50)), queued('q2', 'b'.repeat(50)), queued('q3', 'c'.repeat(50))],
  })
  apply(stub.ctx, { consecutiveCount: 1, maxQueueChars: 120, maxQueueItems: 2 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stub.removed, ['q1', 'q2'], 'only the transcribed prefix left')
  assert.equal(stub.inbox.hasPending, true, 'the third stayed behind')
  assert.match(stub.created[0].prompt, /只抄录了前 2 条/u, 'and the prompt says so')
  stub.dispose()
})

// ---------------------------------------------------------------------------
// A continuation that dies on its first turn is rolled back
// ---------------------------------------------------------------------------

/** The `turn/end` a session records when its first model call failed. */
function failedTurn(reason) {
  return {
    type: 'turn/end',
    seq: 3,
    time: 0,
    data: { turn: 1, reason: { kind: 'error', error: reason } },
  }
}

test('a successor whose first turn errors is reported and the parent is restored', async () => {
  const stub = stubContext({
    percent: 62,
    queue: [queued('q1', '这条要还回去')],
    registry: true,
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stub.removed, ['q1'], 'the queue travelled')

  // The successor session fails before producing anything.
  const child = { id: 'session-new-1', header: { cwd: '/repo' } }
  stub.emit('session/event', child, failedTurn({
    message: 'pi-ai provider "workbuddy" has no configured model "hy4free"',
    code: 'UNKNOWN_MODEL',
  }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(stub.unarchived, ['session-a'], 'the predecessor is brought back')
  assert.equal(stub.prepended.length, 1, 'the queued message is handed back')
  assert.equal(stub.prepended[0].message.id, 'q1')
  assert.ok(
    stub.warnings.some((warning) => /hy4free|接力会话/u.test(warning)),
    `a warning names the failure: ${JSON.stringify(stub.warnings)}`,
  )
  stub.dispose()
})

test('a successor that produced a step is never rolled back', async () => {
  // Once the successor has a step or a message it is doing work; a later error is
  // the model's business, not a broken hand-off.
  const stub = stubContext({ percent: 62, queue: [queued('q1', '别还回去')], registry: true })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  const child = { id: 'session-new-1', header: { cwd: '/repo' } }
  stub.emit('session/event', child, { type: 'step/start', seq: 4, time: 0, data: { turn: 1, step: 1 } })
  stub.emit('session/event', child, failedTurn({ message: 'quota exceeded', code: 'QUOTA' }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(stub.unarchived, [], 'no rollback')
  assert.deepEqual(stub.prepended, [])
  stub.dispose()
})

test('an unrelated session erroring does not touch the relay', async () => {
  const stub = stubContext({ percent: 62, queue: [queued('q1', '保持')], registry: true })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  const stranger = { id: 'session-other', header: {} }
  stub.emit('session/event', stranger, failedTurn({ message: 'boom', code: 'X' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stub.unarchived, [])
  stub.dispose()
})

// ---------------------------------------------------------------------------
// The model is asked before anything is created
// ---------------------------------------------------------------------------

test('an unresolvable model skips the hand-off with a warning', async () => {
  const stub = stubContext({
    percent: 62,
    queue: [queued('q1', '不该被搬走')],
    model: {
      provider: 'workbuddy',
      model: 'hy4free',
      resolve: () => {
        const error = new Error('pi-ai provider "workbuddy" has no configured model "hy4free"')
        error.code = 'UNKNOWN_MODEL'
        throw error
      },
    },
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 0, 'nothing was created')
  assert.deepEqual(stub.removed, [], 'and nothing was drained')
  assert.equal(stub.inbox.hasPending, true, 'the queue is intact for the next attempt')
  assert.ok(
    stub.warnings.some((warning) => /hy4free|接力被跳过/u.test(warning)),
    `the warning explains the skip: ${JSON.stringify(stub.warnings)}`,
  )
  stub.dispose()
})

test('a resolvable model relays as usual', async () => {
  const stub = stubContext({
    percent: 62,
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', resolve: () => ({}) },
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1)
  stub.dispose()
})

test('turning the model check off relays even when the probe would fail', async () => {
  const stub = stubContext({
    percent: 62,
    model: {
      provider: 'workbuddy',
      model: 'hy4free',
      resolve: () => {
        throw new Error('no configured model')
      },
    },
  })
  apply(stub.ctx, { consecutiveCount: 1, checkRelayModel: false })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stub.created.length, 1, 'the user may override a wrong probe')
  stub.dispose()
})

// ---------------------------------------------------------------------------
// A configured relay model wins over the profile default
// ---------------------------------------------------------------------------

test('a configured relay model is probed instead of the profile default', async () => {
  const asked = []
  const stub = stubContext({
    percent: 62,
    model: { provider: 'workbuddy', model: 'hy4free', resolve: (selection) => asked.push(selection) },
  })
  apply(stub.ctx, {
    consecutiveCount: 1,
    relayProvider: 'workbuddy',
    relayModel: 'deepseek-v4.1-flash',
    relayReasoningEffort: 'high',
  })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  // Probing the default while intending to bind another route would validate a
  // model the successor will never call.
  assert.deepEqual(asked, [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }])
  assert.equal(stub.created.length, 1)
  stub.dispose()
})

test('the configured model is bound to the successor once it exists', async () => {
  const stub = stubContext({
    percent: 62,
    pinnable: true,
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', resolve: () => ({}) },
  })
  apply(stub.ctx, {
    consecutiveCount: 1,
    relayProvider: 'workbuddy',
    relayModel: 'deepseek-v4.1-flash',
    relayReasoningEffort: 'max',
  })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    stub.pinned,
    [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }],
    'the reserved session is pinned to the configured route',
  )
  stub.dispose()
})

test('no configured model means no binding at all', async () => {
  const stub = stubContext({
    percent: 62,
    pinnable: true,
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', resolve: () => ({}) },
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 1)
  assert.deepEqual(stub.pinned, [], 'a session with no recorded route pins nothing')
  stub.dispose()
})

test('an unconfigured relay inherits the route the predecessor was running on', async () => {
  const asked = []
  const stub = stubContext({
    percent: 62,
    pinnable: true,
    running: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    // The profile default names a model the provider no longer advertises — the
    // exact situation that killed a relay session on its first call.
    model: { provider: 'workbuddy', model: 'hy4free', resolve: (selection) => asked.push(selection) },
  })
  apply(stub.ctx, { consecutiveCount: 1 })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    asked,
    [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }],
    'the running route is what gets checked, not the profile default',
  )
  assert.deepEqual(
    stub.pinned,
    [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }],
    'the successor continues on the same model and the same effort',
  )
  stub.dispose()
})

test('a configured pair still outranks the inherited route', async () => {
  const stub = stubContext({
    percent: 62,
    pinnable: true,
    running: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', resolve: () => ({}) },
  })
  apply(stub.ctx, {
    consecutiveCount: 1,
    relayProvider: 'deepseek-official',
    relayModel: 'deepseek-flash',
  })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    stub.pinned,
    [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    'an explicit choice is never overridden by inheritance',
  )
  stub.dispose()
})

test('a half-filled relay pair is ignored rather than half applied', async () => {
  const stub = stubContext({
    percent: 62,
    pinnable: true,
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', resolve: () => ({}) },
  })
  // Only the model id, no provider: nothing pins, and the default is probed.
  apply(stub.ctx, { consecutiveCount: 1, relayModel: 'deepseek-v4.1-flash' })
  stub.emit('session/event', session, start('c1'))
  stub.emit('session/event', session, end('c1'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stub.created.length, 1)
  assert.deepEqual(stub.pinned, [])
  stub.dispose()
})

