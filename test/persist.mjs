// Durable-counter tests.
//
// Two things need proving here, and they are different in kind:
//
//   1. the store itself — that it reads and writes through the Host's storage
//      facility, that a corrupt record degrades instead of failing the domain
//      open, and that a missing facility leaves the plugin working in memory;
//   2. the resume — that a run which reached four of five before a restart
//      relays on its NEXT high-occupancy compression instead of demanding five
//      more, which is the entire reason the switch exists.
//
// The fake facility implements only what `lib/persist.js` uses: `open`, a table
// with `entries`/`get`/`put`/`delete`, and `close`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'
import { createStore, normalizeCounter } from '../lib/persist.js'
import { createWatcher } from '../lib/watch.js'

/**
 * An in-memory stand-in for `ctx.storageDomain`.
 *
 * `stored` is the durable medium: one Map per table, shared between the store
 * that writes and the store a later "process" opens.
 */
function fakeFacility(options = {}) {
  const { stored = new Map(), failOpen = false, entries = null } = options
  const opened = []
  return {
    stored,
    opened,
    open(spec) {
      if (failOpen) return Promise.reject(new Error('backend-not-found'))
      opened.push(spec)
      // Seed the medium exactly once: what a previous process left behind.
      if (entries !== null && stored.size === 0) {
        for (const [key, value] of entries) stored.set(key, value)
      }
      const domain = {
        name: spec.name,
        table(name) {
          assert.equal(name, 'counters')
          // The real facility runs `valueSchema.parse` over every stored record
          // as it loads, which is how a corrupt record is turned into something
          // usable. Doing the same here is what exercises the plugin's schema.
          const schema = spec.tables[name].valueSchema
          return {
            get: (key) => (stored.has(key) ? schema.parse(stored.get(key)) : undefined),
            entries: () => Array.from(stored.entries()).map(([key, value]) => [key, schema.parse(value)]),
            keys: () => Array.from(stored.keys()),
            get size() {
              return stored.size
            },
            put: async (key, value) => {
              stored.set(key, value)
            },
            delete: async (key) => stored.delete(key),
            deleteMany: async (keys) => {
              for (const key of keys) stored.delete(key)
            },
            update: async (key, fn) => {
              const next = fn(stored.get(key))
              stored.set(key, next)
              return next
            },
          }
        },
        async close() {
          domain.closed = true
        },
        closed: false,
      }
      return Promise.resolve(domain)
    },
  }
}

/** A context exposing only the storage facility, for store-level tests. */
function storeContext(facility) {
  return { get: (name) => (name === 'storageDomain' ? facility : undefined) }
}

const session = { id: 'session-a', header: { cwd: '/repo', agentPreset: 'default' } }

function start(id, seq = 1) {
  return { type: 'compaction/start', seq, time: 0, data: { compactionId: id, turn: 1 } }
}
function end(id, seq = 2) {
  return { type: 'compaction/end', seq, time: 0, data: { compactionId: id, turn: 1 } }
}

/** Build a watcher whose occupancy is fixed at `percent`. */
function makeWatcher({ store = null, percent = 62, created = [] } = {}) {
  const config = { enabled: true, thresholdPercent: 50, consecutiveCount: 5, oncePerSession: true, ignoreSubagents: true, persistCounter: true }
  return createWatcher({
    config,
    readOccupancy: () => ({ percent, usedTokens: percent * 1000, contextWindow: 100000 }),
    readTitle: () => 'test-3',
    hasOpenTurn: () => false,
    handOff: async () => {
      created.push(1)
      return { sessionId: 'session-new-1', title: 'test-4' }
    },
    store,
  })
}

test('normalizeCounter is total and drops unusable fields', () => {
  assert.deepEqual(normalizeCounter(undefined), { consecutive: 0, armed: null, fired: false, seq: -1, updatedAt: 0 })
  assert.deepEqual(normalizeCounter('nonsense'), { consecutive: 0, armed: null, fired: false, seq: -1, updatedAt: 0 })
  assert.deepEqual(normalizeCounter(null), { consecutive: 0, armed: null, fired: false, seq: -1, updatedAt: 0 })

  const kept = normalizeCounter({ consecutive: 3.7, fired: true, seq: 12, updatedAt: 1000 })
  assert.equal(kept.consecutive, 3)
  assert.equal(kept.fired, true)
  assert.equal(kept.seq, 12)

  // A partial armed hand-off cannot render a prompt, so it is dropped rather
  // than restored with null placeholders.
  assert.equal(normalizeCounter({ armed: { count: 5 } }).armed, null)
  assert.equal(normalizeCounter({ armed: { count: 5, percent: 62, usedTokens: 62000, contextWindow: 0 } }).armed, null)
  assert.deepEqual(
    normalizeCounter({ armed: { count: 5, percent: 62, usedTokens: 62000, contextWindow: 100000 } }).armed,
    { count: 5, percent: 62, usedTokens: 62000, contextWindow: 100000, threshold: 0 },
  )
})

