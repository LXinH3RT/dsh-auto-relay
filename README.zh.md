# dsh-auto-relay

当一段对话在接近上下文上限时反复触发压缩，就自动开一个新会话接着做没做完的事，并把会话标题的尾部序号加一。

When a conversation keeps compressing near its context limit, open a continuation session automatically and increment the session title's trailing number.

## 它解决什么

上下文快满时，压缩会反复触发：每次压缩都把已完成的对话换成摘要，摘要本身也会占据上下文。等压缩到了第 N 次，剩下的上下文已经不多，继续在这个会话里工作只会更频繁地压缩，产出质量随之下降。

这个插件在压缩"连续发生在高占用状态"达到设定次数后，新建一个干净上下文的会话，把原任务接着做下去；新会话只需读上一会话的结论，不用重做已完成的部分。

## 触发规则

插件监听会话日志里的压缩标记，在**压缩开始的那一刻**读取上下文占用百分比——这个百分比与对话界面右上角的占用指示一致（`projectedTokens ?? pressureTokens` 除以 `contextWindow`，四舍五入，上限 100%）。

- 占用 **≥ 阈值** 的压缩计一次；
- 占用 **< 阈值** 的压缩把连续计数清零；
- 压缩**失败**既不计数也不清零；
- **无法测量**（还没有用量样本或上下文窗口）既不计数也不清零；
- 连续计数达到设定次数时开启接力会话。

计数默认只存在于运行中的进程里，重启后从零开始；把 `persistCounter` 打开后，计数写入本地存储（域 `auto_relay`，表 `counters`，每会话一条记录），重启后接着上次的次数继续累计，30 天未更新的记录在打开存储时清理。关闭该开关时不读写磁盘。

## 配置

设置面板里全部可改，改动即时生效，无需重启：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `thresholdPercent` | `50` | 计入连续次数的占用百分比（1–100） |
| `consecutiveCount` | `5` | 连续多少次达标压缩后开启接力（1–50） |
| `incrementTitle` | `true` | 新会话标题是否沿用序号并加一 |
| `separator` | `-` | 序号前的连接符，如 `test-3` 的 `-` |
| `delaySeconds` | `1` | 接力任务的投递延时（1–3600 秒） |
| `defaultTitle` | `自动接力` | 当前标题不含序号时使用的标题 |
| `promptTemplate` | 见下 | 投递给接力会话的提示词 |
| `ignoreSubagents` | `true` | 忽略子智能体会话 |
| `oncePerSession` | `true` | 每个会话最多接力一次 |
| `compressTools` | `compress,mcp__bili__compress` | 把压缩实现为工具调用时，哪些工具名算作压缩 |
| `persistCounter` | `false` | 计数写入本地存储，重启后继续累计 |

`promptTemplate` 原样保留换行，可用占位符：`{sessionId}`、`{count}`、`{percent}`、`{threshold}`、`{title}`。未识别的占位符保持原样。

无界面部署可用环境变量调整：`DSH_AUTO_RELAY_ENABLED`、`_THRESHOLD_PERCENT`、`_CONSECUTIVE_COUNT`、`_INCREMENT_TITLE`、`_SEPARATOR`、`_DELAY_SECONDS`、`_IGNORE_SUBAGENTS`、`_ONCE_PER_SESSION`、`_COMPRESS_TOOLS`、`_PERSIST_COUNTER`。

## 标题递增

当前会话标题以"连接符 + 数字"结尾时，新会话使用"同一个 stem + 序号加一"：`test-3` → `test-4`，`build_6` → `build_7`。前导零保留（`test-007` → `test-008`），便于排序。`report-3-final` 这种序号不在末尾的标题不会被改动；标题不含序号时使用 `defaultTitle`。

## 接力时机

压缩通常发生在回合中途。为避免新旧两个会话同时改同一批文件，接力任务在**当前回合结束时**创建（空闲会话里则立即创建）。创建失败（例如定时任务服务不可用）不会静默丢弃：交接资格保留，下一个回合边界重试。

## 识别哪些压缩

不同 profile 的压缩实现不同，插件同时识别两种：

- **DSH 自带压缩**：`compaction/start` / `compaction/end` 事件；
- **把压缩做成模型工具调用的 profile**（例如 billion-context）：名为 `compress` 的工具调用及其结果，结果以 `[Compressed` 开头视为成功，以 `[Compression FAILED` / `[Compression refused` / `[Compression no-op` 开头或标记为错误视为失败。工具名可用 `compressTools` 改写。

## 兼容性

- 纯 Host 插件，不带客户端界面，设置项经由配置 schema 投影到插件设置面板。
- 可选依赖 `@deepseek-ai/schemastery`；缺失时插件按默认值运行，面板不提供开关（日志会说明）。
- 定时任务服务（`schedule`）与标题服务（`sessionTitle`）缺失时：前者使接力无法创建（记录一次警告，资格保留待重试），后者使标题回退到 `defaultTitle`。

## 安装

```sh
dsh plugin install /path/to/dsh-auto-relay
```

## 测试

```sh
node --test test/smoke.mjs test/mount.mjs test/compress-events.mjs test/persist.mjs
```

`scripts/replay.mjs` 可把真实会话日志送入插件本体回放，检查识别逻辑对当前 profile 是否仍然有效：

```sh
node scripts/replay.mjs --limit 3 --threshold 50
```

## 隐私

两个脚本只读取本机 DSH 目录下的会话日志（`$USERPROFILE/.dsh/sessions`，或 `$HOME`），数据不出本机，日志内容也不会写入仓库。回放输出只包含会话 id 与百分比，转贴前请自行确认。

## License

MIT
