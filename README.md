# dsh-auto-relay

Open a continuation session automatically when a conversation keeps compressing near its context limit, and increment the session title's trailing number.

中文说明见 [README.zh.md](./README.zh.md).

## The problem

When a conversation approaches its context limit, compression fires repeatedly: each one replaces finished dialogue with a summary, and the summaries themselves occupy context. By the Nth compression little room is left, so staying in that session means compressing even more often and answering with progressively less material.

Once compression has happened N times in a row *while occupancy was high*, this plugin opens a session with a clean context and continues the work there. The new session reads the predecessor's conclusions instead of redoing what was already finished.

## When it fires

The plugin watches the session log for compression markers and reads the occupancy percentage **at the moment a compression starts** — the same number the conversation meter shows (`projectedTokens ?? pressureTokens` over `contextWindow`, rounded, capped at 100%).

- A compression at **≥ the threshold** counts;
- a compression **below** it resets the run to zero;
- a **failed** compression neither counts nor resets;
- an **unmeasurable** one (no usage sample or window yet) neither counts nor resets;
- reaching the configured streak opens the continuation session.

The counters live in the running process by default and start from zero after a restart. Turn on `persistCounter` to write them to local storage (domain `auto_relay`, table `counters`, one record per session) so a restart resumes the run instead of restarting it; records untouched for 30 days are pruned when the store opens. With the switch off nothing is read from or written to disk.

## Settings

Open **Settings → Plugins**, then open this plugin's page or its row: every field below is editable there and takes effect without a restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `thresholdPercent` | `50` | Occupancy percentage a compression must reach to count (1–100) |
| `consecutiveCount` | `5` | Compressions in a row before handing off (1–50) |
| `incrementTitle` | `true` | Continue the trailing number; start at 1 when there is none |
| `separator` | `-` | Separator before that number, as in `test-3`; also used to append `1` |
| `delaySeconds` | `1` | Delay before the task is delivered (1–3600) |
| `defaultTitle` | `自动接力` | Title used when the current one has none (or increment is off) |
| `promptTemplate` | see below | Prompt delivered to the continuation session |
| `ignoreSubagents` | `true` | Ignore subagent sessions |
| `oncePerSession` | `true` | At most one hand-off per session |
| `compressTools` | `compress,mcp__bili__compress` | Tool names that count as a compression |
| `persistCounter` | `false` | Write counters to local storage so a restart resumes them |
| `switchToRelay` | `true` | Show the relay session as soon as it starts |
| `archiveOldSession` | `true` | Archive the session that handed off |

The page groups the fields by purpose (when to relay, the continuation session, the title, counting and detection). An emptied number field falls back to the default; an out-of-range value is clamped on save; a checkbox applies at once; the prompt box keeps its newlines.

`promptTemplate` preserves newlines and accepts `{sessionId}`, `{count}`, `{percent}`, `{threshold}` and `{title}`; unknown placeholders stay literal. With both follow switches on, the plugin appends one marker line to the delivered prompt (`[dsh-auto-relay] from=… open=1 archive=1`) for the browser half to read; it does not change how the model reads the task, and it is absent when both switches are off.

Headless deployments can tune an install with `DSH_AUTO_RELAY_ENABLED`, `_THRESHOLD_PERCENT`, `_CONSECUTIVE_COUNT`, `_INCREMENT_TITLE`, `_SEPARATOR`, `_DELAY_SECONDS`, `_IGNORE_SUBAGENTS`, `_ONCE_PER_SESSION`, `_COMPRESS_TOOLS`, `_PERSIST_COUNTER`, `_SWITCH_TO_RELAY` and `_ARCHIVE_OLD_SESSION`. A variable applies only where the settings panel has no value for that field.

## Title increment

When the current title ends in a separator followed by digits, the continuation uses the same stem and the next number: `test-3` → `test-4`, `build_6` → `build_7` (with `_` as the separator). Leading zeroes survive (`test-007` → `test-008`) so sorting still works.

