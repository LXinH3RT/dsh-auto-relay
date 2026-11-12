import assert from 'node:assert/strict'
import { test } from 'node:test'

import { occupancy, createWatcher } from '../lib/watch.js'
import { nextTitle, splitNumberedTitle } from '../lib/title.js'
import { DEFAULTS, resolveConfig, renderPrompt } from '../lib/config.js'

/** A quiet logger so the suite output stays readable. */
const quiet = { log: () => {}, warn: () => {} }

/** A minimal session stand-in: the watcher only reads `id` and `header`. */
function session(id = 'session-a', header = { cwd: '/repo' }) {
  return { id, header }
}

/** One `compaction/start` / `compaction/end` pair. */
function start(id = 'c1') {
  return { type: 'compaction/start', seq: 1, time: 0, data: { compactionId: id, turn: 1 } }
}
function end(id = 'c1', extra = {}) {
  return { type: 'compaction/end', seq: 2, time: 0, data: { compactionId: id, turn: 1, ...extra } }
}

/**
 * Build a watcher with a fixed occupancy reading and a recording hand-off.
 *
 * @returns the watcher plus the arrays its fakes record into.
 */
function harness({ percent = 60, openTurn = false, config = {}, handed = [] } = {}) {
  const resolved = { ...resolveConfig({}, {}), ...config }
  const titles = []
  const watcher = createWatcher({
    config: resolved,
    readOccupancy: () => ({ percent, usedTokens: percent * 1000, contextWindow: 100000 }),
    readTitle: (s) => {
      titles.push(s.id)
      return 'test-3'
    },
    hasOpenTurn: () => openTurn,
    handOff: (s, armed, title) => {
      handed.push({ sessionId: s.id, armed, title })
      return Promise.resolve({ sessionId: `session-new-${handed.length}`, title: 'test-4' })
    },
    ...quiet,
  })
  return { watcher, handed, config: resolved, titles }
}

test('occupancy prefers projectedTokens and rounds like the meter', () => {
  assert.deepEqual(occupancy({ pressureTokens: 40000, contextWindow: 100000 }), {
    percent: 40, usedTokens: 40000, contextWindow: 100000,
  })
  // The projection's `projectedTokens` is what the next request would cost, so
  // it wins over the older raw sample.
  assert.deepEqual(occupancy({ pressureTokens: 40000, projectedTokens: 55000, contextWindow: 100000 }), {
    percent: 55, usedTokens: 55000, contextWindow: 100000,
  })
  // Rounding, not truncation: 50500/100000 is 50.5% and shows as 51.
  assert.equal(occupancy({ pressureTokens: 50500, contextWindow: 100000 }).percent, 51)
})

test('occupancy refuses an unmeasurable reading', () => {
  assert.equal(occupancy({ pressureTokens: 40000 }), null, 'no context window')
  assert.equal(occupancy({ contextWindow: 100000 }), null, 'no tokens')
  assert.equal(occupancy({ pressureTokens: 40000, contextWindow: 0 }), null, 'zero window')
  assert.equal(occupancy({ pressureTokens: -1, contextWindow: 100000 }), null, 'negative tokens')
  assert.equal(occupancy(null), null)
})

test('compressions at or above the threshold count up to the limit', () => {
  const { watcher, handed } = harness({ percent: 60, config: { thresholdPercent: 50, consecutiveCount: 3 } })
  const s = session()
  for (let i = 1; i <= 2; i += 1) {
    watcher.handleSessionEvent(s, start(`c${i}`))
    watcher.handleSessionEvent(s, end(`c${i}`))
  }
  assert.equal(handed.length, 0, 'two of three is not enough')
  assert.equal(watcher.inspect(s.id).consecutive, 2)
  watcher.handleSessionEvent(s, start('c3'))
  watcher.handleSessionEvent(s, end('c3'))
  // The session is idle in this harness, so the hand-off fires immediately.
  assert.equal(handed.length, 1)
  assert.equal(handed[0].armed.count, 3)
  assert.equal(handed[0].armed.percent, 60)
  assert.equal(handed[0].title, 'test-3', 'the current title is read for continuation')
})

