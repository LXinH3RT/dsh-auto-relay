// The watchdog itself: count compressions, decide when to hand the work off.
//
// Everything here is driven by the session's own log, which records a
// compression as a start marker followed by an end marker. WHICH events carry
// those markers depends on the profile: DSH's own `dsh-compaction-basic` appends
// `compaction/start` / `compaction/end`, while a profile that replaces it (with
// billion-context, say) leaves an ordinary `compress` tool call and its result.
// `lib/compress-events.js` normalises both, so this module only ever sees
// `{phase, id, failed}`.
//
// The OCCUPANCY READING has to be taken at the START marker, not at the end:
// by the time a compression finishes, the surface has already been replaced by
// the summary, so the meter is back down to a small number and every
// compression would look harmless. At the start the fold still holds the
// pre-compression prompt size, which is exactly the moment the user's rule
// names ("压缩发生时").
//
// Keeping the count in this module, fed by injected readers, is deliberate: the
// interesting part is the state machine, and it can be exercised with plain
// objects instead of a live Host.
//
// DURABILITY is optional and arrives as an injected store (`lib/persist.js`).
// Without one the count lives only in this process, so a restart starts a fresh
// run — and a session that had already reached four of five high-occupancy
// compressions would then need five MORE before the hand-off, by which point the
// context may have overshot the limit. With a store the count (and the armed
// hand-off, and the "already relayed" flag) survives a restart.
//
// Restoration is deliberately ONE-SIDED: `hydrate` is consulted when a session's
// state is first built, and `save` is written after every mutation. A stored
// record is never merged into a live counter mid-run, because the direction of
// an error matters here — undercounting loses the protection this feature exists
// to provide, while overcounting only opens a successor session earlier.

import { DEFAULT_COMPRESS_TOOLS, compressionMarker, parseCompressTools } from './compress-events.js'

const NOOP = () => {}

/**
 * The occupancy a conversation meter shows for one pressure reading.
 *
 * `projectedTokens` is preferred over `pressureTokens` because it is what the
 * next request would actually cost: it adds the surface movement since the last
 * provider sample. Using the raw sample would under-report a session that has
 * grown a lot since its last turn, and the meter would disagree with the plugin.
 *
 * @param pressure - `{pressureTokens?, projectedTokens?, contextWindow?}`.
 * @returns `{percent, usedTokens, contextWindow}`, or null when unmeasurable.
 */
export function occupancy(pressure) {
  if (pressure === null || typeof pressure !== 'object') return null
  const contextWindow = pressure.contextWindow
  // A missing window means no request has been recorded yet (the route capacity
  // is unknown), so there is no honest percentage to compare against.
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
  const usedTokens = pressure.projectedTokens ?? pressure.pressureTokens
  if (typeof usedTokens !== 'number' || !Number.isFinite(usedTokens) || usedTokens < 0) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
    usedTokens,
    contextWindow,
  }
}

/**
 * Build one watcher.
 *
 * @param options.config - the resolved, mutable settings object (read on every
 *   event, so a panel edit applies without remounting).
 * @param options.readOccupancy - `(session) => {percent, usedTokens, contextWindow} | null`.
 * @param options.readTitle - `(session) => string | undefined`.
 * @param options.hasOpenTurn - `(session) => boolean`; true while a turn is still running.
 * @param options.handOff - `(session, armed) => Promise<{sessionId?, title?}>`; creates the
 *   continuation session. Rejected promises are retried at the next turn boundary.
 * @param options.log - informational sink.
 * @param options.warn - warning sink.
 * @param options.store - optional durable counter store (`lib/persist.js`); when absent
 *   every counter is process-local.
 */
