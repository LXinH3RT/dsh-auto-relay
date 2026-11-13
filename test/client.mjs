// Browser-half test: the bundle loads, agrees with the Host's marker format, and
// performs the two actions the Host cannot.
//
// The client bundle is a classic script: it registers itself through
// `window.__ModuleLoader__` and asks the loader for nothing. This file supplies a
// minimal loader and a stub context, in the same spirit as `test/mount.mjs`, so
// the pairing can be asserted without a browser or a DSH process.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { MARKER_PREFIX, parseMarker as hostParseMarker, withMarker } from '../lib/marker.js'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * The smallest React that lets the settings page be registered.
 *
 * The tests never render it — they check that the two seats are claimed and that
 * the page covers every Host field — so hooks only have to exist, not work. A
 * stub rather than the real thing keeps this suite free of a dependency the
 * plugin deliberately does not have.
 */
function fakeReact() {
  return {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * Load the bundle and return its exports.
 *
 * @param {object} options
 * @param {object|null} options.react what `require('react')` answers; null makes
 *   the loader refuse, which is how a client without React behaves.
 * @returns the module the bundle built, as the page's loader would receive it.
 */
function loadBundle({ react = fakeReact() } = {}) {
  let registered = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          registered = definition
        },
      },
    },
    console,
    Date,
    Set,
    Array,
    Object,
    String,
    Number,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.notEqual(registered, null, 'the bundle registered itself')
  assert.equal(registered.id, 'dsh-auto-relay', 'the module id is the package name')
  return registered.factory((name) => {
    if (name === 'react' && react !== null) return react
    throw new Error(`the bundle may only require react, and it asked for ${String(name)}`)
  })
}

/**
 * A context with the four services the browser half injects.
 *
 * `timer.interval` records the callback instead of scheduling it: a real interval
 * would keep the process alive past the assertions, and the tests drive the poll
 * themselves through `poll()`.
 */
function stubContext({ tasks = [] } = {}) {
  const opened = []
  const archived = []
  const effects = []
  const intervals = []
  const listeners = new Map()
  const warnings = []
  const surfaces = []

  const ctx = {
    timer: {
      interval: (callback, delay) => {
        intervals.push({ callback, delay })
        return () => {}
      },
    },
    remote: {
      schedule: {
        catalog: async () => (typeof tasks === 'function' ? tasks() : tasks),
      },
      $on: (event, listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => {}
      },
    },
    uiWorkspace: {
      openSession: (target) => {
        opened.push(target)
      },
      archiveSession: async (id, options) => {
        archived.push({ id, options })
      },
    },
    // The settings surface: `slots` claims a seat, `inject` hands over the
    // configuration service. A page that mounts records where it went.
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        surfaces.push({ name: options.name, key: options.key, component })
        return () => {}
      },
    },
    inject: (services, callback) => {
      assert.deepEqual([...services], ['configForms'], 'only the settings service is asked for')
      callback({
        configForms: {
          get: (ns) => ({
            getSnapshot: () => ({
              status: 'ready',
              value: { thresholdPercent: 50, consecutiveCount: 5 },
              user: {},
              revision: 0,
              writable: true,
            }),
            mutate: async () => true,
            namespace: ns,
          }),
          whileServed: (namespaces, register) => register(),
        },
        effect: (factory) => factory(),
      })
    },
    effect(callback) {
      const dispose = callback()
      effects.push({ dispose })
      return dispose
    },
  }

  return {
    ctx,
    exports: loadBundle(),
    opened,
    archived,
    effects,
    intervals,
    listeners,
    warnings,
    surfaces,
    /** Let the one async catalogue read and its actions finish. */
    async settle() {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    /** Fire the forwarded `schedule/changed` event, as the page would. */
    async change() {
      for (const listener of listeners.get('schedule/changed') ?? []) listener()
      await this.settle()
    },
    /** Run the poll callback once. */
    async poll() {
      for (const entry of intervals) entry.callback()
      await this.settle()
    },
    dispose() {
      for (const effect of effects) if (typeof effect.dispose === 'function') effect.dispose()
    },
  }
}

/** One relay task, as `schedule.catalog()` reports it after delivery. */
function relayTask({ id = 'schedule-1', from = 'session-a', to = 'session-b', open = true, archive = true, deliveredAt = new Date().toISOString() } = {}) {
  const prompt = withMarker('继续完成上一会话的任务。', { from, open, archive })
  return {
    id,
    title: 'test-4',
    prompt,
    status: 'ended',
    involvedSessionIds: [from, to],
    target: { kind: 'session', sessionId: to },
    lastDelivery: { scheduledAt: deliveredAt, deliveredAt, messageId: 'message-1', targetSessionId: to },
  }
}