test('the threshold is inclusive', () => {
  const { watcher, handed } = harness({ percent: 50, config: { thresholdPercent: 50, consecutiveCount: 1 } })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end())
  assert.equal(handed.length, 1, 'exactly at the threshold counts')
})

test('a below-threshold compression breaks the run', () => {
  const readings = [60, 60, 40, 60]
  let index = 0
  const handed = []
  const watcher = createWatcher({
    config: { ...resolveConfig({}, {}), thresholdPercent: 50, consecutiveCount: 3 },
    readOccupancy: () => ({ percent: readings[index], usedTokens: 0, contextWindow: 100 }),
    readTitle: () => 'test-3',
    hasOpenTurn: () => false,
    handOff: (s, armed) => {
      handed.push(armed)
      return Promise.resolve({})
    },
    ...quiet,
  })
  const s = session()
  for (let i = 0; i < readings.length; i += 1) {
    index = i
    watcher.handleSessionEvent(s, start(`c${i}`))
    watcher.handleSessionEvent(s, end(`c${i}`))
  }
  assert.equal(handed.length, 0, 'two high, one low, one high is not a run of three')
  assert.equal(watcher.inspect(s.id).consecutive, 1, 'the count restarts after the low one')
})

test('an unmeasurable compaction neither counts nor breaks the run', () => {
  const readings = [60, null, 60]
  let index = 0
  const handed = []
  const watcher = createWatcher({
    config: { ...resolveConfig({}, {}), thresholdPercent: 50, consecutiveCount: 2 },
    readOccupancy: () => (readings[index] === null ? null : { percent: readings[index], usedTokens: 0, contextWindow: 100 }),
    readTitle: () => undefined,
    hasOpenTurn: () => false,
    handOff: (s, armed) => {
      handed.push(armed)
      return Promise.resolve({})
    },
    ...quiet,
  })
  const s = session()
  for (let i = 0; i < readings.length; i += 1) {
    index = i
    watcher.handleSessionEvent(s, start(`c${i}`))
    watcher.handleSessionEvent(s, end(`c${i}`))
  }
  assert.equal(watcher.inspect(s.id).consecutive, 0, 'the run completed and reset')
  assert.equal(handed.length, 1, 'the two measurable highs completed the run')
})

test('a failed compaction is not counted', () => {
  const { watcher, handed } = harness({ percent: 90, config: { consecutiveCount: 1 } })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end('c1', { error: { name: 'Error', message: 'summary too large' } }))
  assert.equal(handed.length, 0)
  assert.equal(watcher.inspect(s.id).consecutive, 0)
})

test('a mismatched compaction id is ignored', () => {
  const { watcher, handed } = harness({ percent: 90, config: { consecutiveCount: 1 } })
  const s = session()
  watcher.handleSessionEvent(s, start('c1'))
  watcher.handleSessionEvent(s, end('c2'))
  assert.equal(handed.length, 0, 'an end that belongs to another compaction is not credited')
})

test('an open turn defers the hand-off to the turn boundary', async () => {
  let open = true
  const handed = []
  const watcher = createWatcher({
    config: { ...resolveConfig({}, {}), consecutiveCount: 1 },
    readOccupancy: () => ({ percent: 90, usedTokens: 0, contextWindow: 100 }),
    readTitle: () => 'test-3',
    hasOpenTurn: () => open,
    handOff: (s, armed) => {
      handed.push(armed)
      return Promise.resolve({})
    },
    ...quiet,
  })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end())
  assert.equal(handed.length, 0, 'a running turn holds the hand-off')
  assert.equal(watcher.inspect(s.id).armed.count, 1, 'the earned hand-off is remembered')
  open = false
  watcher.handleTurnStopping(s)
  assert.equal(handed.length, 1, 'the boundary releases it')
})

