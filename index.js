// dsh-auto-relay — hand a long-running task to a fresh session.
//
// A context compression is a symptom: the conversation has grown past what one
// route can carry. Five compressions in a row, each happening while the context
// was already half full, means the work is grinding rather than progressing, and
// every further step costs more and remembers less. This plugin watches those
// moments and, once a configurable number of them happen consecutively above a
// configurable occupancy, opens a new session titled after the current one and
// hands it the unfinished task.
//
// Why the occupancy is read at `compaction/start` and the count moves at
// `compaction/end`:
//
//   * `start` is the last moment the meter still shows the PRE-compaction prompt
//     size. By `end` the surface already holds the summary, so the meter reads
//     small and every compression would look harmless.
//   * counting at `end` keeps a failed compaction (its `end` carries `error`)
//     out of the run while also not breaking it.
//
// Why the hand-off waits for the turn to close:
//
// A pressure compaction happens mid-turn, and the old session keeps working
// afterwards. Creating the continuation immediately would have two sessions
// editing the same files. So the hand-off is armed when the run completes and
// released at `agent/turn-stopping`, or straight away when the session is idle
// (a manual compaction).
//
// The continuation is created through the `schedule` service's `new_once`
// target: it reserves the new Session identity, names it from the task title,
// and delivers the prompt as the first message. That floor is 60 s, not the
// hour-long interval reserved for `target.kind: 'new'`, so a relay can chain.
//
// Counters are process-local unless `persistCounter` is on, in which case they
// are written through the `storageDomain` facility (see `lib/persist.js`) so a
// restart resumes the run instead of restarting it.

import { pickSchemaBuilder } from './lib/schema.js'
import { DEFAULTS, LIMITS, resolveConfig, renderPrompt } from './lib/config.js'
import { withMarker } from './lib/marker.js'
import { createStore } from './lib/persist.js'
import { nextTitle } from './lib/title.js'
import { createWatcher, occupancy } from './lib/watch.js'

export const name = 'dsh-auto-relay'

/**
 * `sessions` and `agents` are the two services this plugin cannot work without:
 * the first owns the append feed the watcher folds, the second knows whether a
 * turn is still open. Declaring them here makes the loader mount the plugin only
 * once both exist, so `apply` never has to poll for them or fail on a cold start.
 *
 * `schedule`, `sessionTitle`, `tokenMeter`, `sessionProjections` and
 * `storageDomain` are read optionally through `ctx.get(...)`: a deployment may
 * legitimately run without any of them, and the plugin degrades (no hand-off, no
 * title increment, a less precise reading, an in-memory-only count) instead of
 * refusing to mount.
 */
export const inject = ['sessions', 'agents']