test('the store writes through the facility and hydrates from it', async () => {
  const facility = fakeFacility()
  const warnings = []
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: (m) => warnings.push(m) })
  await store.ready

  assert.equal(store.persistent, true)
  assert.equal(facility.opened[0].name, 'auto_relay')
  assert.equal(facility.opened[0].version, 1)
  assert.equal(facility.opened[0].layout, 'per-record')

  store.save('session-a', { consecutive: 4, armed: null, fired: false, seq: 9 })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(facility.stored.get('session-a').consecutive, 4, 'the record reached the medium')
  assert.equal(store.hydrate('session-a').consecutive, 4, 'and is readable in-process')
  assert.deepEqual(warnings, [])

  store.save('session-a', { consecutive: 0, armed: null, fired: true, seq: 20 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.hydrate('session-a').fired, true, 'the newest write wins')

  await store.dispose()
})

test('a corrupt record degrades to no counter instead of failing the open', async () => {
  const facility = fakeFacility({
    entries: [['session-a', { consecutive: 'four', armed: 'yes', fired: 'maybe' }]],
  })
  const warnings = []
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: (m) => warnings.push(m) })
  await store.ready

  assert.equal(store.persistent, true, 'the domain opened')
  assert.equal(store.hydrate('session-a').consecutive, 0)
  assert.equal(store.hydrate('session-a').armed, null)
  assert.equal(store.hydrate('session-a').fired, false)
  assert.deepEqual(warnings, [], 'a readable-but-odd record is not a warning')

  await store.dispose()
})

test('a record older than the prune horizon is dropped on open', async () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000
  const facility = fakeFacility({
    entries: [
      ['stale', { consecutive: 3, armed: null, fired: false, seq: 1, updatedAt: now - 40 * day }],
      ['fresh', { consecutive: 2, armed: null, fired: false, seq: 2, updatedAt: now - 1000 }],
    ],
  })
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {}, now: () => now })
  await store.ready
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(store.hydrate('stale'), undefined, 'the expired record is not restored')
  assert.equal(store.hydrate('fresh').consecutive, 2, 'the live one still is')
  assert.equal(facility.stored.has('stale'), false, 'and it is removed from the medium')

  await store.dispose()
})

test('a missing facility leaves the counters in memory, silently until a save needs it', async () => {
  const warnings = []
  const store = createStore({ ctx: { get: () => undefined }, enabled: () => true, warn: (m) => warnings.push(m) })
  await store.ready

  assert.equal(store.persistent, false)
  assert.deepEqual(warnings, [], 'opening alone is not worth reporting')

  store.save('session-a', { consecutive: 3, armed: null, fired: false, seq: 1 })
  assert.equal(store.hydrate('session-a').consecutive, 3, 'still readable this run')
  assert.equal(warnings.length, 1, 'warned exactly once, when the write wanted the disk')
  assert.match(warnings[0], /重启后归零/u)

  store.save('session-a', { consecutive: 4, armed: null, fired: false, seq: 2 })
  assert.equal(warnings.length, 1, 'the warning does not repeat')

  await store.dispose()
})

test('a facility that refuses to open also degrades to memory', async () => {
  const warnings = []
  const store = createStore({
    ctx: storeContext(fakeFacility({ failOpen: true })),
    enabled: () => true,
    warn: (m) => warnings.push(m),
  })
  await store.ready

  assert.equal(store.persistent, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /打开计数存储失败/u)
  await store.dispose()
})