test('a throwing turn probe never blocks the hand-off', () => {
  const handed = []
  const watcher = createWatcher({
    config: { ...resolveConfig({}, {}), consecutiveCount: 1 },
    readOccupancy: () => ({ percent: 90, usedTokens: 0, contextWindow: 100 }),
    readTitle: () => undefined,
    hasOpenTurn: () => {
      throw new Error('no such service')
    },
    handOff: (s, armed) => {
      handed.push(armed)
      return Promise.resolve({})
    },
    ...quiet,
  })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end())
  assert.equal(handed.length, 1)
})

test('oncePerSession stops a second hand-off until the flag is off', async () => {
  const { watcher, handed } = harness({ percent: 90, config: { consecutiveCount: 1, oncePerSession: true } })
  const s = session()
  watcher.handleSessionEvent(s, start('a'))
  watcher.handleSessionEvent(s, end('a'))
  await Promise.resolve()
  watcher.handleSessionEvent(s, start('b'))
  watcher.handleSessionEvent(s, end('b'))
  await Promise.resolve()
  assert.equal(handed.length, 1, 'the second run is dropped')

  const second = harness({ percent: 90, config: { consecutiveCount: 1, oncePerSession: false } })
  const t = session('session-b')
  for (const id of ['a', 'b']) {
    second.watcher.handleSessionEvent(t, start(id))
    second.watcher.handleSessionEvent(t, end(id))
  }
  await Promise.resolve()
  assert.equal(second.handed.length, 2, 'without the flag each run relays')
})

test('a failed hand-off is retried at the next boundary', async () => {
  let attempts = 0
  const watcher = createWatcher({
    config: { ...resolveConfig({}, {}), consecutiveCount: 1 },
    readOccupancy: () => ({ percent: 90, usedTokens: 0, contextWindow: 100 }),
    readTitle: () => 'test-3',
    hasOpenTurn: () => false,
    handOff: () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('schedule is down')) : Promise.resolve({})
    },
    ...quiet,
  })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end())
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(attempts, 1)
  assert.notEqual(watcher.inspect(s.id).armed, null, 'the earned hand-off is restored')
  watcher.handleTurnStopping(s)
  assert.equal(attempts, 2, 'the boundary retries')
})

test('a subagent session is ignored', () => {
  const { watcher, handed } = harness({ percent: 90, config: { consecutiveCount: 1 } })
  const sub = session('session-sub', { delegationDepth: 1 })
  watcher.handleSessionEvent(sub, start())
  watcher.handleSessionEvent(sub, end())
  assert.equal(handed.length, 0)
  assert.equal(watcher.inspect('session-sub'), undefined, 'nothing is tracked for it')
})

test('a disabled watcher does nothing', () => {
  const { watcher, handed } = harness({ percent: 99, config: { consecutiveCount: 1, enabled: false } })
  const s = session()
  watcher.handleSessionEvent(s, start())
  watcher.handleSessionEvent(s, end())
  assert.equal(handed.length, 0)
})

test('unrelated events are ignored', () => {
  const { watcher } = harness({ percent: 90 })
  const s = session()
  watcher.handleSessionEvent(s, { type: 'turn/start', seq: 3, time: 0, data: {} })
  assert.equal(watcher.inspect(s.id), undefined, 'no state is created for an unrelated event')
})

test('nextTitle starts a series when the title has no trailing number', () => {
  // The point of the feature: an unnumbered name must not be copied verbatim —
  // two sessions would share it — nor replaced by a generic default.
  assert.deepEqual(nextTitle('test', '-', 'x'), { title: 'test-1', matched: false, started: true, from: null, to: 1 })
  assert.deepEqual(nextTitle('build_6', '-', 'x'), { title: 'build_6-1', matched: false, started: true, from: null, to: 1 })
  assert.deepEqual(nextTitle('my_task', '_', 'x'), { title: 'my_task_1', matched: false, started: true, from: null, to: 1 })
  // The connector is configuration: the same title becomes `test_1` with `_`.
  assert.equal(nextTitle('test', '_', 'x').title, 'test_1')
  assert.equal(nextTitle('test', '·', 'x').title, 'test·1')
  // A multi-character separator works literally (no regex interpretation).
  assert.equal(nextTitle('test', ' v', 'x').title, 'test v1')
  // A title already ending in the separator must not get a doubled one.
  assert.equal(nextTitle('test-', '-', 'x').title, 'test-1')
  // A number that is not trailing starts a fresh series rather than being guessed.
  assert.equal(nextTitle('report-3-final', '-', 'x').title, 'report-3-final-1')
  // A bare separator with no stem has nothing to number.
  assert.equal(nextTitle('-3', '-', 'x').title, '-3-1')
})

