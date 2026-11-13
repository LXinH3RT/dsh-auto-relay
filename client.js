// dsh-auto-relay — browser half.
//
// A plain hand-written bundle, like the ones DSH ships: no build step, no
// `import`/`export`, no JSX. The page loads it as a script and the module loader
// below supplies `require`, which is asked for React only.
//
// Two jobs, both of which only the browser can do:
//
//   1. Follow the relay. After the Host half opens a continuation session, this
//      half shows that session and archives the one that handed off. The visible
//      selection belongs to the browser and `ctx.uiWorkspace` is the only service
//      that can move it. The Host decides WHEN, this half performs WHAT.
//   2. Own the configuration page. A Host schema reaches the Plugins tab only
//      through a page some browser half registers on `plugins.bundle.config` or
//      `plugins.row.config`; no shipped package draws one for a third-party
//      bundle. Without this half the settings row exists but renders nothing.
//
// How the two halves agree about a relay, and why it is done this way:
//   - The Host cannot call a client service, and it cannot push a custom event:
//     `ctx.remote.$on` accepts a fixed list of forwarded names
//     (`API_REMOTE_FORWARDED_EVENTS`), and a plugin-owned namespace would need a
//     whole Typert descriptor set. So the intent travels on data both halves
//     already read: the delivered prompt of the relay task.
//   - `ctx.remote.schedule.catalog()` lists every task with its `prompt`,
//     `target` and `lastDelivery`. The Host writes one trailing line into the
//     prompt (`lib/marker.js`); this half finds tasks bearing that line.
//   - A prompt without the line is left alone. That is what keeps this half from
//     reacting to a task the user scheduled by hand, whose prompt may mention
//     anything at all.
//   - `archive` implies `open` on the Host side, because archiving the session
//     on screen blanks the main view (`clearArchivedCurrent`). This half mirrors
//     the order: show the successor first, archive the predecessor second, and
//     never archive whatever happens to be visible — only the `from=` session the
//     Host named.
//
// How the configuration page is addressed, taken from this DSH build:
//   - The settings namespace is the patch row id exactly as `cordis.patch.yml`
//     declares it: `dsh-auto-relay`. `settings.describe()` publishes
//     `ns: entry.options.id`, and `entry.options.id` is the row id — the
//     `include:` in `include:dsh-auto-relay` is only the tree path of the Loader
//     entry. Passing the prefixed form makes `whileServed` wait for a namespace
//     the Host never publishes, so the page silently never appears.
//   - The page seats are keyed slots. `plugins.bundle.config` is keyed by the
//     package name; `plugins.row.config` is keyed `<package>#<patch row id>`.
//   - `ctx.configForms.whileServed([ns], cb)` runs `cb` once the Host lists that
//     namespace. A scope taken before that round trip settles stays unavailable
//     forever, so the page is registered from inside the gate.
//   - The owner passes the page a `form` prop for the entry it shows
//     (`{state, mutate(ops, revision)}`); the page prefers it and falls back to
//     its own `configForms` scope.
//
// Other facts taken from this DSH build rather than from documentation:
//   - `ctx.uiWorkspace.openSession(target)` accepts a plain session id string and
//     routes it through `replaceMain` → `sessions.retain` + selection store.
//   - `ctx.uiWorkspace.archiveSession(id, {stopActivity:true})` archives and
//     clears the pane when that id is the current selection.
//   - `schedule/changed` is a forwarded event, so `ctx.remote.$on` accepts it;
//     `ctx.remote.schedule.catalog()` is the shared, Host-sourced list.
//   - `new_once` reserves its Session id at creation and creates it on delivery,
//     so `lastDelivery.targetSessionId` is what to open — the reserved id is the
//     same value, but only after a delivery does the Session exist.