// The schema is what gives this plugin a settings surface at all: the platform
// projects the config of every entry that declares one, and the panel reads and
// writes that projection. It needs `@deepseek-ai/schemastery`, which a real DSH
// profile supplies (declared as an optional peer dependency here) but which is
// absent when this module is imported standalone, as `test/smoke.mjs` does. A
// soft import keeps the plugin loadable there: without a schema the plugin runs
// on its defaults and only the panel is missing.
let Schema = null
try {
  Schema = pickSchemaBuilder(await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}
if (Schema === null) {
  // Not fatal — the plugin works on defaults — but it is exactly the difference
  // between a panel with switches and one without, so say so instead of failing
  // quietly.
  console.warn(
    'dsh-auto-relay: no schema builder (@deepseek-ai/schemastery) — the plugin runs on its ' +
    'defaults and the settings panel will not offer the switches',
  )
}

/**
 * The plugin's own configuration, with the tolerance around building it.
 *
 * Every field is ALSO settable by hand in a profile patch (`- id: dsh-auto-relay`
 * / `config:`) and by the environment, and `lib/config.js` documents the
 * precedence: this configuration wins, the environment is the deployment
 * default, the built-in defaults are last.
 *
 * EVERY field is `.volatile()`, and that is not decoration: DSH's settings
 * service projects a plugin's config into a form only through `volatileForm()`,
 * which keeps a field only when its nearest ancestor is marked volatile — a
 * schema without one contributes no form at all, so the entry never reaches the
 * settings projection and the panel waits for a scope that will never arrive.
 *
 * A volatile field must not sit inside another volatile one, so the schema is
 * one flat object with volatile leaves.
 */
export function buildConfig(Schema) {
  if (Schema === null || Schema === undefined) return undefined
  try {
    return defineConfig(Schema)
  } catch (error) {
    // A builder that is present but is not the one this plugin expects (an
    // incompatible `@deepseek-ai/schemastery` in the profile) must not decide
    // whether the plugin exists: it degrades to "no panel", not to "no plugin".
    console.warn(
      'dsh-auto-relay: building the Config schema failed — the plugin runs on its defaults ' +
      'and the settings panel will not offer the switches',
      error,
    )
    return undefined
  }
}

/** The schema itself, in one place; the builder is supplied by {@link buildConfig}. */
function defineConfig(Schema) {
  const { thresholdPercent, consecutiveCount, delaySeconds } = LIMITS
  return Schema.object({
    enabled: Schema.boolean()
      .default(DEFAULTS.enabled)
      .description('启用自动接力。关闭后本插件不读取也不创建任何会话。')
      .volatile(),
    thresholdPercent: Schema.number()
      .default(DEFAULTS.thresholdPercent)
      .description(
        `计入连续次数的占用百分比（${thresholdPercent.min}–${thresholdPercent.max}）。` +
        '压缩发生时的上下文占比达到该值才计一次，百分比与对话界面右上角的占用指示一致。',
      )
      .volatile(),
    consecutiveCount: Schema.number()
      .default(DEFAULTS.consecutiveCount)
      .description(
        `连续多少次达标压缩后开启接力会话（${consecutiveCount.min}–${consecutiveCount.max}）。` +
        '中间出现一次低于阈值的压缩即重新计数。',
      )
      .volatile(),
    incrementTitle: Schema.boolean()
      .default(DEFAULTS.incrementTitle)
      .description(
        '新会话标题沿用当前标题的序号并加一；标题不含序号时从 1 开始编号' +
        '（如 test-3 → test-4、test → test-1）。关闭后使用下方的默认标题。',
      )
      .volatile(),
    separator: Schema.string()
      .default(DEFAULTS.separator)
      .description(
        '标题中序号前的连接符，默认为短横线。既用于识别已有序号，也用于给不含序号的标题追加序号 1' +
        '（如连接符设为 _ 时 test → test_1）。留空表示不编号，仅沿用原标题。',
      )
      .volatile(),
    delaySeconds: Schema.number()
      .default(DEFAULTS.delaySeconds)
      .description(`接力任务的投递延时秒数（${delaySeconds.min}–${delaySeconds.max}），留出收尾时间。`)
      .volatile(),
    defaultTitle: Schema.string()
      .default(DEFAULTS.defaultTitle)
      .description('当前会话没有标题（或关闭标题递增）时，新会话使用的标题。')
      .volatile(),
    promptTemplate: Schema.string()
      .default(DEFAULTS.promptTemplate)
      .description(
        '投递给接力会话的提示词。原样保留换行；可用占位符：' +
        '{sessionId}、{count}、{percent}、{threshold}、{title}。',
      )
      .volatile(),
    ignoreSubagents: Schema.boolean()
      .default(DEFAULTS.ignoreSubagents)
      .description('忽略子智能体会话：子代理的上下文随任务结束，不需要接力。')
      .volatile(),
    oncePerSession: Schema.boolean()
      .default(DEFAULTS.oncePerSession)
      .description('每个会话最多触发一次接力，避免链式会话反复接力。')
      .volatile(),
    persistCounter: Schema.boolean()
      .default(DEFAULTS.persistCounter)
      .description(
        '把压缩计数保存到磁盘，重启后继续累计。关闭时计数只存在于本次运行中，' +
        '重启会从零开始——若担心长时间会话在重启后因计数丢失而撑爆上下文，请开启此项。',
      )
      .volatile(),
    switchToRelay: Schema.boolean()
      .default(DEFAULTS.switchToRelay)
      .description(
        '接力会话开始后，把对话界面自动切换到新会话。关闭时新会话在侧边栏静默开始，由你手动切换。',
      )
      .volatile(),
    archiveOldSession: Schema.boolean()
      .default(DEFAULTS.archiveOldSession)
      .description(
        '切换到接力会话后，把交出任务的旧会话归档，保持会话列表清爽（归档的会话可在侧边栏恢复）。' +
        '需要上面一项开启；仅开启本项时界面仍会先切到新会话，因为归档当前会话会清空对话区。',
      )
      .volatile(),
    compressTools: Schema.string()
      .default(DEFAULTS.compressTools)
      .description(
        '把压缩实现为模型工具调用的 profile（如 billion-context）中，哪些工具名算作一次压缩。' +
        '逗号或空格分隔；DSH 自带的 compaction 事件始终被识别，无需在此列出。',
      )
      .volatile(),
  }).description('dsh-auto-relay：连续在上下文高占用时触发压缩后，自动开启新会话接力未完成的任务。')
}

/** The plugin's config, or `undefined` when no usable builder is available. */
export const Config = buildConfig(Schema)

/** The one projection key this plugin reads, allocated once. */
const PRESSURE_KEYS = new Set(['contextPressure'])

/**
 * Mount the plugin for one configuration.
 *
 * @param ctx - the plugin context (cordis).
 * @param settings - the row's raw configuration, already validated by `Config`.
 */
export function apply(ctx, settings = {}) {
  // Resolved once per mount into an object that is MUTATED IN PLACE by the live
  // update hook below. The watcher reads it on every event, so a settings edit
  // reaches the very next compression with no remount.
  const config = resolveConfig(settings)
  // A disabled mount still registers its listeners: the watcher no-ops while
  // `enabled` is false, and the volatile hook below can flip it back on without
  // a remount. Returning early here would make the switch one-way only.

  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }
  const log = (message) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(message)
    else console.log(message)
  }

  /**
   * The occupancy the conversation meter would show for this session right now.
   *
   * Reading the `contextPressure` projection is what makes the plugin agree with
   * the UI: `tokenMeter.contextPressure()` exposes only the raw sample, while the
   * projection's view also carries `projectedTokens` (the sample plus surface
   * movement since), and `projectedTokens ?? pressureTokens` is exactly the
   * formula the ring uses.
   *
   * The projection is read only if it is a registered CLIENT-VISIBLE unit —
   * `snapshot` skips units without a `wire` face, so a Host that pruned it yields
   * no value and the meter fallback answers instead.
   */
  function readOccupancy(session) {
    const projections = ctx.get?.('sessionProjections')
    if (projections !== undefined && typeof projections.snapshot === 'function') {
      try {
        const snapshot = projections.snapshot(session, PRESSURE_KEYS)
        const pressure = snapshot?.values?.contextPressure
        if (pressure !== undefined) {
          const measured = occupancy(pressure)
          if (measured !== null) return measured
        }
      } catch (error) {
        // A projection that cannot fold this session (a log with a gap, a unit
        // registered by a different build) must not stop the count: fall through
        // to the meter, which has its own copy of the same two numbers.
        warnOnce(`dsh-auto-relay: 读取上下文占用投影失败 — ${String(error?.message ?? error)}`)
      }
    }
    const meter = ctx.get?.('tokenMeter')
    if (meter !== undefined && typeof meter.contextPressure === 'function') {
      try {
        return occupancy(meter.contextPressure(session))
      } catch (error) {
        warnOnce(`dsh-auto-relay: 读取上下文占用失败 — ${String(error?.message ?? error)}`)
      }
    }
    return null
  }

  const reported = new Set()
  function warnOnce(message) {
    if (reported.has(message)) return
    reported.add(message)
    warn(message)
  }

  /** The current title, or undefined when no title service or no title exists. */
  function readTitle(session) {
    const titles = ctx.get?.('sessionTitle')
    if (titles === undefined || typeof titles.get !== 'function') return undefined
    try {
      const snapshot = titles.get(session)
      return typeof snapshot?.title === 'string' && snapshot.title.trim() !== '' ? snapshot.title : undefined
    } catch (error) {
      warnOnce(`dsh-auto-relay: 读取会话标题失败 — ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /**
   * Whether a turn is still open on this session.
   *
   * A throwing or unavailable check answers `false`: the watchdog treats "no
   * evidence of an open turn" as permission to fire, because a missed hand-off
   * costs the user another full run while a slightly early one only starts a
   * session that waits for its first prompt.
   */
  function hasOpenTurn(session) {
    const agents = ctx.get?.('agents')
    if (agents === undefined || typeof agents.turnBoundaryOf !== 'function') return false
    const boundary = agents.turnBoundaryOf(session)
    return boundary?.openTurnStartSeq !== null && boundary?.openTurnStartSeq !== undefined
  }

  /**
   * Create the continuation session and return its identity.
   *
   * `new_once` reserves the Session id at creation and creates the Session on
   * delivery; the task's own `title` becomes the new session's title, so the
   * computed title is passed here rather than renamed afterwards.
   *
   * The prompt also carries the browser half's instructions (see `lib/marker.js`):
   * whether to show the relay session, whether to archive this one. The Host can
   * decide those but cannot perform them — moving the visible conversation is a
   * client-only capability — so the switches travel on the one field both halves
   * share.
   */
  async function handOff(session, armed, currentTitle) {
    const schedule = ctx.get?.('schedule')
    if (schedule === undefined || typeof schedule.create !== 'function') {
      throw new Error('schedule 服务不可用，无法创建接力会话')
    }
    const title = nextTitle(
      config.incrementTitle ? currentTitle : undefined,
      config.separator,
      config.defaultTitle,
    )
    // `archive` implies `open` inside `relayMarker`: archiving the conversation on
    // screen would blank it, so the successor has to be shown first.
    const prompt = withMarker(renderPrompt(config.promptTemplate, {
      sessionId: session.id,
      count: armed.count,
      percent: armed.percent,
      threshold: armed.threshold,
      title: title.title,
    }), {
      from: session.id,
      open: config.switchToRelay,
      archive: config.archiveOldSession,
    })
    const header = session.header ?? {}
    const create = {}
    // The continuation must start where the work is, not in the process's cwd.
    if (typeof header.cwd === 'string' && header.cwd !== '') create.cwd = header.cwd
    if (typeof header.agentPreset === 'string' && header.agentPreset !== '') create.agentPreset = header.agentPreset
    const entry = await schedule.create({
      title: title.title,
      prompt,
      timing: { kind: 'after', after_seconds: config.delaySeconds },
      target: { kind: 'new_once', create },
    })
    return { sessionId: entry?.target?.sessionId, title: entry?.record?.title ?? title.title }
  }

  /**
   * The durable counter store, when the user asked for one.
   *
   * `enabled` is passed as a FUNCTION rather than a value so toggling
   * `persistCounter` in the panel takes effect on the next write without
   * remounting: turning it off stops writing immediately (and leaves whatever is
   * already stored alone), turning it on starts persisting from the next
   * compression.
   *
   * It is created unconditionally — the store itself decides whether a medium is
   * available — because the counter it restores is what makes a restart safe,
   * and that has to be in place before the first event is folded.
   */
  /**
   * Restored counters that arrived before the watcher existed.
   *
   * The medium is read asynchronously, so the restore callback can fire before
   * the watcher is constructed (a fast local backend) or after (the usual case).
   * Buffering the first result and draining it once the watcher exists keeps both
   * orders correct without a temporal-dead-zone hazard.
   */
  let watcher = null
  let deferredRestore = null

  const store = createStore({
    ctx,
    enabled: () => config.persistCounter,
    warn: warnOnce,
    log,
    // Events can be folded before the medium is read; adopt what it held so the
    // run resumes instead of restarting.
    onRestore: (entries) => {
      if (watcher === null) deferredRestore = entries
      else watcher.restore(entries)
    },
  })

  watcher = createWatcher({
    config,
    readOccupancy,
    readTitle,
    hasOpenTurn,
    handOff,
    log,
    warn,
    store,
  })

  // A backend that answered while `apply` was still wiring the watcher left its
  // counters in the buffer; hand them over now.
  if (deferredRestore !== null) {
    watcher.restore(deferredRestore)
    deferredRestore = null
  }

  // `session/event` is the post-commit append feed: every committed event of
  // every session this profile runs arrives here, so the counter never depends
  // on the conversation being in the foreground.
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        watcher.handleSessionEvent(session, event)
      } catch (error) {
        // An observer that throws is contained by the platform, but the same
        // error would repeat for every later event; log it once and keep going.
        warnOnce(`dsh-auto-relay: 处理会话事件失败 — ${String(error?.message ?? error)}`)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-auto-relay: compaction watch')

  // `agent/turn-stopping` is the last point before the boundary commits: the
  // model owes no response and no tool call is live, so this is when a deferred
  // hand-off may safely start the successor session.
  ctx.effect(() => {
    const dispose = ctx.on('agent/turn-stopping', (payload) => {
      const session = payload?.agent?.session ?? payload?.session
      if (session === undefined) return
      try {
        watcher.handleTurnStopping(session)
      } catch (error) {
        warnOnce(`dsh-auto-relay: 处理回合结束事件失败 — ${String(error?.message ?? error)}`)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-auto-relay: turn boundary')

  // The store owns a domain handle; the facility's contract is that the caller
  // closes it. Registered even when persistence was never requested, so the
  // lifecycle has one shape — `dispose` is idempotent and a no-op without a
  // domain.
  ctx.effect(() => () => {
    void store.dispose()
  }, 'dsh-auto-relay: counter store')

  // A volatile edit is written into the SAME settings object the loader handed
  // this mount, then announced. Re-resolving in place is what makes a change
  // made in the panel take effect without restarting the app.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        Object.assign(config, resolveConfig(settings))
        if (!config.enabled) {
          // Disabling mid-run must also drop anything already armed, or the next
          // turn boundary would relay on behalf of a plugin the user switched off.
          watcher.reset()
        } else {
          // Re-read the tool names: a rename takes effect on the next event, and
          // the counters a still-enabled watcher holds stay valid.
          watcher.refreshTools()
        }
      } catch (error) {
        warn(`dsh-auto-relay: 应用实时设置变更失败 — ${String(error?.message ?? error)}`)
      }
    })
  }

  // Exported for tests and for a caller that wants the pieces without mounting.
  return watcher
}

// Exported for tests and for a caller that wants the pieces without mounting.
export { occupancy, createWatcher, nextTitle, resolveConfig, renderPrompt, DEFAULTS }