test('saves are skipped while persistCounter is off', async () => {
  const facility = fakeFacility()
  let persist = false
  const store = createStore({ ctx: storeContext(facility), enabled: () => persist, warn: () => {} })
  await store.ready

  store.save('session-a', { consecutive: 4, armed: null, fired: false, seq: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(facility.stored.size, 0, 'nothing written while disabled')

  persist = true
  store.save('session-a', { consecutive: 4, armed: null, fired: false, seq: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(facility.stored.get('session-a').consecutive, 4, 'the switch takes effect without a remount')

  await store.dispose()
})

test('a restart resumes the run instead of restarting it', async () => {
  // First process: four qualifying compressions, then it dies before the fifth.
  const facility = fakeFacility()
  const created = []
  const first = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const before = makeWatcher({ store: first, created })
  await first.ready
  for (let i = 1; i <= 4; i += 1) {
    before.handleSessionEvent(session, start(`c${i}`))
    before.handleSessionEvent(session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created.length, 0, 'four is not enough yet')
  assert.equal(facility.stored.get('session-a').consecutive, 4, 'the run was persisted')
  await first.dispose()

  // Second process: a fresh watcher over the same medium.
  const created2 = []
  const second = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const after = makeWatcher({ store: second, created: created2 })
  await second.ready
  after.handleSessionEvent(session, start('c5'))
  after.handleSessionEvent(session, end('c5'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created2.length, 1, 'the fifth compression relays after the restart')

  await second.dispose()
})

test('a restart never repeats a hand-off that already happened', async () => {
  const facility = fakeFacility()
  const created = []
  const first = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const before = makeWatcher({ store: first, created })
  await first.ready
  for (let i = 1; i <= 5; i += 1) {
    before.handleSessionEvent(session, start(`c${i}`))
    before.handleSessionEvent(session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(facility.stored.get('session-a').fired, true, 'the relay is recorded')
  await first.dispose()

  const created2 = []
  const second = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const after = makeWatcher({ store: second, created: created2 })
  await second.ready
  for (let i = 6; i <= 10; i += 1) {
    after.handleSessionEvent(session, start(`c${i}`))
    after.handleSessionEvent(session, end(`c${i}`))
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created2.length, 0, 'oncePerSession still holds across the restart')

  await second.dispose()
})

test('counters folded before the medium was ready are merged, not replaced', async () => {
  // One compression is folded while the medium is still being read; the record
  // it then restores describes the stretch BEFORE that compression, so the two
  // contributions are disjoint and must add up.
  const facility = fakeFacility({
    entries: [['session-a', { consecutive: 3, armed: null, fired: false, seq: 40, updatedAt: Date.now() }]],
  })
  const created = []
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const watcher = makeWatcher({ store, created })

  // Ahead of `ready`: the state is built from zero and counts this one event.
  watcher.handleSessionEvent(session, start('early'))
  watcher.handleSessionEvent(session, end('early'))
  assert.equal(watcher.inspect('session-a').consecutive, 1)

  await store.ready
  // The store reports what it restored; index.js forwards it here.
  watcher.restore([[ 'session-a', store.hydrate('session-a') ]])
  assert.equal(watcher.inspect('session-a').consecutive, 4, 'three restored plus the one folded here')

  // The fifth compression, on top of the merged run, relays.
  watcher.handleSessionEvent(session, start('c5'))
  watcher.handleSessionEvent(session, end('c5'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created.length, 1)

  await store.dispose()
})

test('a stored armed hand-off is released after a restart', async () => {
  // The previous process earned the hand-off but died before the turn closed.
  const facility = fakeFacility({
    entries: [[
      'session-a',
      {
        consecutive: 0,
        armed: { count: 5, percent: 62, usedTokens: 62000, contextWindow: 100000, threshold: 50 },
        fired: false,
        seq: 40,
        updatedAt: Date.now(),
      },
    ]],
  })
  const created = []
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  const watcher = makeWatcher({ store, created })
  await store.ready

  // Any event that builds the state also restores it; the turn boundary then
  // releases the hand-off.
  watcher.handleTurnStopping(session)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created.length, 1, 'the earned hand-off was not lost with the process')

  await store.dispose()
})

test('a low-occupancy compression still breaks the run across a restart', async () => {
  // A run of four was persisted, then the conversation dropped back to a low
  // occupancy. That break has to reach the medium, or a restart would resume a
  // run the conversation had already abandoned.
  const facility = fakeFacility({
    entries: [['session-a', { consecutive: 4, armed: null, fired: false, seq: 40, updatedAt: Date.now() }]],
  })
  const store = createStore({ ctx: storeContext(facility), enabled: () => true, warn: () => {} })
  await store.ready
  const watcher = makeWatcher({ store, percent: 30 })
  watcher.handleSessionEvent(session, start('low'))
  watcher.handleSessionEvent(session, end('low'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(facility.stored.get('session-a').consecutive, 0, 'the break reached the medium')

  await store.dispose()
})

test('apply() opens the domain and persists a run through the facility', async () => {
  const facility = fakeFacility()
  const created = []
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get(name) {
      if (name === 'storageDomain') return facility
      if (name === 'sessionProjections') {
        return { snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { contextWindow: 100000, pressureTokens: 62000 } } }) }
      }
      if (name === 'sessionTitle') return { get: () => ({ title: 'test-3' }) }
      if (name === 'agents') return { turnBoundaryOf: () => ({ openTurnStartSeq: null }) }
      if (name === 'schedule') {
        return {
          create: async (request) => {
            created.push(request)
            return { record: { title: request.title }, target: { kind: 'new_once', sessionId: 's1', create: {} } }
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      return fn()
    },
  }

  apply(ctx, { persistCounter: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(facility.opened.length, 1, 'the domain is opened before any event arrives')
  assert.equal(facility.opened[0].name, 'auto_relay')

  // Four qualifying compressions through the mounted listeners.
  for (let i = 1; i <= 4; i += 1) {
    for (const listener of listeners.get('session/event') ?? []) {
      listener(session, start(`c${i}`))
      listener(session, end(`c${i}`))
    }
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created.length, 0, 'four is not enough')
  assert.equal(facility.stored.get('session-a').consecutive, 4, 'the mounted run reached the medium')

  // The fifth relays and records the relay.
  for (const listener of listeners.get('session/event') ?? []) {
    listener(session, start('c5'))
    listener(session, end('c5'))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created.length, 1)
  assert.equal(facility.stored.get('session-a').fired, true)
})
