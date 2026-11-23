// Did the continuation session actually start working?
//
// The behaviour under test is the one that failed on a real machine, twice. The
// first relay died with `UNKNOWN_MODEL` and nothing noticed. After that was
// fixed the bookkeeper still could not tell the difference between "a call was
// dispatched" and "the model answered" — it counted `step/start` as proof, and on
// the second failure the successor logged `step/start` at +1544 ms, a FAILING
// `assistant/attempt` at +1560 ms, and the fatal `turn/end{kind:'error'}` at
// +1561 ms. The relay had been written off as healthy one millisecond before the
// error arrived, so the rescue never ran.
//
// The distinctions that matter now are:
//
//   * silence  — no event at all: reported, never treated as failure;
//   * proof    — an assistant message or a tool call: the model answered;
//   * failure  — the FIRST turn ends in error before any proof: rescued.
//
// Dispatch-order events (`step/start`, `assistant/attempt`) are deliberately NOT
// proof: they fire on the way to a failure too.
//
// An error arriving after a proof is an ordinary turn failure: by then the relay
// is no longer watched, so nothing is reported and nothing is rescued.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TIMEOUT_MS, PROOF_EVENTS, createConfirm } from '../lib/confirm.js'

/** A bookkeeper plus the calls it made, for assertions. */
function harness(options = {}) {
  const failed = []
  const timedOut = []
  const warnings = []
  const logs = []
  let clock = 1000
  const confirm = createConfirm({
    now: () => clock,
    warn: (message) => warnings.push(message),
    log: (message) => logs.push(message),
    onFail: (record, detail) => failed.push({ record, detail }),
    onTimeout: (record) => timedOut.push(record),
    ...options,
  })
  return {
    confirm,
    failed,
    timedOut,
    warnings,
    logs,
    advance: (ms) => {
      clock += ms
    },
  }
}

/** A session stub; only `id` is read. */
function session(id) {
  return { id }
}

/** The turn/end payload for a failed first turn. */
function errorTurn(message, code) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message, code } } } }
}

test('the proof events are the ones that mean the model answered', () => {
  assert.deepEqual(
    [...PROOF_EVENTS].sort(),
    ['assistant/message', 'tool/call'],
    'a dispatched call is not proof: step/start and assistant/attempt fire before a failure too',
  )
})

test('an assistant message proves the successor is running', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.equal(h.confirm.isPending('session-new'), true)
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'assistant/message' }), 'proved')
  assert.equal(h.confirm.isPending('session-new'), false, 'a proved relay is no longer watched')
  assert.equal(h.failed.length, 0, 'nothing to rescue')
  assert.equal(h.logs.length, 1, 'the proof is logged')
})

test('a tool call proves the successor is running', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'tool/call' }), 'proved')
  assert.equal(h.failed.length, 0)
})

test('a dispatched step is never proof on its own', () => {
  // The regression: this returned 'proved' and silently disarmed the rescue.
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'step/start' }), null, 'not proof')
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'assistant/attempt' }), null, 'not proof either')
  assert.equal(h.confirm.isPending('session-new'), true, 'the relay is still being watched')
})

test('a failing attempt followed by the fatal turn still fails the relay', () => {
  // The exact observed order, in miniature.
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new', drained: [{ id: 'm1' }] })
  h.confirm.handleEvent(session('session-new'), { type: 'step/start' })
  h.confirm.handleEvent(session('session-new'), {
    type: 'assistant/attempt',
    data: { finish: { reason: 'error' } },
  })
  const verdict = h.confirm.handleEvent(
    session('session-new'),
    errorTurn('llm-deepseek: no API key for provider route "deepseek-official"', 'MISSING_CREDENTIAL'),
  )
  assert.equal(verdict, 'failed', 'the rescue is not disarmed by dispatch events')
  assert.equal(h.failed.length, 1)
  assert.deepEqual(h.failed[0].record.drained, [{ id: 'm1' }], 'the drained queue travels to the rescue')
  assert.equal(h.failed[0].detail.code, 'MISSING_CREDENTIAL')
})