A title **without** such a trailing number is neither copied verbatim nor replaced by the default: the same separator starts a series at 1. `test` → `test-1`, or `test` → `test_1` when the separator is `_`. The next hand-off turns `test-1` into `test-2`, so the chain reads as consecutive parts of one job. A name whose number is not trailing (`report-3-final`) counts as unnumbered and starts its own series. `defaultTitle` applies only when the session has no title at all or `incrementTitle` is off; an empty separator disables numbering and keeps the original title.

A **bracketed** counter such as `sessionname-2（1）` follows DSH's own fork-naming rule and increments in place, keeping the bracket style (ASCII or full width): `sessionname-2（1）` → `sessionname-2（2）`, `test (1)` → `test (2)`. The bracket test runs before the separator test, because `report-3（2）` belongs to `report-3`'s bracket series rather than to its hyphen series. Leading zeroes survive here too (`build（007）` → `build（008）`).

## Following the relay

Once the relay task is delivered, the browser half shows the new session and archives the one that handed off (both switches are in Settings). The order is fixed — show first, archive second — because archiving the session on screen clears the conversation pane.

The two halves communicate through one trailing line in the delivered prompt (`[dsh-auto-relay] from=… open=1 archive=1`): the Host decides when to hand off, the browser decides how the interface moves. A task without that line — one you scheduled yourself, for instance — is never acted on. A delivery older than two minutes is ignored so that reopening the page does not pull the view to an old relay.

## Hand-off timing

Compression usually happens mid-turn. To keep two sessions from editing the same files at once, the continuation task is created when the **current turn closes** — or immediately when the session is idle. A failed creation (no scheduling service, for example) is not silently dropped: the earned hand-off is kept and retried at the next turn boundary.

## Which compressions count

Profiles implement compression differently, and both shapes are recognised:

- **DSH's own compaction**: `compaction/start` and `compaction/end` events;
- **profiles that implement compression as a model-driven tool call** (billion-context, for example): a tool call named `compress` and its result, where a result starting with `[Compressed` is a success and one starting with `[Compression FAILED`, `[Compression refused` or `[Compression no-op`, or marked as an error, is a failure. Rename the tool with `compressTools`.

## Compatibility

- Two halves: the Host half owns detection, counting and the hand-off; the browser half (`client.js`) follows the relay into view, archives the session that handed off, and carries the configuration page.
- Optional dependency on `@deepseek-ai/schemastery`: without it the plugin runs on its defaults and the panel offers no switches (the log says so).
- Without the scheduling service (`schedule`) the hand-off cannot be created (one warning, retried later); without the title service (`sessionTitle`) the title falls back to `defaultTitle`.
- A browser without the settings service (`configForms`) or the slot service (`slots`) simply shows no configuration page; the relay and the follow keep working. iOS and native shells load no browser half at all, so neither the follow nor the archive happens there.

## Install

```sh
dsh plugin add /path/to/dsh-auto-relay
```

Or straight from this repository (a `git:` dependency; the `file:` form above is for a local checkout):

```sh
dsh plugin add git+https://github.com/LXinH3RT/dsh-auto-relay.git
```

After a schema change the settings panel picks it up only when the plugin is disabled and enabled again — touching the source files does not reload the plugin.

## Tests

```sh
node --test test/smoke.mjs test/mount.mjs test/compress-events.mjs test/persist.mjs
```

`scripts/replay.mjs` feeds real session logs through the plugin itself, to check that detection still matches the current profile:

```sh
node scripts/replay.mjs --limit 3 --threshold 50
```

## Privacy

Both scripts read session logs from the local DSH directory (`$USERPROFILE/.dsh/sessions`, or `$HOME`); nothing leaves the machine and no log content is written into the repository. The replay output prints session ids and percentages only — review it before pasting anywhere.

## License

MIT
