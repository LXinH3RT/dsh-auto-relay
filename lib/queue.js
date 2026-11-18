// Carrying queued input across the hand-off.
//
// A user can type while the agent is working. DSH keeps that input in a
// driver-owned, durable inbox on the session itself — `next-turn` (one whole
// turn each) and `next-step` (folded into the step that is already running) —
// and it is consumed in order. A hand-off can therefore land in the middle of a
// queue: five of seven prompts answered, the relay fires, and item six is still
// waiting in a session that has just given its work away.
//
// What happens to it without this module is decided entirely by whether the old
// session gets archived (the default): archiving calls `agent.cancel`, which
// clears the inbox, so the item is silently DROPPED. Turning archiving off is
// worse — the old session keeps its queue, wakes up, and does the work a second
// time, in parallel with the successor.
//
// So the queue travels with the hand-off, rendered into the delivered prompt the
// way `ralph-loop` carries its own hand-off: bounded, structured, and explicit
// that it is a transcript rather than a live instruction to the model.
//
// The ORDER of the two durable steps matters and is the whole safety argument:
//
//   1. `schedule.create` RESERVES the successor and returns its identity. Only
//      after that succeeds is the hand-off real.
//   2. Then the old inbox is drained, and the drained messages are held in
//      memory by the caller so a later delivery failure can put them back.
//
// Draining first would lose the user's words if the reservation failed, which is
// the failure this machine actually saw (a relay session that existed and could
// not run). The reverse order loses nothing that `restore` cannot undo.
//
// Nothing here touches the network or the log: it reads and mutates the live
// agent's inbox through the documented `append`/`remove`/`prepend` operations,
// each of which is itself a durable `agent/inbox/spliced` append.

/** How much of the queued input travels, in characters, by default. */
const DEFAULT_MAX_CHARS = 6000

/** How many queued messages travel, by default. */
const DEFAULT_MAX_ITEMS = 20

/**
 * Read one agent's pending input.
 *
 * `next-turn` is listed first because those are complete user prompts waiting
 * for a turn of their own; `next-step` entries are context that would have been
 * folded into the step already running, so they are older by nature — they were
 * typed while the previous step was in flight.
 *
 * @param agent - live agent, or undefined.
 * @returns `{nextTurn, nextStep, total}` with arrays that are never null.
 */
export function readInbox(agent) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object') return { nextTurn: [], nextStep: [], total: 0 }
  let nextTurn = []
  let nextStep = []
  try {
    if (Array.isArray(inbox.nextTurn)) nextTurn = inbox.nextTurn
  } catch {
    // A broken getter reads as "nothing queued".
  }
  try {
    if (Array.isArray(inbox.nextStep)) nextStep = inbox.nextStep
  } catch {
    // Same.
  }
  return { nextTurn, nextStep, total: nextTurn.length + nextStep.length }
}

/**
 * Flatten one message's content to text.
 *
 * A non-text block is named rather than dropped, so the successor knows a file
 * or image was attached to that prompt even though its bytes cannot travel.
 *
 * @param message - a `UserMessage`-shaped value.
 * @returns the message's text, always a string.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'image') parts.push('[图片附件，无法随接力传递]')
    else if (block.type === 'file') parts.push(`[文件附件${typeof block.attachment?.name === 'string' ? `：${block.attachment.name}` : ''}，无法随接力传递]`)
    else if (typeof block.type === 'string') parts.push(`[${block.type} 块，无法随接力传递]`)
  }
  return parts.join('\n')
}

/**
 * Render queued input as the bounded block that rides on the prompt.
 *
 * The block is deliberately written as a QUOTED transcript and not as fresh user
 * instructions: it is material the successor must read and act on in the context
 * of the task, and it must not be mistaken for something the user just said.
 *
 * Oversized input is cut, and the cut is announced — a silently truncated queue
 * would let the successor believe it has seen everything.
 *
 * @param pending - `{nextTurn, nextStep}` from {@link readInbox}.
 * @param options - `{maxChars, maxItems}` bounds.
 * @returns the block, or `''` when nothing is queued.
 */
