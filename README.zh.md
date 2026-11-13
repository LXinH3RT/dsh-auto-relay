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

在「设置 → 插件」里找到本插件，打开它的详情页或它那一行，即可编辑下表全部设置；改动即时生效，无需重启。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `thresholdPercent` | `50` | 计入连续次数的占用百分比（1–100） |
| `consecutiveCount` | `5` | 连续多少次达标压缩后开启接力（1–50） |
| `incrementTitle` | `true` | 新会话标题是否沿用序号并加一；标题不含序号时从 1 开始编号 |
| `separator` | `-` | 序号前的连接符，如 `test-3` 的 `-`；也用于给无序号标题追加序号 1 |
| `delaySeconds` | `1` | 接力任务的投递延时（1–3600 秒） |
| `defaultTitle` | `自动接力` | 当前会话没有标题（或关闭标题递增）时使用的标题 |
| `promptTemplate` | 见下 | 投递给接力会话的提示词 |
| `ignoreSubagents` | `true` | 忽略子智能体会话 |
| `oncePerSession` | `true` | 每个会话最多接力一次 |
| `compressTools` | `compress,mcp__bili__compress` | 把压缩实现为工具调用时，哪些工具名算作压缩 |
| `persistCounter` | `false` | 计数写入本地存储，重启后继续累计 |
| `switchToRelay` | `true` | 接力会话开始后，把对话界面自动切到新会话 |
| `archiveOldSession` | `true` | 切到接力会话后，把交出任务的旧会话归档 |

配置页按用途分成四组（触发条件、接力会话、会话标题、计数与识别）。数字框留空表示恢复默认值，超出范围的值在保存时收敛到边界；复选框点击即生效；提示词框原样保留换行。

`promptTemplate` 原样保留换行，可用占位符：`{sessionId}`、`{count}`、`{percent}`、`{threshold}`、`{title}`。未识别的占位符保持原样。插件在两页开关都打开时，会在提示词末尾追加一行标记（`[dsh-auto-relay] from=… open=1 archive=1`）供浏览器半部分识别；这一行不影响模型理解，也不会出现在两页开关都关闭的场景里。

无界面部署可用环境变量调整：`DSH_AUTO_RELAY_ENABLED`、`_THRESHOLD_PERCENT`、`_CONSECUTIVE_COUNT`、`_INCREMENT_TITLE`、`_SEPARATOR`、`_DELAY_SECONDS`、`_IGNORE_SUBAGENTS`、`_ONCE_PER_SESSION`、`_COMPRESS_TOOLS`、`_PERSIST_COUNTER`、`_SWITCH_TO_RELAY`、`_ARCHIVE_OLD_SESSION`。环境变量只在设置面板没有给出该字段时生效。

## 标题递增

当前会话标题以"连接符 + 数字"结尾时，新会话使用"同一个 stem + 序号加一"：`test-3` → `test-4`，`build_6` → `build_7`（连接符设为 `_` 时）。前导零保留（`test-007` → `test-008`），便于排序。

标题**不含**这种尾部序号时，不会原样复用，也不会退回默认标题，而是用同一个连接符从 1 开始编号：`test` → `test-1`，连接符设为 `_` 时 `test` → `test_1`。之后 `test-1` 再接力为 `test-2`，整条链读起来是同一份工作的连续片段。`report-3-final` 这类序号不在末尾的标题按"无序号"处理，从 1 另起一条序列；`defaultTitle` 只在当前会话根本没有标题、或关闭了标题递增时使用。连接符留空表示不编号，仅沿用原标题。

形如 `sessionname-2（1）` 的**括号序号**按 DSH 自身 fork 会话的规则原地递增，括号风格（半角/全角）保持不变：`sessionname-2（1）` → `sessionname-2（2）`，`test (1)` → `test (2)`。括号判定先于连接符，因为 `report-3（2）` 属于 `report-3` 的括号序列，而不是短横线序列。前导零同样保留（`build（007）` → `build（008）`）。

## 界面跟随

接力任务投递后，浏览器半部分会把对话界面切到新会话，并把交出任务的旧会话归档（两个开关见「配置」）。顺序固定为先切后归档——归档当前正在查看的会话会清空对话区。

两半部分通过投递的提示词末尾一行标记通信（`[dsh-auto-relay] from=… open=1 archive=1`）：Host 决定何时交接，浏览器决定界面如何变化。不带这行标记的任务（例如你自己建的定时任务）一律不处理。投递时间早于两分钟的接力会被忽略，避免重新打开页面时被很久以前的接力抢走视线。

## 接力时机

压缩通常发生在回合中途。为避免新旧两个会话同时改同一批文件，接力任务在**当前回合结束时**创建（空闲会话里则立即创建）。创建失败（例如定时任务服务不可用）不会静默丢弃：交接资格保留，下一个回合边界重试。

## 识别哪些压缩

不同 profile 的压缩实现不同，插件同时识别两种：

- **DSH 自带压缩**：`compaction/start` / `compaction/end` 事件；
- **把压缩做成模型工具调用的 profile**（例如 billion-context）：名为 `compress` 的工具调用及其结果，结果以 `[Compressed` 开头视为成功，以 `[Compression FAILED` / `[Compression refused` / `[Compression no-op` 开头或标记为错误视为失败。工具名可用 `compressTools` 改写。

## 兼容性

- 由两个半部分组成：Host 半部分负责识别压缩、计数与创建接力会话；浏览器半部分（`client.js`）负责在接力投递后切换界面、归档旧会话，并承载配置页面。
- 可选依赖 `@deepseek-ai/schemastery`；缺失时插件按默认值运行，面板不提供开关（日志会说明）。
- 定时任务服务（`schedule`）与标题服务（`sessionTitle`）缺失时：前者使接力无法创建（记录一次警告，资格保留待重试），后者使标题回退到 `defaultTitle`。
- 浏览器缺少设置服务（`configForms`）或插槽服务（`slots`）时，配置页安静地不出现，接力与界面跟随照常工作。iOS 与原生壳不加载浏览器半部分，此时切换与归档也不生效。

## 安装

```sh
dsh plugin add /path/to/dsh-auto-relay
```

也可以直接从本仓库安装（`git:` 形式；上面的 `file:` 写法用于本地检出）：

```sh
dsh plugin add git+https://github.com/LXinH3RT/dsh-auto-relay.git
```

配置 schema 变更后，需要在插件页把本插件禁用再启用，设置面板才会读到新字段——改动源文件不会触发重载。

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
