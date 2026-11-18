// Resolved settings for one mounted plugin instance.
//
// Everything tunable is resolved from three layers, most specific first:
//
//   1. the plugin's own configuration — the switches in the settings panel
//      (a host `Config` schema; see index.js), stored in the profile patch;
//   2. the environment, for a headless deployment that tunes an install with no
//      UI at all;
//   3. the built-in defaults below.
//
// A layer only speaks when it actually says something: an unset switch or an
// empty string falls THROUGH to the layer beneath instead of pinning a default
// over it. An unparsable number falls back rather than failing the mount,
// because one bad environment variable must not take the watchdog down.

export const DEFAULTS = {
  /** Whether the watchdog runs at all. */
  enabled: true,
  /**
   * The occupancy percentage a compression must reach to count as part of a
   * consecutive run. The percentage is the one the conversation meter shows:
   * the prompt the next request would send, over the route's context window.
   */
  thresholdPercent: 50,
  /** How many such compressions in a row trigger the hand-off. */
  consecutiveCount: 5,
  /** Whether the new session's title continues or starts the current title's number series. */
  incrementTitle: true,
  /**
   * The separator between the title's stem and its trailing number, e.g. `-`
   * for `test-3`. It is also appended (with `1`) when a title has no number yet:
   * `test` → `test-1`. Empty disables numbering without disabling the hand-off.
   */
  separator: '-',
  /** Seconds between creating the task and delivering it (the floor is 1). */
  delaySeconds: 1,
  /** Title used when the current session has no title at all. */
  defaultTitle: '自动接力',
  /**
   * Prompt delivered to the continuation session. See `renderPrompt`.
   *
   * The default leans on whatever the client already put at the top of the
   * conversation — the session-continuity pointer names the predecessor and
   * quotes its ending — instead of sending the model off to re-read that
   * session. Rebuilding context from the log is the expensive path: on this
   * machine a hand-off cost eight to twelve extra tool calls hunting for the
   * session file, and the read tools it was told to use are not installed in
   * every profile. Looking at the opening pointer first costs nothing and is
   * correct even where no other plugin is present.
   */
  promptTemplate: [
    '上一会话 {sessionId} 连续第 {count} 次在上下文占用约 {percent}%（阈值 {threshold}%）时触发压缩，已自动开启本会话接力。',
    '请继续完成上一会话中尚未完成的任务。',
    '',
    '步骤：',
    '1. 先看本会话开头那段接续说明（通常以「（背景，与当前请求无关就忽略）」或「[background」开头），它已经写明上一会话是哪一场，并附了那个会话的结尾或摘要片段；',
    '2. 开头没有这段说明时，先看工作区当前的状态（未提交的改动、正在改的文件、任务清单），据此定位上一会话停在哪一步；',
    '3. 沿用原任务的目标、约束与已完成的内容继续推进，不要从头重做已完成的部分；',
    '4. 前两步仍不足以判断时，向用户确认要接着做的那一件事，不要凭猜测扩大范围；',
    '5. 如果上一会话中的任务已经完成，直接说明完成情况即可。',
  ].join('\n'),
  /**
   * Whether sessions owned by a subagent are watched at all.
   */
  ignoreSubagents: true,
  /** Whether one session may trigger at most one hand-off. */
  oncePerSession: true,
  /**
   * Whether the counters survive a restart.
   *
   * Off by default: the plain behaviour keeps every counter in the running
   * process, which costs nothing on disk and cannot surprise anyone with a
   * hand-off inherited from a previous launch. Turning it on trades that for
   * protection against the real failure — a restart in the middle of a run
   * resets the count to zero, and the session then needs a full round of
   * high-occupancy compressions again before the hand-off, which is exactly when
   * the context may overshoot the limit and the conversation dies.
   */
  persistCounter: false,
  /**
   * Whether the browser interface follows the hand-off: the new session is shown
   * as soon as its first message is delivered.
   *
   * The Host decides the hand-off but cannot move the visible conversation — only
   * the browser holds that selection — so this switch is carried to the client on
   * the delivered prompt (see `lib/marker.js`) and acted on there. Off means the
   * relay session starts quietly in the sidebar and the user switches by hand.
   */
  switchToRelay: true,
  /**
   * Whether the session that handed off is archived once the relay session opens.
   *
   * Archiving keeps a long relay chain out of the way, and an archived session can
   * be restored from the sidebar. It is only safe together with `switchToRelay`:
   * archiving the conversation that is on screen blanks the pane, so the client
   * opens the successor first and the Host asks for `open` whenever `archive` is
   * set.
   */
  archiveOldSession: true,
  /**
   * Which tool names count as a compression when the profile implements
   * compression as a model-driven tool call instead of DSH's own
   * `compaction/*` events (billion-context is the common case). Comma- or
   * space-separated; an MCP-prefixed spelling is listed separately because the
   * Host exposes the same tool under both names depending on the dialect.
   */
  compressTools: 'compress,mcp__bili__compress',
  /**
   * Whether queued input travels with the hand-off.
   *
   * A user can type while the agent works; DSH holds that input in the session's
   * own durable inbox. Without this the successor was told only "continue the
   * task" and the queue either died with the archived session (the default) or
   * — worse — kept running in the old one. With it, whatever is still waiting is
   * transcribed into the delivered prompt, bounded, and then removed from the
   * old queue once the successor has been reserved.
   */
  carryQueue: true,
  /** How much queued text may travel, in characters (`0` = do not bound). */
  maxQueueChars: 6000,
  /** How many queued messages may travel. */
  maxQueueItems: 20,
  /**
   * Whether the hand-off first asks the LLM registry whether the continuation's
   * model resolves.
   *
   * On this machine a relay session was created successfully and then died on its
   * very first model call (`UNKNOWN_MODEL`) while the profile's default model
   * pointed at a name its provider no longer advertised. Asking first costs one
   * cheap lookup and turns that into a skipped hand-off with a warning.
   */
  checkRelayModel: true,
  /**
   * Seconds to wait for the successor to show any sign of running before it is
   * reported as silent. Silence is only reported, never treated as failure.
   */
  relayTimeoutSeconds: 120,
  /**
   * Provider pinned on the continuation session, or blank to inherit the one the
   * handing-off session is running on.
   *
   * A scheduled `new_once` target carries only `{cwd, agentPreset}`, so the
   * successor would otherwise be created against the profile's default model —
   * a machine-wide setting the predecessor's picker selection never touches, and
   * the exact path by which a relay session was once created against a model its
   * provider no longer advertised. Inheriting the running route keeps the
   * continuation on the model that was doing the work.
   *
   * Both this and `relayModel` must be filled for a pin to be configured at all.
   */
  relayProvider: '',
  /** Model id pinned on the continuation session, or blank to inherit the running one. */
  relayModel: '',
  /** Reasoning effort pinned with `relayModel`, or blank to inherit the running one. */
  relayReasoningEffort: '',
}

