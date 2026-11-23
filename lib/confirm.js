// Did the continuation session actually start working?
//
// The hand-off used to be fire-and-forget: `schedule.create` resolved, the
// watchdog set `fired = true`, and nothing ever looked at the successor again.
// On this machine that was wrong in a way the user felt — the relay session was
// created, its first model call failed with `UNKNOWN_MODEL`, and because the old
// session had already been told to archive itself the queued work was dropped and
// the conversation stopped making progress.
//
// So a hand-off is now provisional until the successor proves it can run. Proof
// is deliberately narrow: only evidence that a model actually ANSWERED counts —
// an `assistant/message`, a `tool/call`, or a first `turn/end` that is not an
// error.
//
// Narrow is the point, and it was learned the hard way. The first version also
// accepted `step/start` and `assistant/attempt`, on the theory that dispatching a
// call is progress. Both fire on the way to a failure: on this machine a successor
// logged `step/start` at +1544 ms and a failing `assistant/attempt` at +1560 ms,
// and the fatal `turn/end{kind:'error'}` arrived at +1561 ms. The bookkeeper had
// already marked the relay proved and dropped its record, so the error was
// discarded as "an ordinary failure of a session that demonstrably ran" — and the
// recovery that exists for exactly this case never fired. The old session stayed
// stopped and the work went nowhere.
//
// The failure shape is therefore checked FIRST and wins over any proof: the first
// `turn/end` carrying `{kind: 'error'}` fails the relay whenever nothing has
// answered yet, no matter how many calls were dispatched beforehand.
//
// What happens on failure is the caller's business (`onFail`), because only the
// caller can reach the workspace registry and the old agent. This module owns
// just the bookkeeping: which sessions are pending, and what an event means.
//
// A session that produces nothing at all is a third outcome (`timeout`). It is
// reported but never treated as a failure: the successor may simply be waiting
// for the delivery floor, and cancelling a healthy relay on a quiet log would be
// worse than the problem it prevents.

/** Default grace period before a silent successor is reported, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * The event types that prove the model answered, not merely that it was asked.
 *
 * `step/start` and `assistant/attempt` are deliberately absent: both are emitted
 * before a call can fail, so counting them would launder a dead first turn into
 * success. See the module comment for the observed timings.
 */
const PROOF_EVENTS = new Set(['assistant/message', 'tool/call'])

/**
 * Build the relay-confirmation bookkeeper.
 *
 * @param options.onFail - `(record, detail) => void`; the successor failed.
 * @param options.onTimeout - `(record) => void`; the successor said nothing.
 * @param options.warn - warning sink.
 * @param options.log - informational sink.
 * @param options.timeoutMs - silence horizon per relay.
 * @param options.now - clock, injectable for tests.
 */
export function createConfirm(options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const onFail = typeof options.onFail === 'function' ? options.onFail : () => {}
  const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {}

  /**
   * Relays awaiting proof, keyed by the CONTINUATION session id.
   *
   * `parentId` is what gets rescued on failure; `drained` is the queued input the
   * prompt carried, kept so it can be handed back to the old session.
   */
  const pending = new Map()

  function take(childId) {
    const record = pending.get(childId)
    if (record === undefined) return undefined
    pending.delete(childId)
    return record
  }

  return {
    /**
     * Start watching one successor.
     *
     * @param record - `{parentId, childId, count?, drained?, title?}`.
     */
    track(record) {
      if (record === null || typeof record !== 'object') return
      if (typeof record.childId !== 'string' || record.childId === '') return
      pending.set(record.childId, {
        parentId: typeof record.parentId === 'string' ? record.parentId : null,
        childId: record.childId,
        title: typeof record.title === 'string' ? record.title : null,
        count: Number.isFinite(record.count) ? record.count : 0,
        drained: Array.isArray(record.drained) ? record.drained : [],
        at: now(),
        proved: false,
      })
    },

    /**
     * Fold one committed event of any session.
     *
     * @param session - the session the event belongs to.
     * @param event - `{type, data}`.
     * @returns `'proved' | 'failed' | null` — what this event decided, if anything.
     */
    handleEvent(session, event) {
      const id = session?.id
      if (typeof id !== 'string') return null
      const record = pending.get(id)
      if (record === undefined) return null

      // Failure is tested before proof. A dead first turn emits several events on
      // its way down, and any of them must not rescue the relay from the error
      // that follows.
      if (event?.type === 'turn/end') {
        const reason = event.data?.reason
        if (reason !== null && typeof reason === 'object' && reason.kind === 'error' && !record.proved) {
          take(id)
          const detail = {
            message: String(reason.error?.message ?? '未知错误'),
            code: String(reason.error?.code ?? ''),
          }
          warn(
            `dsh-auto-relay: 接力会话 ${id} 的第一轮就失败了（${detail.code || 'no code'}: ${detail.message}），` +
            '正在恢复上一会话',
          )
          onFail(record, detail)
          return 'failed'
        }
        // A first turn that ends without an error is proof: the model answered and
        // the loop decided it was done.
        record.proved = true
        take(id)
        return 'proved'
      }

      if (PROOF_EVENTS.has(event?.type)) {
        record.proved = true
        take(id)
        log(`dsh-auto-relay: 接力会话 ${id} 已开始执行（收到 ${event.type}）`)
        return 'proved'
      }

      return null
    },

    /**
     * Report relays that have produced no evidence at all.
     *
     * Called on a timer by the plugin; never treats silence as failure.
     *
     * @returns the ids reported.
     */
    sweep() {
      if (pending.size === 0) return []
      const cutoff = now() - timeoutMs
      const reported = []
      for (const [id, record] of pending) {
        if (record.at > cutoff) continue
        pending.delete(id)
        reported.push(id)
        warn(
          `dsh-auto-relay: 接力会话 ${id} 在 ${Math.round(timeoutMs / 1000)} 秒内没有任何动静，` +
          '请确认它是否正常开始（上一会话未做任何改动）',
        )
        onTimeout(record)
      }
      return reported
    },

    /** Whether a session is still awaiting confirmation. */
    isPending(sessionId) {
      return pending.has(sessionId)
    },

    /** Read-only view, for diagnostics and tests. */
    inspect() {
      return Array.from(pending.values()).map((record) => ({ ...record }))
    },

    /** Forget everything (used when the plugin is disabled or disposed). */
    clear() {
      pending.clear()
    },
  }
}

export { DEFAULT_TIMEOUT_MS, PROOF_EVENTS }