/**
 * Flatten an archive record into a comparison a `vm` realm can satisfy.
 *
 * The bundle builds its own `{ stopActivity: true }` object inside the VM realm,
 * and `deepStrictEqual` compares prototypes, so the raw record never matches a
 * literal here. Comparing the values is what the test actually means.
 */
function archived(record) {
  return { id: record.id, stopActivity: record.options?.stopActivity }
}

/**
 * Copy a value out of the VM realm into ordinary host objects.
 *
 * Everything the bundle builds carries the VM's prototypes, which
 * `deepStrictEqual` rejects even when the values match. A JSON round trip is
 * enough for the plain data these tests compare.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the client parses exactly what the host writes', () => {
  const bundle = loadBundle()
  const prompts = [
    withMarker('x', { from: 'session-a', open: true, archive: true }),
    withMarker('x', { from: 'session-a', open: true, archive: false }),
    withMarker('x', { from: 'session-a', open: false, archive: true }),
    withMarker('x', { from: 'session-a', open: false, archive: false }),
    `${MARKER_PREFIX} from=session-a open=1 archive=0`,
    'a prompt with no marker at all',
    '',
  ]
  for (const prompt of prompts) {
    // Both parsers return object literals, but from different realms: the bundle
    // runs inside the VM, so its objects carry another prototype. Compare values.
    const theirs = bundle.parseMarker(prompt)
    const ours = hostParseMarker(prompt)
    assert.deepEqual(
      theirs === null ? null : { from: theirs.from, open: theirs.open, archive: theirs.archive },
      ours === null ? null : { from: ours.from, open: ours.open, archive: ours.archive },
      `agree on ${JSON.stringify(prompt)}`,
    )
  }
})

test('a relay task opens the successor and archives the predecessor', async () => {
  const stub = stubContext({ tasks: [relayTask()] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual([...stub.opened], ['session-b'], 'the successor is shown')
  assert.deepEqual(stub.archived.map(archived), [{ id: 'session-a', stopActivity: true }], 'the predecessor is archived')
  stub.dispose()
})

test('the successor is shown before the predecessor is archived', async () => {
  const order = []
  const stub = stubContext({ tasks: [relayTask()] })
  stub.ctx.uiWorkspace = {
    openSession: () => order.push('open'),
    archiveSession: async () => order.push('archive'),
  }
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(order, ['open', 'archive'], 'archiving first would blank the pane')
  stub.dispose()
})

test('archive=0 follows the successor without archiving', async () => {
  const stub = stubContext({ tasks: [relayTask({ archive: false })] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, ['session-b'])
  assert.deepEqual(stub.archived, [])
  stub.dispose()
})

test('open=0 leaves the interface alone', async () => {
  const stub = stubContext({ tasks: [{ ...relayTask(), prompt: '继续完成上一会话的任务。' }] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, [], 'a prompt without the marker is not ours')
  assert.deepEqual(stub.archived, [])
  stub.dispose()
})

test('a task that has not delivered yet is left alone', async () => {
  const task = relayTask()
  delete task.lastDelivery
  const stub = stubContext({ tasks: [task] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, [], 'the reserved session does not exist yet')
  stub.dispose()
})

test('a delivery older than the window does not move the interface', async () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const stub = stubContext({ tasks: [relayTask({ deliveredAt: old })] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, [], 'a relay from ten minutes ago should not steal the view')
  stub.dispose()
})

test('one task is acted on once, even when the event and the poll both fire', async () => {
  const stub = stubContext({ tasks: [relayTask()] })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, ['session-b'], 'the initial read acts')
  // The forwarded event and the interval both look again; neither repeats the work.
  await stub.change()
  await stub.poll()
  assert.deepEqual(stub.opened, ['session-b'], 'the second look is a no-op')
  assert.equal(stub.archived.length, 1, 'the predecessor is archived once')
  stub.dispose()
})

test('a task the user scheduled by hand is never touched', async () => {
  const stub = stubContext({
    tasks: [{
      id: 'schedule-user',
      title: 'nightly report',
      prompt: 'Summarise the repository every night.',
      status: 'active',
      involvedSessionIds: ['session-a'],
      target: { kind: 'session', sessionId: 'session-a' },
      lastDelivery: { scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), messageId: 'm', targetSessionId: 'session-a' },
    }],
  })
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(stub.opened, [])
  assert.deepEqual(stub.archived, [])
  stub.dispose()
})

test('a failing archive is retried on the next look rather than dropped', async () => {
  let attempt = 0
  const stub = stubContext({ tasks: [relayTask()] })
  stub.ctx.uiWorkspace = {
    openSession: () => {},
    archiveSession: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('transient')
    },
  }
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.equal(attempt, 1, 'the first attempt failed')
  // The task was not marked handled, so the next look retries it.
  await stub.change()
  assert.equal(attempt, 2, 'the retry kept the task in play')
  stub.dispose()
})

test('the bundle injects only services it uses', () => {
  const bundle = loadBundle()
  assert.deepEqual([...bundle.inject], ['remote', 'remote.schedule', 'uiWorkspace', 'timer', 'slots'])
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(bundle.name, 'dsh-auto-relay')
})

test('the configuration page covers every field the host schema declares', () => {
  // The page and the schema cannot share code — one is a classic script, the
  // other an ES module — so the field list is read back out of the Host source.
  // A field added to the schema and forgotten here would be unconfigurable in
  // the panel while looking perfectly fine in the Host.
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declared = []
  const pattern = /^\s{4}([a-zA-Z][a-zA-Z0-9]*): Schema\./gmu
  for (const match of host.matchAll(pattern)) declared.push(match[1])
  assert.ok(declared.length >= 14, `found ${declared.length} schema fields`)
  const page = new Set(loadBundle().fieldKeys())
  for (const key of declared) assert.ok(page.has(key), `${key} has a control on the page`)
  assert.equal(page.size, declared.length, 'the page declares nothing the schema does not')
})

test('the page is registered on both seats a bundle configuration can occupy', () => {
  const bundle = loadBundle()
  assert.equal(bundle.NAMESPACE, 'dsh-auto-relay', 'the settings namespace is the patch row id, not the tree path')
  assert.equal(bundle.BUNDLE_KEY, 'dsh-auto-relay', 'the bundle seat is keyed by the package name')
  assert.equal(bundle.ROW_KEY, 'dsh-auto-relay#dsh-auto-relay', 'the row seat is keyed <package>#<row id>')
})

test('draft operations clamp numbers, unset blanks, and keep text verbatim', () => {
  const { draftOps } = loadBundle()
  assert.deepEqual(
    plain(draftOps({ thresholdPercent: '70', consecutiveCount: ' 3 ' }).ops),
    [
      { op: 'set', path: ['thresholdPercent'], value: 70 },
      { op: 'set', path: ['consecutiveCount'], value: 3 },
    ],
    'numbers are parsed and range-checked',
  )
  assert.deepEqual(
    plain(draftOps({ thresholdPercent: '999' }).ops),
    [{ op: 'set', path: ['thresholdPercent'], value: 100 }],
    'an out-of-range number is clamped, not rejected',
  )
  assert.deepEqual(
    plain(draftOps({ thresholdPercent: '' }).ops),
    [{ op: 'unset', path: ['thresholdPercent'] }],
    'a cleared field falls back to the default',
  )
  assert.deepEqual(
    plain(draftOps({ separator: ' ' }).ops),
    [{ op: 'unset', path: ['separator'] }],
    'whitespace clears a text field too',
  )
  assert.deepEqual(
    plain(draftOps({ promptTemplate: 'line one\nline two' }).ops),
    [{ op: 'set', path: ['promptTemplate'], value: 'line one\nline two' }],
    'a multi-line prompt keeps its newlines',
  )
  assert.equal(draftOps({ thresholdPercent: 'abc' }).invalid, true, 'a non-number is reported, not written')
})

test('the settings page mounts only where the host serves the namespace', async () => {
  const registrations = []
  const stub = stubContext({ tasks: [] })
  stub.ctx.slots = {
    inject: (name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ name: options.name, key: options.key, component })
      return () => {}
    },
  }
  let served = null
  stub.ctx.inject = (services, callback) => {
    assert.deepEqual([...services], ['configForms'])
    callback({
      configForms: {
        get: (ns) => ({ namespace: ns, getSnapshot: () => undefined, mutate: async () => false }),
        whileServed: (namespaces, register) => {
          served = namespaces
          return register()
        },
      },
      effect: (factory) => factory(),
    })
  }
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual(plain(served), ['dsh-auto-relay'], 'the page waits for the Host to list the namespace')
  assert.deepEqual(
    registrations.map((entry) => [entry.name, entry.key]),
    [
      ['plugins.bundle.config', 'dsh-auto-relay'],
      ['plugins.row.config', 'dsh-auto-relay#dsh-auto-relay'],
    ],
    'both seats are claimed',
  )
  assert.equal(typeof registrations[0].component, 'function', 'a component is rendered on each seat')
  stub.dispose()
})

test('a client without slots or configForms keeps following the relay', async () => {
  // The page is a convenience. Losing it must not cost the follower, which is
  // the half that actually does something.
  const stub = stubContext({ tasks: [relayTask()] })
  stub.ctx.slots = undefined
  stub.ctx.inject = () => {
    throw new Error('not expected here')
  }
  stub.exports.apply(stub.ctx)
  await stub.settle()
  assert.deepEqual([...stub.opened], ['session-b'], 'the relay is still followed')
  stub.dispose()
})