export const LIMITS = {
  thresholdPercent: { min: 1, max: 100 },
  consecutiveCount: { min: 1, max: 50 },
  delaySeconds: { min: 1, max: 3600 },
  // `0` is meaningful for the character bound (no bound at all), so the floor is
  // zero rather than one; the item bound keeps one as its floor because "carry
  // zero items" is what the master switch already says.
  maxQueueChars: { min: 0, max: 200000 },
  maxQueueItems: { min: 1, max: 200 },
  relayTimeoutSeconds: { min: 10, max: 3600 },
}

const INT_RE = /^-?\d+$/

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does NOT resolve to its value: schemastery wraps
 * it with cosmokit's `createVolatile(default)`, so what reaches `apply` is
 * `{ get() }`. Reading `settings.thresholdPercent` directly would yield that
 * object, and every guard below would quietly pick the default — the plugin
 * would look configured and behave unconfigured, with no error to point at.
 * The cell is also written in place when the user edits the field, which is
 * exactly what lets an edit apply without remounting; so `.get()` is both how
 * to read it and how live updates arrive. A plain value (a hand-built settings
 * object in a test, or an older host) passes through untouched.
 */
function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

function clampInt(value, fallback, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  return rounded >= min && rounded <= max ? rounded : fallback
}

function envInt(env, name, fallback, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!INT_RE.test(trimmed)) return fallback
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function envBool(env, name, fallback) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false
  return fallback
}

function envString(env, name, fallback) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  return raw.trim() === '' ? fallback : raw
}