export function createWatcher(options) {
  const { config, readOccupancy, readTitle, hasOpenTurn, handOff } = options
  const log = typeof options.log === 'function' ? options.log : NOOP
  const warn = typeof options.warn === 'function' ? options.warn : NOOP
  // Absent in tests and in a Host that offers no storage facility; every call
  // below is guarded so the two paths differ only in where the count lives.
  const store = options.store ?? null

  /**
   * The tool names that count as a compression.
   *
   * Held here and refreshed by {@link refreshTools} so a settings edit that
   * renames the tool takes effect on the next event without a remount. Resolving
   * it lazily also keeps `config` simple for callers that never set it.
   */
  let tools = parseCompressTools(config.compressTools ?? DEFAULT_COMPRESS_TOOLS.join(','))

  /** Re-read the configured tool names (called on a settings change). */
  function refreshTools() {
    tools = parseCompressTools(config.compressTools ?? DEFAULT_COMPRESS_TOOLS.join(','))
  }

  /**
   * Per-session counters. This is the live view of the run; with a `store` it is
   * also written through to durable storage on every mutation, and a session new
   * to this process starts from the stored record. Without one it is a plain
   * live-process cache.
   */
  const states = new Map()

  /** Oldest-first prune; counters are cheap to recompute, so this is safe. */
  function trim() {
    if (states.size <= 512) return
    for (const key of states.keys()) {
      if (states.size <= 384) break
      states.delete(key)
    }
  }

  /**
   * Persist one session's counters.
   *
   * Fire-and-forget by contract: a compression must never fail because a disk
   * write did, and the store already treats an unavailable medium as a no-op.
   */
  function persist(session, state) {
    if (store === null || typeof store.save !== 'function') return
    try {
      store.save(session.id, {
        consecutive: state.consecutive,
        armed: state.armed,
        fired: state.fired,
        seq: typeof session.seq === 'number' ? session.seq : -1,
      })
    } catch (error) {
      // A store that throws synchronously is a programming error in the store,
      // not a reason to stop counting.
      warn(`dsh-auto-relay: 写入会话计数失败 — ${String(error?.message ?? error)}`)
    }
  }

  function stateFor(session) {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return null
    // A subagent's context is a tool result's lifetime, not the user's
    // conversation: handing it off would spawn work nobody asked for.
    if (config.ignoreSubagents) {
      const depth = session.header?.delegationDepth
      if (typeof depth === 'number' && depth > 0) return null
    }
    let state = states.get(id)
    if (state === undefined) {
      state = {
        consecutive: 0, // qualifying compressions since the last break in the run
        pending: null, // the compaction/start observation awaiting its end
        armed: null, // a hand-off earned and waiting for the turn boundary
        fired: false, // this session already handed off once
        relaying: false, // a hand-off is being created right now
      }
      // A stored record from before a restart restores the run, the earned
      // hand-off and the "already relayed" flag — but never a half-finished
      // start marker: `pending` names an observation only this process made.
      if (store !== null && typeof store.hydrate === 'function') {
        let restored
        try {
          restored = store.hydrate(id)
        } catch (error) {
          warn(`dsh-auto-relay: 读取会话计数失败 — ${String(error?.message ?? error)}`)
        }
        if (restored !== undefined && restored !== null) {
          if (typeof restored.consecutive === 'number' && Number.isFinite(restored.consecutive) && restored.consecutive > 0) {
            state.consecutive = Math.trunc(restored.consecutive)
          }
          if (restored.armed !== null && restored.armed !== undefined) state.armed = restored.armed
          state.fired = restored.fired === true
        }
      }
      states.set(id, state)
      trim()
    }
    return state
  }

  /**
   * Create the continuation session.
   *
   * Called only from {@link flush}, which has already cleared `armed`, so a
   * rejection can safely put it back for a retry at the next boundary.
   */
  function relay(session, state, armed) {
    state.relaying = true
    const timestamp = new Date().toISOString()
    let pending
    try {
      pending = handOff(session, armed, readTitle(session))
    } catch (error) {
      // A synchronous throw (a missing service, a malformed title) is the same
      // failure as a rejection; treat it identically.
      pending = Promise.reject(error)
    }
    Promise.resolve(pending).then(
      (created) => {
        state.fired = true
        state.relaying = false
        // Persisted before anything else can fail: the successor session now
        // exists, so a restart must not relay for the same run a second time.
        persist(session, state)
        log(`dsh-auto-relay: ${session.id} 在第 ${armed.count} 次压缩（约 ${armed.percent}%）后开启接力会话 ${created?.sessionId ?? '(未命名)'}${created?.title ? ` “${created.title}”` : ''}`)
        // A run that completed while this hand-off was in flight left its own
        // `armed` behind; without this it would wait for a turn boundary that
        // may never come in an idle session.
        if (state.armed !== null) flush(session, state, { force: false })
      },
      (error) => {
        state.relaying = false
        // Keep the earned hand-off: the next turn boundary tries again instead
        // of silently dropping the run that already reached the limit.
        state.armed = armed
        warn(`dsh-auto-relay: 为 ${session.id} 创建接力会话失败（${timestamp}）— ${String(error?.message ?? error)}`)
      },
    )
  }

  /**
   * Act on an earned hand-off, waiting for the turn to end when one is running.
   *
   * Two sessions editing the same files at once is the failure mode this avoids:
   * a pressure compaction usually happens mid-turn, and the old session keeps
   * working afterwards. So the continuation is created when the turn closes —
   * or straight away when the session is idle (a manual compaction).
   */
  function flush(session, state, { force }) {
    if (state.armed === null || state.relaying) return
    if (config.oncePerSession && state.fired) {
      state.armed = null
      return
    }
    if (!force) {
      let open = false
      try {
        open = hasOpenTurn(session) === true
      } catch {
        // An unavailable turn probe must not block the hand-off; err on firing.
        open = false
      }
      if (open) return
    }
    const armed = state.armed
    state.armed = null
    relay(session, state, armed)
  }

  function onStart(session, state, marker) {
    const measured = readOccupancy(session)
    state.pending = {
      compactionId: marker.id,
      percent: measured === null ? null : measured.percent,
      usedTokens: measured === null ? null : measured.usedTokens,
      contextWindow: measured === null ? null : measured.contextWindow,
      // An unmeasurable compression is never qualifying — but it must not break
      // a run either, so `qualifying: null` means "no evidence", not "below".
      qualifying: measured === null ? null : measured.percent >= config.thresholdPercent,
    }
  }

  function onEnd(session, state, marker) {
    const pending = state.pending
    if (pending === null) return
    // Markers of two different compressions are only confused if a previous
    // start was never closed (a crash mid-summary); matching the id keeps that
    // stall from being credited to the new one. The pending start is kept, so a
    // result that merely looks like a compression — another tool in the same
    // parallel step whose text happens to start the same way — cannot consume
    // the real one before it arrives.
    if (pending.compactionId !== null && marker.id !== null && pending.compactionId !== marker.id) return
    state.pending = null
    // A failed or no-op compression changed nothing: it neither counts nor
    // breaks a run.
    if (marker.failed === true) return
    if (pending.qualifying === null) return
    if (pending.qualifying === false) {
      // A below-threshold compression breaks the run, and that break must be
      // durable too — otherwise a restart would resume a run that no longer
      // describes what the conversation did.
      if (state.consecutive !== 0) {
        state.consecutive = 0
        persist(session, state)
      }
      return
    }
    state.consecutive += 1
    if (state.consecutive < config.consecutiveCount) {
      persist(session, state)
      return
    }
    if (state.armed !== null) {
      // Already waiting for a boundary; the count that earned it is spent, so
      // persist the reset even though nothing else changed.
      persist(session, state)
      return
    }
    state.armed = {
      count: state.consecutive,
      percent: pending.percent,
      usedTokens: pending.usedTokens,
      contextWindow: pending.contextWindow,
      threshold: config.thresholdPercent,
    }
    state.consecutive = 0
    persist(session, state)
    flush(session, state, { force: false })
  }

  return {
    /**
     * Fold one committed session event.
     *
     * Recognises both shapes a compression leaves in the log — DSH's own
     * `compaction/*` markers and a proxy implementation's `compress` tool call —
     * and ignores everything else.
     *
     * @param session - the session the event belongs to.
     * @param event - `{type, seq, time, data}`.
     */
    handleSessionEvent(session, event) {
      if (!config.enabled) return
      const marker = compressionMarker(event, tools)
      if (marker === null) return
      const state = stateFor(session)
      if (state === null) return
      if (marker.phase === 'start') onStart(session, state, marker)
      else onEnd(session, state, marker)
    },

    /**
     * Re-read the configured tool names after a settings change.
     *
     * Separate from {@link reset} because a rename need not discard counters: an
     * edit to the tool list only changes what future events are recognised as.
     */
    refreshTools,

    /**
     * A turn is closing: this is the moment a deferred hand-off may proceed.
     *
     * @param session - the session whose turn is about to end.
     */
    handleTurnStopping(session) {
      if (!config.enabled) return
      // `stateFor`, not `states.get`: after a restart the only trace of a
      // session can be its stored record — an armed hand-off that the previous
      // process earned but never released. Building the state here is what
      // hydrates it, so the boundary can still fire.
      const state = stateFor(session)
      if (state === null) return
      flush(session, state, { force: true })
    },

    /** Forget everything known about one session (used by tests and a reset). */
    reset(sessionId) {
      if (typeof sessionId !== 'string') {
        states.clear()
        return
      }
      states.delete(sessionId)
      if (store !== null && typeof store.forget === 'function') {
        try {
          store.forget(sessionId)
        } catch (error) {
          warn(`dsh-auto-relay: 清除会话计数失败 — ${String(error?.message ?? error)}`)
        }
      }
    },

    /**
     * Adopt durable counters that arrived after this process started folding.
     *
     * A medium is read asynchronously, so a compression can be folded before the
     * stored count is in memory. Everything folded here happened AFTER the
     * previous process wrote its record, so the two contributions cover disjoint
     * stretches of the conversation and add up; they never overlap. That is why
     * the merge is an addition rather than a replacement — replacing would
     * discard the compressions this process just observed, and ignoring would
     * discard the ones before the restart, which is the whole point of the
     * switch.
     *
     * `armed` and `fired` only move forward: a stored hand-off is adopted only
     * when this process has not already relayed and has not itself earned one.
     *
     * @param entries - `[[sessionId, counter], ...]` from the store.
     */
    restore(entries) {
      if (Array.isArray(entries) === false) return
      for (const pair of entries) {
        if (Array.isArray(pair) === false) continue
        const [id, stored] = pair
        if (typeof id !== 'string' || stored === null || typeof stored !== 'object') continue
        const state = states.get(id)
        if (state === undefined) continue // never folded here: stateFor will hydrate it
        const extra = typeof stored.consecutive === 'number' && Number.isFinite(stored.consecutive) && stored.consecutive > 0
          ? Math.trunc(stored.consecutive)
          : 0
        if (extra > 0) state.consecutive = Math.min(1000, state.consecutive + extra)
        if (state.armed === null && state.fired === false && stored.armed !== null && stored.armed !== undefined) {
          state.armed = stored.armed
        }
        if (stored.fired === true) state.fired = true
      }
    },

    /** Read-only view of the counters, for diagnostics. */
    inspect(sessionId) {
      const state = states.get(sessionId)
      if (state === undefined) return undefined
      return {
        consecutive: state.consecutive,
        armed: state.armed === null ? null : { ...state.armed },
        fired: state.fired,
        relaying: state.relaying,
      }
    },
  }
}