window.__ModuleLoader__.load({
  id: 'dsh-auto-relay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // The configuration page is a React component; the relay follower is not.
    // A missing React costs the page, never the follow.
    var React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }

    /** The line the Host writes into a relay prompt. Mirrors `lib/marker.js`. */
    const MARKER_PREFIX = '[dsh-auto-relay]'

    /** Poll fallback, in milliseconds, when `schedule/changed` says nothing. */
    const POLL_MS = 5000

    /**
     * The settings namespace, which is the patch row id — *not* the Loader's
     * tree path. The page-side manager asks `configForms` for the namespace
     * `row.rowId`, so anything else here (including the `include:` prefixed
     * runtime id) never matches and the page never appears.
     */
    const NS = 'dsh-auto-relay'

    /** The two page seats: the package page and the patch row's page. */
    const BUNDLE_KEY = 'dsh-auto-relay'
    const ROW_KEY = `${BUNDLE_KEY}#dsh-auto-relay`

    /**
     * How far back a delivery may be and still move the interface.
     *
     * A relay that landed while the page was closed (or a minute before it
     * loaded) should still be followed; a relay from last week should not pull
     * the user away from what they are reading. Two minutes covers the first and
     * excludes the second, and a task is acted on at most once per page life
     * either way.
     */
    const DELIVERY_SLACK_MS = 2 * 60 * 1000

    // --------------------------------------------------------------- the marker

    /**
     * Read the marker line out of a prompt.
     *
     * Kept byte-for-byte compatible with `parseMarker` in `lib/marker.js`; the
     * Host module cannot be imported here, so `test/mount.mjs` asserts the pair.
     */
    function parseMarker(prompt) {
      if (typeof prompt !== 'string' || prompt.indexOf(MARKER_PREFIX) < 0) return null
      var lines = prompt.split('\n')
      var line = null
      for (var index = 0; index < lines.length; index += 1) {
        if (lines[index].indexOf(MARKER_PREFIX) === 0) {
          line = lines[index]
          break
        }
      }
      if (line === null) return null
      var from = /\bfrom=(\S+)/u.exec(line)
      return {
        from: from === null ? null : from[1],
        open: /\bopen=1\b/u.test(line),
        archive: /\barchive=1\b/u.test(line),
      }
    }

    /** The session a task delivered into, or null while it has not delivered. */
    function targetSessionOf(task) {
      var delivery = task.lastDelivery
      if (delivery !== undefined && delivery !== null && typeof delivery.targetSessionId === 'string') {
        return delivery.targetSessionId
      }
      return null
    }

    // ------------------------------------------------------------------- fields

    /**
     * Every configuration field this page edits, in display order.
     *
     * Mirrors the Host schema in `index.js`; `test/client.mjs` asserts the two
     * lists agree, because this file cannot import the Host module.
     */
    const GROUPS = [
      {
        id: 'trigger',
        title: 'triggerTitle',
        hint: 'triggerHint',
        fields: [
          { key: 'enabled', kind: 'boolean' },
          { key: 'thresholdPercent', kind: 'number', min: 1, max: 100, step: 1 },
          { key: 'consecutiveCount', kind: 'number', min: 1, max: 50, step: 1 },
        ],
      },
      {
        id: 'relay',
        title: 'relayTitle',
        hint: 'relayHint',
        fields: [
          { key: 'delaySeconds', kind: 'number', min: 1, max: 3600, step: 1 },
          { key: 'promptTemplate', kind: 'textarea' },
          { key: 'switchToRelay', kind: 'boolean' },
          { key: 'archiveOldSession', kind: 'boolean' },
          { key: 'ignoreSubagents', kind: 'boolean' },
          { key: 'oncePerSession', kind: 'boolean' },
        ],
      },
      {
        id: 'naming',
        title: 'namingTitle',
        hint: 'namingHint',
        fields: [
          { key: 'incrementTitle', kind: 'boolean' },
          { key: 'separator', kind: 'text' },
          { key: 'defaultTitle', kind: 'text' },
        ],
      },
      {
        id: 'counter',
        title: 'counterTitle',
        hint: 'counterHint',
        fields: [
          { key: 'persistCounter', kind: 'boolean' },
          { key: 'compressTools', kind: 'text' },
        ],
      },
    ]

    /** Every editable key, flattened. */
    const FIELDS = GROUPS.reduce((all, group) => all.concat(group.fields), [])

    /** Look one field up by key. */
    function fieldOf(key) {
      for (const field of FIELDS) if (field.key === key) return field
      return undefined
    }

    // --------------------------------------------------------------------- copy

    const en = {
      title: 'Auto relay',
      summary: 'When a conversation keeps compressing near its context limit, open a continuation session automatically.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      resetAll: 'Reset to defaults',
      saved: 'Saved',
      rejected: 'The deployment did not accept this change; it was left for you to correct.',
      conflict: 'The configuration changed elsewhere; reload and try again.',
      invalidNumber: 'That is not a number.',
      overridden: 'overridden',
      defaultHint: 'default',
      triggerTitle: 'When to relay',
      triggerHint: 'A compression counts only when the context was at or above the threshold at the moment it happened.',
      relayTitle: 'The continuation session',
      relayHint: 'What the new session is told, and whether the interface follows it.',
      namingTitle: 'Session title',
      namingHint: 'The successor is named after this session.',
      counterTitle: 'Counter and detection',
      counterHint: 'Whether the count survives a restart, and which tools count as a compression.',
      'field.enabled': 'Enabled',
      'hint.enabled': 'When off, nothing is read and no session is created.',
      'field.thresholdPercent': 'Context threshold (%)',
      'hint.thresholdPercent': '1–100. Matches the meter at the top right of the conversation.',
      'field.consecutiveCount': 'Consecutive compressions',
      'hint.consecutiveCount': '1–50. One compression below the threshold restarts the count.',
      'field.delaySeconds': 'Delivery delay (s)',
      'hint.delaySeconds': '1–3600. Leaves time for the current turn to finish.',
      'field.promptTemplate': 'Prompt sent to the new session',
      'hint.promptTemplate': 'Newlines are kept. Placeholders: {sessionId}, {count}, {percent}, {threshold}, {title}.',
      'field.switchToRelay': 'Switch the interface to the new session',
      'hint.switchToRelay': 'When off, the new session starts quietly in the sidebar.',
      'field.archiveOldSession': 'Archive the old session',
      'hint.archiveOldSession': 'Requires switching. Archiving the session on screen clears the pane, so the switch always happens first.',
      'field.ignoreSubagents': 'Ignore subagent sessions',
      'hint.ignoreSubagents': 'A subagent context ends with its task; it needs no continuation.',
      'field.oncePerSession': 'Relay each session at most once',
      'hint.oncePerSession': 'Prevents a chain of sessions relaying from each other.',
      'field.incrementTitle': 'Increment the trailing number',
      'hint.incrementTitle': 'test-3 → test-4, and a title without a number starts at test → test-1.',
      'field.separator': 'Separator',
      'hint.separator': 'Recognises an existing number and appends "1" to one that has none. Empty disables numbering.',
      'field.defaultTitle': 'Fallback title',
      'hint.defaultTitle': 'Used when this session has no title, or when incrementing is off.',
      'field.persistCounter': 'Keep the count across restarts',
      'hint.persistCounter': 'Off: the count lives in this run only. On: a long session keeps its progress after a restart.',
      'field.compressTools': 'Tools that count as a compression',
      'hint.compressTools': 'Comma or space separated, for profiles that implement compression as a tool call. Built-in compaction events always count.',
    }

    const zh = {
      title: '自动接力',
      summary: '会话在接近上下文上限时反复压缩，就自动开一个新会话接力未完成的任务。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      resetAll: '全部恢复默认',
      saved: '已保存',
      rejected: '本部署没有接受这次改动，内容已保留供你修改。',
      conflict: '配置已被其他改动更新，请重新载入后再试。',
      invalidNumber: '这里需要填一个数字。',
      overridden: '已覆盖',
      defaultHint: '默认',
      triggerTitle: '触发条件',
      triggerHint: '只有压缩发生时的上下文占比达到阈值，才算一次。',
      relayTitle: '接力会话',
      relayHint: '新会话收到什么，以及界面是否跟过去。',
      namingTitle: '会话标题',
      namingHint: '新会话按当前会话的标题命名。',
      counterTitle: '计数与识别',
      counterHint: '计数是否跨重启保留，以及哪些工具算一次压缩。',
      'field.enabled': '启用',
      'hint.enabled': '关闭后不读取也不创建任何会话。',
      'field.thresholdPercent': '上下文阈值（%）',
      'hint.thresholdPercent': '1–100，与对话界面右上角的占用指示一致。',
      'field.consecutiveCount': '连续压缩次数',
      'hint.consecutiveCount': '1–50。中间出现一次低于阈值的压缩即重新计数。',
      'field.delaySeconds': '投递延时（秒）',
      'hint.delaySeconds': '1–3600，留出收尾时间。',
      'field.promptTemplate': '投递给新会话的提示词',
      'hint.promptTemplate': '原样保留换行。可用占位符：{sessionId}、{count}、{percent}、{threshold}、{title}。',
      'field.switchToRelay': '把界面切到新会话',
      'hint.switchToRelay': '关闭时新会话在侧边栏静默开始，由你手动切换。',
      'field.archiveOldSession': '归档旧会话',
      'hint.archiveOldSession': '需要上一项开启。归档当前会话会清空对话区，所以界面总是先切过去再归档。',
      'field.ignoreSubagents': '忽略子智能体会话',
      'hint.ignoreSubagents': '子代理的上下文随任务结束，不需要接力。',
      'field.oncePerSession': '每个会话最多接力一次',
      'hint.oncePerSession': '避免链式会话反复接力。',
      'field.incrementTitle': '标题序号加一',
      'hint.incrementTitle': 'test-3 → test-4；标题不含序号时从 test → test-1 开始。',
      'field.separator': '连接符',
      'hint.separator': '既用于识别已有序号，也用于给不含序号的标题追加 1。留空表示不编号。',
      'field.defaultTitle': '默认标题',
      'hint.defaultTitle': '当前会话没有标题，或关闭标题递增时使用。',
      'field.persistCounter': '计数跨重启保留',
      'hint.persistCounter': '关闭时计数只在本次运行中有效；开启后长会话在重启后仍能接续。',
      'field.compressTools': '算作一次压缩的工具',
      'hint.compressTools': '逗号或空格分隔，用于把压缩实现为工具调用的 profile。DSH 自带的 compaction 事件始终算一次。',
    }

    /**
     * Pick a dictionary without depending on the locale service.
     *
     * A configuration page is worth showing even on a client that ships no
     * locale service, so the browser language is the only signal used here.
     */
    function reader() {
      const language = typeof navigator !== 'undefined' ? String(navigator.language ?? '') : ''
      const table = /^zh\b/i.test(language) ? zh : en
      return (key) => {
        const text = table[key]
        return typeof text === 'string' ? text : key
      }
    }

    // -------------------------------------------------------------------- theme

    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER_SOFT = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    const WARN_LABEL = 'var(--dsw-alias-state-warn-label, #b45309)'
    const LINK_LABEL = 'var(--dsw-alias-link, inherit)'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    const PAGE_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      maxWidth: '760px',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const GROUP_STYLE = { display: 'flex', flexDirection: 'column', gap: '10px' }
    const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px' }
    const TITLE_STYLE = { margin: 0, color: LABEL_PRIMARY, fontFamily: 'inherit', fontSize: '15px', fontWeight: 600, lineHeight: '22px' }
    const GROUP_TITLE_STYLE = { margin: 0, color: LABEL_PRIMARY, fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, lineHeight: '20px' }
    const LABEL_STYLE = { fontWeight: 500 }
    const HINT_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px' }
    const INPUT_STYLE = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '7px 10px',
      border: `1px solid ${BORDER_SOFT}`,
      borderRadius: RADIUS,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const NUMBER_STYLE = { ...INPUT_STYLE, width: '120px' }
    const ROW_STYLE = { display: 'flex', alignItems: 'flex-start', gap: '8px' }
    const ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: '12px' }
    const BUTTON_STYLE = {
      padding: '5px 14px',
      border: `1px solid ${BORDER_SOFT}`,
      borderRadius: RADIUS,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const PRIMARY_BUTTON_STYLE = { ...BUTTON_STYLE, borderColor: LINK_LABEL, color: LINK_LABEL }
    const LINK_BUTTON_STYLE = {
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: LINK_LABEL,
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
    }
    const READONLY_STYLE = { ...BUTTON_STYLE, opacity: 0.55 }

    // -------------------------------------------------------------------- scope

    /** Read a snapshot, or `undefined` when the scope is gone or refuses. */
    function readSnapshot(scope) {
      if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return undefined
      try {
        const snapshot = scope.getSnapshot()
        return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
      } catch {
        return undefined
      }
    }

    /** Whether the user has a stored override at `path`, by presence only. */
    function hasPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(cursor, step)) return false
        cursor = cursor[step]
      }
      return true
    }

    /**
     * Adapt the `form` prop an owner hands a page into the same shape as a scope.
     *
     * Its state is a snapshot the owner re-reads on every render, so there is
     * nothing to subscribe to; a re-render is the refresh.
     */
    function formScope(form) {
      if (form === undefined || form === null || typeof form.mutate !== 'function') return undefined
      const read = () => {
        try {
          const snapshot = form.state
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : undefined
        } catch {
          return undefined
        }
      }
      return { getSnapshot: read, mutate: (ops, revision) => form.mutate(ops, revision) }
    }

    /**
     * Apply one batch of path-addressed operations against the revision read now.
     *
     * The revision matters: the settings service refuses a write composed
     * against a value somebody else has replaced, instead of overwriting it.
     */
    async function write(scope, ops) {
      const snapshot = readSnapshot(scope)
      if (scope === undefined || scope === null || typeof scope.mutate !== 'function') {
        return { ok: false, reason: 'unavailable' }
      }
      if (snapshot === undefined || snapshot.writable !== true) return { ok: false, reason: 'readOnly' }
      try {
        const landed = await scope.mutate(ops, snapshot.revision)
        return landed ? { ok: true } : { ok: false, reason: 'rejected' }
      } catch (error) {
        const code = error?.code ?? error?.cause?.code
        return { ok: false, reason: code === 'SETTINGS_CONFLICT' ? 'conflict' : 'rejected' }
      }
    }

    // --------------------------------------------------------------------- page

    /**
     * Turn the current draft into the operations that write it.
     *
     * A number is clamped into its declared range rather than rejected, and an
     * emptied field is an `unset` so the Host default applies again. Booleans
     * never appear here: they are written the moment they are toggled.
     */
    function draftOps(draft) {
      const ops = []
      for (const key of Object.keys(draft)) {
        const field = fieldOf(key)
        if (field === undefined) continue
        const raw = draft[key]
        if (field.kind === 'number') {
          const text = String(raw).trim()
          if (text === '') {
            ops.push({ op: 'unset', path: [key] })
            continue
          }
          const parsed = Number(text)
          if (!Number.isFinite(parsed)) return { ops: [], invalid: true }
          const value = Math.min(field.max, Math.max(field.min, Math.round(parsed)))
          ops.push({ op: 'set', path: [key], value })
          continue
        }
        const text = String(raw)
        if (text.trim() === '') {
          ops.push({ op: 'unset', path: [key] })
          continue
        }
        ops.push({ op: 'set', path: [key], value: text })
      }
      return { ops, invalid: false }
    }

    /**
     * The configuration page.
     *
     * Rendered on both seats a bundle's settings can occupy in the Plugins tab.
     * Editable fields keep a draft and write on 保存; checkboxes write at once,
     * because a toggle that needed a second click would read as a broken switch.
     */
    function RelayConfigPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const form = props.form
      const scope = formScope(form) ?? props.scope
      const [snapshot, setSnapshot] = React.useState(() => readSnapshot(scope))
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        const active = formScope(form) ?? props.scope
        if (active === undefined || active === null) return undefined
        let alive = true
        const update = () => {
          if (alive) setSnapshot(readSnapshot(active))
        }
        let off
        if (typeof active.subscribe === 'function') {
          try {
            off = active.subscribe(update)
          } catch (error) {
            console.error('dsh-auto-relay: subscribing to the configuration scope failed', error)
          }
        }
        update()
        return () => {
          alive = false
          if (typeof off === 'function') {
            try {
              off()
            } catch (error) {
              console.error('dsh-auto-relay: releasing the configuration scope failed', error)
            }
          }
        }
      }, [form, props.scope])

      // Hooks run before the branch, so one instance keeps a stable hook order
      // if the owner ever renders it in both views.
      if (props.view === 'summary') return t('summary')

      if (snapshot === undefined) {
        return React.createElement('p', { style: HINT_STYLE }, t('unavailable'))
      }

      const value = snapshot.value ?? {}
      const writable = snapshot.writable === true
      const disabled = !writable || busy

      const submit = async (ops, onOk) => {
        setBusy(true)
        setNotice(null)
        const result = await write(scope, ops)
        setBusy(false)
        if (result.ok) {
          if (typeof onOk === 'function') onOk()
          setSnapshot(readSnapshot(scope))
          setNotice({ ok: true, text: t('saved') })
          return
        }
        setNotice({ ok: false, text: t(result.reason) })
      }

      const saveDraft = async () => {
        const built = draftOps(draft)
        if (built.invalid) {
          setNotice({ ok: false, text: t('invalidNumber') })
          return
        }
        if (built.ops.length === 0) {
          setDraft({})
          return
        }
        await submit(built.ops, () => setDraft({}))
      }

      const resetAll = () => {
        const ops = FIELDS.filter((field) => hasPath(snapshot.user, [field.key])).map((field) => ({ op: 'unset', path: [field.key] }))
        if (ops.length === 0) {
          setDraft({})
          setNotice({ ok: true, text: t('saved') })
          return
        }
        void submit(ops, () => setDraft({}))
      }

      const textOf = (field) => {
        if (Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key]
        const current = value[field.key]
        return current === undefined || current === null ? '' : String(current)
      }

      const edit = (key, next) => setDraft((previous) => ({ ...previous, [key]: next }))

      const control = (field) => {
        const id = `dsh-auto-relay-${field.key}`
        const rows = [
          React.createElement('label', { key: 'label', style: LABEL_STYLE, htmlFor: id }, t(`field.${field.key}`)),
        ]
        if (field.kind === 'number') {
          rows.push(React.createElement('input', {
            key: 'input',
            id,
            type: 'number',
            style: NUMBER_STYLE,
            value: textOf(field),
            min: field.min,
            max: field.max,
            step: field.step,
            disabled,
            onChange: (event) => edit(field.key, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveDraft()
              }
            },
          }))
        } else if (field.kind === 'textarea') {
          rows.push(React.createElement('textarea', {
            key: 'input',
            id,
            style: { ...INPUT_STYLE, minHeight: '120px', resize: 'vertical' },
            value: textOf(field),
            disabled,
            spellCheck: false,
            onChange: (event) => edit(field.key, event.target.value),
          }))
        } else {
          rows.push(React.createElement('input', {
            key: 'input',
            id,
            type: 'text',
            style: INPUT_STYLE,
            value: textOf(field),
            disabled,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => edit(field.key, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveDraft()
              }
            },
          }))
        }
        rows.push(React.createElement('p', { key: 'hint', style: HINT_STYLE }, t(`hint.${field.key}`)))
        rows.push(React.createElement(
          'p',
          { key: 'state', style: HINT_STYLE },
          `${t('defaultHint')}: ${value[field.key] === undefined ? '—' : JSON.stringify(value[field.key])}${hasPath(snapshot.user, [field.key]) ? ` · ${t('overridden')}` : ''}`,
        ))
        return React.createElement('div', { key: field.key, style: FIELD_STYLE }, rows)
      }

      const toggle = (field) => React.createElement(
        'label',
        { key: field.key, style: ROW_STYLE },
        React.createElement('input', {
          type: 'checkbox',
          checked: value[field.key] !== false,
          disabled,
          onChange: (event) => void submit([{ op: 'set', path: [field.key], value: event.target.checked }]),
        }),
        React.createElement(
          'span',
          null,
          React.createElement('span', { style: LABEL_STYLE }, t(`field.${field.key}`)),
          React.createElement('br'),
          React.createElement('span', { style: HINT_STYLE }, t(`hint.${field.key}`)),
        ),
      )

      const group = (entry) => React.createElement(
        'div',
        { key: entry.id, style: GROUP_STYLE },
        React.createElement('h4', { style: GROUP_TITLE_STYLE }, t(entry.title)),
        React.createElement('p', { style: HINT_STYLE }, t(entry.hint)),
        entry.fields.map((field) => (field.kind === 'boolean' ? toggle(field) : control(field))),
      )

      const button = (label, style, onClick) => React.createElement(
        'button',
        { type: 'button', style: disabled ? READONLY_STYLE : style, disabled, onClick: () => void onClick() },
        label,
      )

      return React.createElement(
        'div',
        { style: PAGE_STYLE, 'data-plugin-config': BUNDLE_KEY },
        React.createElement(
          'div',
          { style: FIELD_STYLE },
          React.createElement('h3', { style: TITLE_STYLE }, t('title')),
          React.createElement('p', { style: HINT_STYLE }, writable ? t('summary') : t('readOnly')),
        ),
        GROUPS.map(group),
        React.createElement(
          'div',
          { style: ACTIONS_STYLE },
          button(busy ? t('saving') : t('save'), PRIMARY_BUTTON_STYLE, saveDraft),
          Object.keys(draft).length === 0 ? null : button(t('discard'), LINK_BUTTON_STYLE, () => setDraft({})),
          button(t('resetAll'), LINK_BUTTON_STYLE, resetAll),
          notice === null
            ? null
            : React.createElement(
              'span',
              { style: { ...HINT_STYLE, color: notice.ok ? LABEL_SECONDARY : WARN_LABEL } },
              notice.text,
            ),
        ),
      )
    }

    // -------------------------------------------------------------------- relay

    function apply(ctx) {
      /** Task ids already acted on in this page life. */
      const handled = new Set()
      const startedAt = Date.now()
      /** Messages already logged, so a 5 s poll cannot flood the console. */
      const logged = new Set()

      function report(message, error) {
        const text = `${message} ${String(error?.message ?? error)}`
        if (logged.has(text)) return
        logged.add(text)
        console.warn(`dsh-auto-relay: ${text}`)
      }

      async function follow() {
        let catalog
        try {
          catalog = await ctx.remote.schedule.catalog()
        } catch (error) {
          // Access may still be settling, or the Host may be restarting. The next
          // poll retries; only a persistent refusal is worth a line in the console.
          report('读取定时任务列表失败，界面跟随暂停', error)
          return
        }
        const tasks = Array.isArray(catalog) ? catalog : []
        for (const task of tasks) {
          if (task === null || typeof task !== 'object') continue
          if (typeof task.id !== 'string' || handled.has(task.id)) continue
          const marker = parseMarker(task.prompt)
          if (marker === null) continue
          const delivered = task.lastDelivery
          if (delivered === undefined || delivered === null) continue
          const deliveredAt = Date.parse(String(delivered.deliveredAt ?? ''))
          if (!Number.isFinite(deliveredAt)) continue
          if (deliveredAt < startedAt - DELIVERY_SLACK_MS) {
            // Too old to move the interface; remember it so it is not reconsidered.
            handled.add(task.id)
            continue
          }
          const sessionId = targetSessionOf(task)
          if (sessionId === null) continue

          handled.add(task.id)
          try {
            // Show the successor first: archiving the session on screen clears it.
            if (marker.open) ctx.uiWorkspace.openSession(sessionId)
            if (marker.archive && marker.from !== null && marker.from !== sessionId) {
              await ctx.uiWorkspace.archiveSession(marker.from, { stopActivity: true })
            }
          } catch (error) {
            // Undo the bookkeeping: a failed follow is retried on the next change
            // or poll rather than silently dropped.
            handled.delete(task.id)
            report('切换或归档会话失败', error)
          }
        }
      }

      function safeFollow() {
        // One unhandled rejection must not take the page's plugin host down.
        follow().catch((error) => report('跟随接力会话时出错', error))
      }

      // Two triggers, deliberately: the forwarded event says "the list changed"
      // (created, delivered, ended), the interval covers the gap where a delivery
      // happened while the socket was reconnecting.
      if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
        ctx.effect(() => ctx.remote.$on('schedule/changed', safeFollow), 'dsh-auto-relay: schedule changes')
      }
      ctx.effect(() => ctx.timer.interval(safeFollow, POLL_MS), 'dsh-auto-relay: relay follow poll')

      // The event only fires on CHANGE. A relay delivered before this page
      // finished loading is already in the catalogue and will never announce
      // itself, so look once immediately.
      safeFollow()

      mountConfigPage(ctx)
    }

    /**
     * Register the configuration page on both seats it can occupy.
     *
     * Nothing here may throw: a browser half that fails to apply takes its whole
     * bundle's surface down with it, and the relay must keep working whether or
     * not this page is shown. A missing slots service, a missing settings
     * service, and a namespace the Host never lists all end as a page that is
     * simply absent.
     */
    function mountConfigPage(ctx) {
      if (React === null) {
        console.error('dsh-auto-relay: no React in this client; the settings page stays unmounted')
        return
      }
      if (ctx.slots === undefined || ctx.slots === null) {
        console.error('dsh-auto-relay: this client has no slots service; the settings page stays unmounted')
        return
      }
      if (typeof ctx.inject !== 'function') return

      try {
        // `configForms` is asked for at runtime rather than declared in `inject`:
        // the page is a convenience, not a reason to refuse to mount.
        ctx.inject(['configForms'], (inner) => {
          try {
            const configForms = inner.configForms
            if (configForms === undefined || configForms === null) return
            const t = reader()

            const register = () => {
              // The scope is taken HERE, inside the served gate. A scope obtained
              // before the Host lists the namespace stays unavailable for good,
              // because the controller only re-reads the mirror on a change.
              let scope
              try {
                scope = configForms.get(NS)
              } catch (error) {
                console.error(`dsh-auto-relay: no "${NS}" configuration scope`, error)
                return () => {}
              }
              const stops = []
              for (const [name, key] of [
                ['plugins.bundle.config', BUNDLE_KEY],
                ['plugins.row.config', ROW_KEY],
              ]) {
                stops.push(ctx.slots.inject(name, () => ctx.slots.register(
                  { name, key, inject: () => ({ t, scope }) },
                  RelayConfigPage,
                )))
              }
              return () => {
                for (const stop of stops) {
                  try {
                    stop?.()
                  } catch (error) {
                    console.error('dsh-auto-relay: releasing the settings page failed', error)
                  }
                }
              }
            }

            let release
            try {
              release = typeof configForms.whileServed === 'function' ? configForms.whileServed([NS], register) : register()
            } catch (error) {
              console.error(`dsh-auto-relay: this Host serves no "${NS}" configuration row`, error)
              return
            }
            if (typeof inner.effect === 'function') inner.effect(() => release, 'dsh-auto-relay: settings page')
          } catch (error) {
            console.error('dsh-auto-relay: registering the settings page failed', error)
          }
        })
      } catch (error) {
        console.error('dsh-auto-relay: mounting the settings page failed', error)
      }
    }

    // `uiWorkspace` performs the two follow actions; `remote.schedule` reads the
    // tasks; `timer` owns the poll; `slots` is where the configuration page goes.
    // `configForms` is asked for at runtime, above.
    const inject = ['remote', 'remote.schedule', 'uiWorkspace', 'timer', 'slots']

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-auto-relay'
    // Exposed so tests can check this file against the Host without a browser:
    // the marker parser must match `lib/marker.js`, and the field list must cover
    // every key the Host schema declares.
    exports.parseMarker = parseMarker
    exports.fieldKeys = () => FIELDS.map((field) => field.key)
    exports.draftOps = draftOps
    exports.RelayConfigPage = RelayConfigPage
    exports.NAMESPACE = NS
    exports.BUNDLE_KEY = BUNDLE_KEY
    exports.ROW_KEY = ROW_KEY
    return module.exports
  },
})