function nonEmpty(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

function boolOr(value, env, name, fallback) {
  return typeof value === 'boolean' ? value : envBool(env, name, fallback)
}

/**
 * Resolve one instance's settings.
 *
 * @param config - the raw configuration handed to `apply` (may be undefined).
 * @param env - the process environment, injectable so tests never touch `process`.
 * @returns the resolved settings, always complete.
 */
export function resolveConfig(config, env = process.env) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  // Every field is unwrapped BEFORE it is type-checked: a `.volatile()` field
  // arrives as a cell, and a cell is an object, so `typeof raw.enabled` is
  // 'object' and every guard below would quietly pick the default instead.
  return {
    enabled: boolOr(unbox(raw.enabled), env, 'DSH_AUTO_RELAY_ENABLED', DEFAULTS.enabled),
    thresholdPercent: firstInt(
      unbox(raw.thresholdPercent),
      env, 'DSH_AUTO_RELAY_THRESHOLD_PERCENT',
      DEFAULTS.thresholdPercent, LIMITS.thresholdPercent,
    ),
    consecutiveCount: firstInt(
      unbox(raw.consecutiveCount),
      env, 'DSH_AUTO_RELAY_CONSECUTIVE_COUNT',
      DEFAULTS.consecutiveCount, LIMITS.consecutiveCount,
    ),
    incrementTitle: boolOr(unbox(raw.incrementTitle), env, 'DSH_AUTO_RELAY_INCREMENT_TITLE', DEFAULTS.incrementTitle),
    separator: nonEmpty(unbox(raw.separator), envString(env, 'DSH_AUTO_RELAY_SEPARATOR', DEFAULTS.separator)),
    delaySeconds: firstInt(
      unbox(raw.delaySeconds),
      env, 'DSH_AUTO_RELAY_DELAY_SECONDS',
      DEFAULTS.delaySeconds, LIMITS.delaySeconds,
    ),
    defaultTitle: nonEmpty(unbox(raw.defaultTitle), DEFAULTS.defaultTitle),
    promptTemplate: nonEmpty(unbox(raw.promptTemplate), DEFAULTS.promptTemplate),
    ignoreSubagents: boolOr(unbox(raw.ignoreSubagents), env, 'DSH_AUTO_RELAY_IGNORE_SUBAGENTS', DEFAULTS.ignoreSubagents),
    oncePerSession: boolOr(unbox(raw.oncePerSession), env, 'DSH_AUTO_RELAY_ONCE_PER_SESSION', DEFAULTS.oncePerSession),
    persistCounter: boolOr(unbox(raw.persistCounter), env, 'DSH_AUTO_RELAY_PERSIST_COUNTER', DEFAULTS.persistCounter),
    switchToRelay: boolOr(unbox(raw.switchToRelay), env, 'DSH_AUTO_RELAY_SWITCH_TO_RELAY', DEFAULTS.switchToRelay),
    archiveOldSession: boolOr(unbox(raw.archiveOldSession), env, 'DSH_AUTO_RELAY_ARCHIVE_OLD_SESSION', DEFAULTS.archiveOldSession),
    compressTools: nonEmpty(unbox(raw.compressTools), envString(env, 'DSH_AUTO_RELAY_COMPRESS_TOOLS', DEFAULTS.compressTools)),
    carryQueue: boolOr(unbox(raw.carryQueue), env, 'DSH_AUTO_RELAY_CARRY_QUEUE', DEFAULTS.carryQueue),
    maxQueueChars: firstInt(
      unbox(raw.maxQueueChars),
      env, 'DSH_AUTO_RELAY_MAX_QUEUE_CHARS',
      DEFAULTS.maxQueueChars, LIMITS.maxQueueChars,
    ),
    maxQueueItems: firstInt(
      unbox(raw.maxQueueItems),
      env, 'DSH_AUTO_RELAY_MAX_QUEUE_ITEMS',
      DEFAULTS.maxQueueItems, LIMITS.maxQueueItems,
    ),
    checkRelayModel: boolOr(unbox(raw.checkRelayModel), env, 'DSH_AUTO_RELAY_CHECK_RELAY_MODEL', DEFAULTS.checkRelayModel),
    relayTimeoutSeconds: firstInt(
      unbox(raw.relayTimeoutSeconds),
      env, 'DSH_AUTO_RELAY_RELAY_TIMEOUT_SECONDS',
      DEFAULTS.relayTimeoutSeconds, LIMITS.relayTimeoutSeconds,
    ),
    // The three model fields use '' as "no opinion", so an emptied field in the
    // panel falls back to the environment and then to the default — the same
    // fall-through every other string field uses. `nonEmpty` is not used here
    // because the default IS the empty string.
    relayProvider: optionalString(unbox(raw.relayProvider), env, 'DSH_AUTO_RELAY_RELAY_PROVIDER', DEFAULTS.relayProvider),
    relayModel: optionalString(unbox(raw.relayModel), env, 'DSH_AUTO_RELAY_RELAY_MODEL', DEFAULTS.relayModel),
    relayReasoningEffort: optionalString(
      unbox(raw.relayReasoningEffort),
      env, 'DSH_AUTO_RELAY_RELAY_REASONING_EFFORT',
      DEFAULTS.relayReasoningEffort,
    ),
  }
}

/** A string where blank means "not configured"; environment fills in when so. */
function optionalString(value, env, name, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value
  const fromEnv = envString(env, name, undefined)
  return fromEnv === undefined ? fallback : fromEnv
}

/** Prefer the configured number, then the environment, then the default. */
function firstInt(value, env, name, fallback, limits) {
  const configured = clampInt(value, undefined, limits)
  if (configured !== undefined) return configured
  return envInt(env, name, fallback, limits.min, limits.max)
}

/** Fill `{name}` placeholders from one flat record; unknown names stay literal. */
export function renderPrompt(template, values) {
  return template.replace(/\{([a-zA-Z]+)\}/gu, (match, key) => (
    Object.hasOwn(values, key) && values[key] !== undefined && values[key] !== null
      ? String(values[key])
      : match
  ))
}
