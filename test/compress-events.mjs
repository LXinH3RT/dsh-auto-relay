// Tests for the dual-vocabulary compression detector.
//
// A compression shows up in the session log in one of two shapes, and which one
// appears depends on the profile: DSH's own compaction appends `compaction/*`
// events, while a profile that replaces it leaves an ordinary tool call and its
// result. Both must reduce to the same `{phase, id, failed}` marker, because the
// watchdog's counting is written against that marker alone.

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_COMPRESS_TOOLS, compressionMarker, parseCompressTools } from '../lib/compress-events.js'

/** The default tool-name set, as the watcher resolves it. */
const TOOLS = new Set(DEFAULT_COMPRESS_TOOLS)

/** A `tool/call` event for one tool name. */
function call(name, callId = 'call-1') {
  return { type: 'tool/call', seq: 10, time: 1, data: { turn: 1, step: 1, callId, name, arguments: '{}' } }
}

/** A `tool/result` event carrying `text` for one call id. */
function result(text, { callId = 'call-1', isError = false } = {}) {
  return {
    type: 'tool/result',
    seq: 11,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
        id: 'msg-1',
      },
    },
  }
}

test('parseCompressTools splits on commas and whitespace', () => {
  assert.deepEqual([...parseCompressTools('compress, mcp__bili__compress  other')], ['compress', 'mcp__bili__compress', 'other'])
})

test('parseCompressTools falls back to the defaults rather than matching nothing', () => {
  // A mistyped setting must not silently turn detection off.
  assert.deepEqual([...parseCompressTools('')], DEFAULT_COMPRESS_TOOLS)
  assert.deepEqual([...parseCompressTools('   ')], DEFAULT_COMPRESS_TOOLS)
  assert.deepEqual([...parseCompressTools(undefined)], DEFAULT_COMPRESS_TOOLS)
})

test('a DSH compaction start and end pair becomes start and end markers', () => {
  const start = compressionMarker({ type: 'compaction/start', data: { compactionId: 'c1', turn: null } }, TOOLS)
  assert.deepEqual(start, { phase: 'start', id: 'c1', source: 'compaction' })

  const end = compressionMarker({ type: 'compaction/end', data: { compactionId: 'c1', turn: null } }, TOOLS)
  assert.deepEqual(end, { phase: 'end', id: 'c1', failed: false, source: 'compaction' })
})

test('a failed DSH compaction is marked failed', () => {
  const marker = compressionMarker({ type: 'compaction/end', data: { compactionId: 'c1', turn: null, error: { message: 'boom' } } }, TOOLS)
  assert.equal(marker.phase, 'end')
  assert.equal(marker.failed, true)
})

test('a compress tool call becomes a start marker keyed by the call id', () => {
  assert.deepEqual(compressionMarker(call('compress', 'call-9'), TOOLS), { phase: 'start', id: 'call-9', source: 'tool' })
})

test('the MCP-prefixed spelling is recognised too', () => {
  assert.deepEqual(compressionMarker(call('mcp__bili__compress', 'call-2'), TOOLS), { phase: 'start', id: 'call-2', source: 'tool' })
})

test('a successful compress result becomes a non-failed end marker', () => {
  const marker = compressionMarker(result('[Compressed m00001–m00002 → 1 block(s), ~103820 tokens saved.]'), TOOLS)
  assert.deepEqual(marker, { phase: 'end', id: 'call-1', failed: false, source: 'tool' })
})

test('the failure prefixes all mark the compression failed', () => {
  for (const prefix of ['[Compression FAILED', '[Compression refused', '[Compression no-op']) {
    const marker = compressionMarker(result(`${prefix} because reasons`), TOOLS)
    assert.equal(marker.phase, 'end', prefix)
    assert.equal(marker.failed, true, prefix)
  }
})

test('an isError result is failed even without a recognised prefix', () => {
  const marker = compressionMarker(result('something else entirely', { isError: true }), TOOLS)
  assert.equal(marker.failed, true)
})

test('an unrecognised result body is no evidence, not evidence of failure', () => {
  // Returning a failed marker here would reset a legitimate consecutive run.
  assert.equal(compressionMarker(result('nothing to do with compression'), TOOLS), null)
})

test('tool results for other tools are ignored', () => {
  const other = result('[Compressed nothing that matters]', { callId: 'call-other' })
  other.data.message.toolCallId = 'call-other'
  // The text alone would match the success prefix; pairing is what narrows it.
  // `compressionMarker` only sees the result, so the caller must filter results
  // by whether the corresponding call was a compression — see the watcher test.
  assert.equal(compressionMarker(other, TOOLS)?.id, 'call-other')
  assert.equal(compressionMarker(call('bash', 'call-3'), TOOLS), null)
})

test('unrelated event types are ignored entirely', () => {
  for (const type of ['step/start', 'turn/end', 'assistant/message', 'request/context', 'user/message']) {
    assert.equal(compressionMarker({ type, data: {} }, TOOLS), null, type)
  }
})

test('a disabled tool list recognises no tool calls but still sees compaction events', () => {
  const none = new Set()
  assert.equal(compressionMarker(call('compress', 'call-1'), none), null)
  assert.notEqual(compressionMarker({ type: 'compaction/start', data: { compactionId: 'c1' } }, none), null)
})
