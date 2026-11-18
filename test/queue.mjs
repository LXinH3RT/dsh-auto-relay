// Queued input across a hand-off: what travels, what stays, and in what order.
//
// The three operations have to agree about the exact boundary — `renderQueue`
// decides what the prompt claims, `renderedCount` decides how much to remove,
// and `drainQueue` removes precisely that prefix. A disagreement here would
// either lose input (drained but never carried) or duplicate it (carried but
// still queued), which is the whole failure this module exists to prevent.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ITEMS,
  drainQueue,
  messageText,
  readInbox,
  renderQueue,
  renderedCount,
  restoreQueue,
} from '../lib/queue.js'

/** A message shaped like the ones the inbox actually stores. */
function message(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A live-agent stub with a real, mutable inbox. */
function agentWith(nextTurn = [], nextStep = []) {
  const state = { 'next-turn': [...nextTurn], 'next-step': [...nextStep] }
  return {
    state,
    inbox: {
      get nextTurn() {
        return state['next-turn']
      },
      get nextStep() {
        return state['next-step']
      },
      get hasPending() {
        return state['next-turn'].length > 0 || state['next-step'].length > 0
      },
      remove(id) {
        for (const target of ['next-turn', 'next-step']) {
          const index = state[target].findIndex((entry) => entry.id === id)
          if (index < 0) continue
          state[target].splice(index, 1)
          return true
        }
        return false
      },
      prepend(target, entry) {
        state[target].unshift(entry)
      },
    },
  }
}

test('readInbox reports both queues and their total', () => {
  const agent = agentWith([message('a', 'one')], [message('b', 'two'), message('c', 'three')])
  const pending = readInbox(agent)
  assert.equal(pending.nextTurn.length, 1, 'next-turn is read')
  assert.equal(pending.nextStep.length, 2, 'next-step is read')
  assert.equal(pending.total, 3, 'the total counts both')
})

test('readInbox answers empty for an agent that has no inbox', () => {
  for (const agent of [undefined, null, {}, { inbox: null }, { inbox: 42 }]) {
    const pending = readInbox(agent)
    assert.deepEqual(pending, { nextTurn: [], nextStep: [], total: 0 })
  }
})

test('messageText keeps text and names what cannot travel', () => {
  assert.equal(messageText(message('a', '继续修一下光标')), '继续修一下光标')
  assert.equal(
    messageText({ content: [{ type: 'text', text: '看图' }, { type: 'image' }] }),
    '看图\n[图片附件，无法随接力传递]',
  )
  assert.equal(
    messageText({ content: [{ type: 'file', attachment: { name: 'spec.pdf' } }] }),
    '[文件附件：spec.pdf，无法随接力传递]',
  )
  assert.equal(messageText({ content: 'plain string' }), 'plain string')
  assert.equal(messageText({ content: [{ type: 'mystery' }] }), '[mystery 块，无法随接力传递]')
  assert.equal(messageText({}), '')
})

test('renderQueue lists the queue in order and speaks of it as a transcript', () => {
  const pending = { nextTurn: [message('a', '第一条')], nextStep: [message('b', '第二条')] }
  const block = renderQueue(pending)
  assert.match(block, /还有 2 条排队输入没有处理完/u, 'the count is stated')
  assert.match(block, /不要当成用户刚刚说的话重复确认/u, 'the model is told it is a transcript')
  const first = block.indexOf('1. 第一条')
  const second = block.indexOf('2. 第二条')
  assert.ok(first > 0 && second > first, 'next-turn comes before next-step and both are numbered')
})

test('renderQueue answers empty when nothing is queued', () => {
  assert.equal(renderQueue({ nextTurn: [], nextStep: [] }), '')
  assert.equal(renderQueue({ nextTurn: [message('a', '   ')], nextStep: [] }), '')
})

test('renderQueue bounds by characters and says so', () => {
  const pending = { nextTurn: [message('a', 'x'.repeat(50)), message('b', 'y'.repeat(50))], nextStep: [] }
  const block = renderQueue(pending, { maxChars: 80, maxItems: 10 })
  assert.match(block, /只抄录了前 1 条/u, 'the cut is announced')
  assert.equal(block.includes('y'.repeat(50)), false, 'the oversized entry is not included')
})

test('renderQueue bounds by item count', () => {
  const pending = {
    nextTurn: [message('a', 'one'), message('b', 'two'), message('c', 'three')],
    nextStep: [],
  }
  const block = renderQueue(pending, { maxChars: 100000, maxItems: 2 })
  assert.equal(block.includes('3. three'), false, 'the third entry is cut by the item bound')
  assert.match(block, /只抄录了前 2 条/u)
  assert.equal(renderQueue(pending, { maxItems: 3 }).includes('3. three'), true, 'a larger bound includes it')
})

test('renderedCount matches exactly what renderQueue included', () => {
  const pending = {
    nextTurn: [message('a', 'one'), message('b', 'x'.repeat(200))],
    nextStep: [message('c', 'three')],
  }
  for (const options of [
    { maxChars: 100000, maxItems: 10 },
    { maxChars: 60, maxItems: 10 },
    { maxChars: 100000, maxItems: 1 },
    { maxChars: 0, maxItems: 10 },
  ]) {
    const block = renderQueue(pending, options)
    const count = renderedCount(pending, options)
    const numbered = block.split('\n').filter((line) => /^\d+\. /u.test(line)).length
    assert.equal(count, numbered, `count agrees with the block for ${JSON.stringify(options)}`)
  }
})

test('drainQueue removes exactly the prefix that travelled', () => {
  const agent = agentWith([message('a', 'one'), message('b', 'two')], [message('c', 'three')])
  const pending = readInbox(agent)
  const count = 2
  const removed = drainQueue(agent, pending, count)
  assert.deepEqual(removed.map((entry) => entry.id), ['a', 'b'], 'the first two were removed')
  assert.deepEqual(agent.state['next-turn'], [], 'next-turn is empty')
  assert.deepEqual(agent.state['next-step'].map((entry) => entry.id), ['c'], 'the rest stayed')
})

test('restoreQueue puts messages back in their original order', () => {
  const agent = agentWith([], [])
  const messages = [message('a', 'one'), message('b', 'two')]
  assert.equal(restoreQueue(agent, messages), 2)
  assert.deepEqual(agent.state['next-turn'].map((entry) => entry.id), ['a', 'b'], 'order is preserved')
  assert.equal(restoreQueue(agent, []), 0, 'nothing to restore is not an error')
  assert.equal(restoreQueue(undefined, messages), 0, 'a dead agent restores nothing')
})

test('a full round trip leaves the inbox exactly as it was', () => {
  const original = [message('a', 'one'), message('b', 'two')]
  const agent = agentWith(original, [message('c', 'three')])
  const pending = readInbox(agent)
  const before = JSON.stringify(agent.state)
  const count = renderedCount(pending, { maxChars: DEFAULT_MAX_CHARS, maxItems: DEFAULT_MAX_ITEMS })
  const removed = drainQueue(agent, pending, count)
  assert.notEqual(JSON.stringify(agent.state), before, 'the drain changed the queue')
  restoreQueue(agent, removed)
  assert.deepEqual(agent.state['next-turn'].map((entry) => entry.id), ['a', 'b', 'c'], 'everything is back in order')
})

test('a default bound exists so one huge queue cannot fill the prompt', () => {
  assert.ok(DEFAULT_MAX_CHARS > 0 && DEFAULT_MAX_CHARS <= 20000)
  assert.ok(DEFAULT_MAX_ITEMS >= 1 && DEFAULT_MAX_ITEMS <= 100)
})