test('nextTitle leaves numbering alone when detection is disabled or the title is empty', () => {
  // An empty separator disables the whole numbering rule.
  assert.equal(nextTitle('test-3', '', 'x').title, 'test-3')
  assert.equal(nextTitle('test', '', 'x').title, 'test')
  // A missing title still falls back to the configured default.
  assert.equal(nextTitle('', '-', '自动接力').title, '自动接力')
  assert.equal(nextTitle(undefined, '-', '自动接力').title, '自动接力')
  // The fallback is also used when the caller suppresses the rule entirely.
  assert.equal(nextTitle('test', '-', '').title, 'test-1')
})

test('nextTitle still continues a numbered title', () => {
  assert.deepEqual(nextTitle('test-3', '-', 'x'), { title: 'test-4', matched: true, started: false, from: 3, to: 4 })
  assert.deepEqual(nextTitle('build-6', '-', 'x'), { title: 'build-7', matched: true, started: false, from: 6, to: 7 })
  assert.deepEqual(nextTitle('task_12', '_', 'x'), { title: 'task_13', matched: true, started: false, from: 12, to: 13 })
  // Zero padding is how the user sorts these, so it survives the increment.
  assert.deepEqual(nextTitle('test-007', '-', 'x'), { title: 'test-008', matched: true, started: false, from: 7, to: 8 })
  // Outgrowing the padding is fine; widening it is not.
  assert.equal(nextTitle('test-99', '-', 'x').title, 'test-100')
  assert.equal(splitNumberedTitle('  test-3  ', '-').title, undefined)
  assert.deepEqual(splitNumberedTitle('  test-3  ', '-'), { stem: '  test', digits: '3', value: 3 })
})

test('renderPrompt fills known placeholders and keeps unknown ones', () => {
  assert.equal(
    renderPrompt('{sessionId} 第 {count} 次 {percent}% {threshold}% {title}', {
      sessionId: 'session-a', count: 3, percent: 62, threshold: 50, title: 'test-4',
    }),
    'session-a 第 3 次 62% 50% test-4',
  )
  assert.equal(renderPrompt('{unknown} {count}', { count: 1 }), '{unknown} 1')
})

test('resolveConfig clamps and falls back', () => {
  assert.equal(resolveConfig({ thresholdPercent: 200 }, {}).thresholdPercent, DEFAULTS.thresholdPercent)
  assert.equal(resolveConfig({ thresholdPercent: 65 }, {}).thresholdPercent, 65)
  assert.equal(resolveConfig({ consecutiveCount: 0 }, {}).consecutiveCount, DEFAULTS.consecutiveCount)
  assert.equal(resolveConfig({ separator: '   ' }, {}).separator, DEFAULTS.separator)
  // An environment value is used only when the configured one is absent.
  assert.equal(resolveConfig({}, { DSH_AUTO_RELAY_THRESHOLD_PERCENT: '70' }).thresholdPercent, 70)
  assert.equal(resolveConfig({ thresholdPercent: 60 }, { DSH_AUTO_RELAY_THRESHOLD_PERCENT: '70' }).thresholdPercent, 60)
  // A volatile cell is what the panel actually hands over; `.get()` is the value.
  assert.equal(resolveConfig({ thresholdPercent: { get: () => 80 } }, {}).thresholdPercent, 80)
  assert.equal(resolveConfig({ enabled: { get: () => false } }, {}).enabled, false)
})
