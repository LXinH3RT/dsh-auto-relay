// Durable home for the watchdog's per-session counters.
//
// Without this, the count lives only in the running process: quit the app (or
// crash mid-turn) and a session that had already compressed four times at high
// occupancy starts again from zero — so the fifth compression that would have
// earned a hand-off arrives after the context is already past the limit.
//
// The medium is the Host's own storage facility (`ctx.storageDomain`), which is
// what `dsh-schedule` and every other persistent plugin uses. It is reached
// through `ctx.get('storageDomain')` rather than imported: a linked bundle
// resolves modules from its own directory, where no `@deepseek-ai/*` package
// exists, so an import would fail at load.
//
// The facility only ever calls `valueSchema.parse(raw)` on a stored record
// (`defineDomain`/`domainTable` are identity helpers, and neither is needed
// here), so a plain object with a `parse` method is a complete schema. That
// avoids depending on zod, which is not resolvable from a linked bundle either.
//
// Deliberate contract: `parse` NEVER throws. A record this build cannot read
// (an older layout, a hand-edited file) must degrade to "no counter" — the
// conservative direction — instead of failing the domain open and taking the
// whole feature down with it.

/** Domain name; must match the facility's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`). */
const DOMAIN_NAME = 'auto_relay'

/** Bump only when the stored shape changes incompatibly. */
const DOMAIN_VERSION = 1

/** The one table: key is the session id, value is one counter record. */
const TABLE_NAME = 'counters'

/**
 * Records older than this are dropped when the domain opens. A counter for a
 * conversation nobody has touched in a month can never be useful again, and
 * without pruning the table grows with every session the profile ever runs.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** The shape a missing or unreadable record collapses to. */
function emptyCounter() {
  return { consecutive: 0, armed: null, fired: false, seq: -1, updatedAt: 0 }
}

/**
 * Coerce one stored record into a counter.
 *
 * Every field is optional on read: a record written by a future build that adds
 * a field must still yield a usable counter here.
 *
 * @param raw - the stored value (anything).
 * @returns a complete, well-typed counter record.
 */
export function normalizeCounter(raw) {
  const empty = emptyCounter()
  if (raw === null || typeof raw !== 'object') return empty

  const consecutive = raw.consecutive
  const counter =
    typeof consecutive === 'number' && Number.isFinite(consecutive) && consecutive >= 0
      ? Math.trunc(consecutive)
      : 0

  // An armed hand-off is worth restoring only if it still carries the numbers
  // the prompt needs; a partial record would render "约 null%".
  let armed = null
  const stored = raw.armed
  if (stored !== null && typeof stored === 'object') {
    const { count, percent, usedTokens, contextWindow, threshold } = stored
    const usable =
      typeof count === 'number' && Number.isFinite(count) && count > 0
      && typeof percent === 'number' && Number.isFinite(percent)
      && typeof usedTokens === 'number' && Number.isFinite(usedTokens)
      && typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
    if (usable) {
      armed = {
        count: Math.trunc(count),
        percent,
        usedTokens,
        contextWindow,
        threshold: typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0,
      }
    }
  }

  const seq = raw.seq
  const updatedAt = raw.updatedAt
  return {
    consecutive: counter,
    armed,
    fired: raw.fired === true,
    seq: typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : -1,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
  }
}

/**
 * The schema object handed to the storage facility.
 *
 * Only `parse` is ever called, and it is total: malformed input becomes the
 * empty counter rather than an `invalid-record` failure that would refuse the
 * domain open.
 */
const counterSchema = { parse: normalizeCounter }

/**
 * Build the store.
 *
 * The returned `ready` promise always RESOLVES — never rejects — so callers can
 * gate event handling on it without adding a failure path of their own. When
 * persistence is unavailable the store simply reports `persistent: false` and
 * every `save` becomes a no-op.
 *
 * @param options.ctx - plugin context (for `get('storageDomain')` and `inject`).
 * @param options.enabled - read on each save, so a settings edit applies live.
 * @param options.warn - warning sink (called once per distinct problem).
 * @param options.log - informational sink.
 * @param options.now - clock, injectable for tests.
 * @param options.maxAgeMs - prune horizon for restored records.
 * @param options.onRestore - called once after stored records are in memory, so
 *   a consumer that already folded events can adopt them.
 * @returns `{ready, hydrate, save, forget, dispose, persistent}`.
 */