test('a completed first turn counts as proof even without a message', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  const verdict = h.confirm.handleEvent(session('session-new'), {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(verdict, 'proved')
  assert.equal(h.failed.length, 0)
})

test('a first turn that errors before any proof is a failed relay', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new', drained: [{ id: 'm1' }] })
  const verdict = h.confirm.handleEvent(
    session('session-new'),
    errorTurn('pi-ai provider "workbuddy" has no configured model "hy4free"', 'UNKNOWN_MODEL'),
  )
  assert.equal(verdict, 'failed')
  assert.equal(h.failed.length, 1, 'the rescue ran')
  const { record, detail } = h.failed[0]
  assert.equal(record.parentId, 'session-old', 'the old session is named for the rescue')
  assert.deepEqual(record.drained, [{ id: 'm1' }], 'the drained queue travels to the rescue')
  assert.equal(detail.code, 'UNKNOWN_MODEL')
  assert.match(detail.message, /no configured model/u)
  assert.match(h.warnings[0], /第一轮就失败了/u, 'the warning names what happened')
  assert.equal(h.confirm.isPending('session-new'), false, 'a failed relay is no longer watched')
})

test('an error after the session already answered is an ordinary turn failure', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'assistant/message' }), 'proved')
  // A later error in the same session is now just conversation noise: the relay
  // was settled when the model answered, so the bookkeeper has nothing to say.
  const verdict = h.confirm.handleEvent(
    session('session-new'),
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'context exceeded', code: 'CONTEXT_OVERFLOW' } } } },
  )
  assert.equal(verdict, null, 'a settled relay never reports failure')
  assert.equal(h.failed.length, 0)
})

test('events of sessions it is not watching are ignored', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.equal(h.confirm.handleEvent(session('session-other'), { type: 'assistant/message' }), null)
  assert.equal(h.confirm.handleEvent(session('session-new'), { type: 'session/title' }), null)
  assert.equal(h.confirm.handleEvent(undefined, { type: 'assistant/message' }), null)
  assert.equal(h.confirm.isPending('session-new'), true, 'an unrelated event does not settle the relay')
})

test('silence is reported after the timeout but never treated as failure', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  assert.deepEqual(h.confirm.sweep(), [], 'nothing is reported before the horizon')
  h.advance(DEFAULT_TIMEOUT_MS + 1)
  assert.deepEqual(h.confirm.sweep(), ['session-new'], 'the silent relay is reported once')
  assert.equal(h.timedOut.length, 1, 'the timeout callback ran')
  assert.equal(h.failed.length, 0, 'silence is not failure')
  assert.match(h.warnings[0], /没有任何动静/u)
  assert.deepEqual(h.confirm.sweep(), [], 'a reported relay is not reported again')
})

test('a relay that proves itself before the timeout is never reported', () => {
  const h = harness()
  h.confirm.track({ parentId: 'session-old', childId: 'session-new' })
  h.confirm.handleEvent(session('session-new'), { type: 'assistant/message' })
  h.advance(DEFAULT_TIMEOUT_MS + 1)
  assert.deepEqual(h.confirm.sweep(), [])
  assert.equal(h.timedOut.length, 0)
})

test('clear forgets every watched relay', () => {
  const h = harness()
  h.confirm.track({ parentId: 'a', childId: 'b' })
  h.confirm.track({ parentId: 'a', childId: 'c' })
  assert.equal(h.confirm.inspect().length, 2)
  h.confirm.clear()
  assert.equal(h.confirm.inspect().length, 0)
  assert.equal(h.confirm.isPending('b'), false)
})

test('tracking needs a continuation id and tolerates a bare record', () => {
  const h = harness()
  h.confirm.track({})
  h.confirm.track({ parentId: 'a' })
  h.confirm.track(null)
  assert.deepEqual(h.confirm.inspect(), [], 'a record without a child id is not tracked')

  h.confirm.track({ parentId: 'a', childId: 'b' })
  const [record] = h.confirm.inspect()
  assert.equal(record.parentId, 'a')
  assert.equal(record.title, null, 'a missing title is null, not undefined')
  assert.equal(record.count, 0)
  assert.deepEqual(record.drained, [])
  assert.equal(record.proved, false)
})

test('the last relay tracked for one session id wins', () => {
  const h = harness()
  h.confirm.track({ parentId: 'old-1', childId: 'shared' })
  h.confirm.track({ parentId: 'old-2', childId: 'shared' })
  const [record] = h.confirm.inspect()
  assert.equal(record.parentId, 'old-2')
  assert.equal(h.confirm.inspect().length, 1)
})