export function renderQueue(pending, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, options.maxChars) : DEFAULT_MAX_CHARS
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(0, options.maxItems) : DEFAULT_MAX_ITEMS
  const ordered = [...(pending.nextTurn ?? []), ...(pending.nextStep ?? [])]
  if (ordered.length === 0) return ''

  const lines = []
  lines.push(`上一会话交给你时，还有 ${ordered.length} 条排队输入没有处理完。它们按顺序抄录在下面，请把它们当作延续该任务的指令逐条完成，不要当成用户刚刚说的话重复确认。`)

  let used = 0
  let included = 0
  let truncated = false
  for (const message of ordered) {
    if (included >= maxItems) {
      truncated = true
      break
    }
    const text = messageText(message).trim()
    if (text === '') continue
    const numbered = `${included + 1}. ${text}`
    if (used + numbered.length > maxChars) {
      truncated = true
      break
    }
    lines.push(numbered)
    used += numbered.length
    included += 1
  }

  if (included === 0) return ''
  if (truncated) {
    lines.push(`（受长度限制，上面只抄录了前 ${included} 条；其余排队输入仍需在上一会话中查看。）`)
  }
  return lines.join('\n')
}

/**
 * Drain the queued input that was just rendered into a prompt.
 *
 * Only what actually travelled is removed: an entry cut by the bounds stays in
 * the old session, because the successor was never told about it. `remove` is
 * the documented single-message operation and each call appends its own durable
 * splice, so a crash mid-drain leaves a consistent (partially drained) queue.
 *
 * @param agent - live agent, or undefined.
 * @param rendered - `{nextTurn, nextStep}` in the same order the render used.
 * @param count - how many of the ordered messages the render actually included.
 * @returns the removed messages, for {@link restoreQueue}.
 */
export function drainQueue(agent, rendered, count) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object' || typeof inbox.remove !== 'function') return []
  const ordered = [...(rendered.nextTurn ?? []), ...(rendered.nextStep ?? [])]
  const removed = []
  for (const message of ordered.slice(0, count)) {
    if (typeof message?.id !== 'string') continue
    try {
      if (inbox.remove(message.id) === true) removed.push(message)
    } catch {
      // A message that cannot be removed is left where it is; the successor was
      // told about it either way, and losing it entirely would be worse.
    }
  }
  return removed
}

/**
 * Put drained messages back after a failed hand-off.
 *
 * They go back to `next-turn` in their original order — the queue they came from
 * as far as the user is concerned — and only if the agent is still alive.
 *
 * @param agent - live agent, or undefined.
 * @param removed - what {@link drainQueue} returned.
 * @returns how many were restored.
 */
export function restoreQueue(agent, removed) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object') return 0
  if (!Array.isArray(removed) || removed.length === 0) return 0
  // Reverse: prepending each in turn leaves the earliest first.
  let restored = 0
  for (const message of [...removed].reverse()) {
    try {
      if (typeof inbox.prepend === 'function') {
        inbox.prepend('next-turn', message)
        restored += 1
      } else if (typeof inbox.append === 'function') {
        inbox.append('next-turn', message)
        restored += 1
      }
    } catch {
      // Nothing more can be done for this one.
    }
  }
  return restored
}

/**
 * How many of the ordered messages {@link renderQueue} included.
 *
 * Mirrors the render loop's counting exactly, so `drainQueue` removes precisely
 * what the prompt claims. Kept as a separate function so the bounds are applied
 * in one place: the render, the drain, and the restore all agree.
 *
 * @param pending - `{nextTurn, nextStep}`.
 * @param options - the same bounds handed to {@link renderQueue}.
 * @returns the number of leading messages that made it into the block.
 */
export function renderedCount(pending, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, options.maxChars) : DEFAULT_MAX_CHARS
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(0, options.maxItems) : DEFAULT_MAX_ITEMS
  const ordered = [...(pending.nextTurn ?? []), ...(pending.nextStep ?? [])]
  let used = 0
  let included = 0
  for (const message of ordered) {
    if (included >= maxItems) break
    const text = messageText(message).trim()
    if (text === '') continue
    const numbered = `${included + 1}. ${text}`
    if (used + numbered.length > maxChars) break
    used += numbered.length
    included += 1
  }
  return included
}

export { DEFAULT_MAX_CHARS, DEFAULT_MAX_ITEMS }