export function createStore(options = {}) {
  const { ctx, warn, log, now = Date.now, maxAgeMs = MAX_AGE_MS } = options
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true
  const warnSink = typeof warn === 'function' ? warn : () => {}
  const logSink = typeof log === 'function' ? log : () => {}
  const onRestore = typeof options.onRestore === 'function' ? options.onRestore : null

  /** Restored counters, keyed by session id; also kept current on every save. */
  const counters = new Map()

  let domain = null
  let table = null
  let unavailable = false
  let disposed = false
  let settled = false
  let loaded = false
  let resolveReady
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })

  const warned = new Set()
  function warnOnce(message) {
    if (warned.has(message)) return
    warned.add(message)
    warnSink(message)
  }

  function settle() {
    if (settled) return
    settled = true
    resolveReady()
  }

  /**
   * Open the domain and load every stored record.
   *
   * Awaited by `ready`; `settle()` runs on every path, so a missing service, a
   * backend without a kv facet, or a corrupt medium all leave the watchdog
   * working in memory instead of hanging the first event forever.
   */
  async function open(service) {
    if (disposed) return settle()
    if (service === undefined || service === null || typeof service.open !== 'function') {
      unavailable = true
      // Not reported here: durability is opt-in, and a Host without the storage
      // facility is the ordinary case while the switch is off. The warning is
      // raised by the first save that actually wanted the disk.
      return settle()
    }
    try {
      const opened = await service.open({
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        // One record per session: a counter is read and written independently,
        // so a per-record medium keeps a single write from rewriting the table.
        layout: 'per-record',
        tables: { [TABLE_NAME]: { valueSchema: counterSchema } },
      })
      if (disposed) {
        await opened.close()
        return settle()
      }
      // Everything that was stored is in memory before `loaded` flips, so a
      // listener woken by `ready` sees the complete restored set.
      counters.clear()
      domain = opened
      table = opened.table(TABLE_NAME)
      const cutoff = now() - maxAgeMs
      let pruned = 0
      for (const [key, value] of table.entries()) {
        if (value.updatedAt > 0 && value.updatedAt < cutoff) {
          counters.delete(key)
          pruned += 1
          // Pruning is housekeeping: a failed delete must not block hydration.
          void Promise.resolve(table.delete(key)).catch(() => {})
          continue
        }
        counters.set(key, value)
      }
      settle()
      loaded = true
      // Hand the restored records to whoever folded events before the medium was
      // ready: their in-memory counters were built from zero and are now stale.
      if (onRestore !== null) {
        try {
          onRestore(Array.from(counters.entries()))
        } catch (error) {
          warnOnce(`dsh-auto-relay: 应用已保存的计数失败 — ${String(error?.message ?? error)}`)
        }
      }
      if (counters.size > 0) {
        logSink(`dsh-auto-relay: 已恢复 ${counters.size} 个会话的压缩计数${pruned > 0 ? `，清理过期记录 ${pruned} 条` : ''}`)
      }
    } catch (error) {
      unavailable = true
      warnOnce(`dsh-auto-relay: 打开计数存储失败，计数只保存在本次运行中 — ${String(error?.message ?? error)}`)
      settle()
    }
  }

  // Prefer the reactive form: it waits for the service instead of racing the
  // boot order. `get` is the synchronous fallback for a stripped-down context.
  const service = ctx?.get?.('storageDomain')
  if (service !== undefined) {
    void open(service)
  } else if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['storageDomain'], (scoped) => {
        void open(scoped?.get?.('storageDomain') ?? scoped?.storageDomain)
      })
    } catch (error) {
      warnOnce(`dsh-auto-relay: 订阅 storageDomain 失败 — ${String(error?.message ?? error)}`)
      settle()
    }
  } else {
    // No reactive subscribe available: report the same degradation the other
    // paths report, rather than failing silently.
    void open(undefined)
  }

  /**
   * The counter restored for one session, or undefined when it has none.
   *
   * Synchronous on purpose: the watchdog asks for it while folding an event, and
   * an async answer would let the fold run against zero first and then be
   * overwritten by the restored count.
   */
  function hydrate(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    return counters.get(sessionId)
  }

  /**
   * Persist one session's counter.
   *
   * Fire-and-forget: the compression itself must never wait on (or fail with)
   * a disk write. Writes are queued by the domain, so two saves of one session
   * land in call order and the newest wins.
   */
  function save(sessionId, snapshot) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const value = {
      consecutive: snapshot?.consecutive ?? 0,
      armed: snapshot?.armed ?? null,
      fired: snapshot?.fired === true,
      seq: snapshot?.seq ?? -1,
      updatedAt: now(),
    }
    // Always mirrored in memory, so the counter survives being read back even
    // when nothing durable is in play.
    counters.set(sessionId, normalizeCounter(value))
    if (!enabled()) return
    if (unavailable || disposed || table === null) {
      // Still opening: the record is safe in memory and `restore()` merges it
      // once the medium answers, so there is nothing to report yet.
      if (!settled && !unavailable) return
      // The switch is on but nothing can be written: say so once, at the moment
      // it starts mattering.
      warnOnce('dsh-auto-relay: 计数存储不可用，计数只保存在本次运行中（重启后归零）')
      return
    }
    void Promise.resolve(table.put(sessionId, value)).catch((error) => {
      warnOnce(`dsh-auto-relay: 保存会话计数失败 — ${String(error?.message ?? error)}`)
    })
  }

  /** Drop one session's record (used when a run is reset deliberately). */
  function forget(sessionId) {
    if (typeof sessionId !== 'string') {
      counters.clear()
      return
    }
    counters.delete(sessionId)
    if (table === null || unavailable) return
    void Promise.resolve(table.delete(sessionId)).catch(() => {})
  }

  /** Close the domain the facility handed us; the caller owns this lifecycle. */
  async function dispose() {
    if (disposed) return
    disposed = true
    settle()
    const closing = domain
    domain = null
    table = null
    if (closing === null) return
    try {
      await closing.close()
    } catch (error) {
      warnOnce(`dsh-auto-relay: 关闭计数存储失败 — ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Every restored counter, as `[sessionId, counter]` pairs.
   *
   * Exposed so a consumer that folded events before the medium was ready can
   * merge the durable record into its live state instead of silently starting
   * from zero (see the `onRestore` option).
   */
  function restored() {
    return Array.from(counters.entries())
  }

  return {
    ready,
    hydrate,
    restored,
    save,
    forget,
    dispose,
    /** Whether a durable medium is in play (false keeps counters in memory). */
    get persistent() {
      return !unavailable && table !== null
    },
  }
}
