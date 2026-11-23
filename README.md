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
| `archiveOldSession` | `true` | Stop and archive the session that handed off, once the successor is reserved |
| `carryQueue` | `true` | Send input still waiting in the old queue to the new session |
| `maxQueueChars` | `6000` | Character bound on carried input (`0` = no bound) |
| `maxQueueItems` | `20` | Message bound on carried input (1–200) |
| `checkRelayModel` | `true` | Check that the route the continuation's first request will actually carry resolves |
| `relayTimeoutSeconds` | `120` | How long to wait for any sign of activity (10–3600 s); silence is only reported |
| `relayProvider` | empty | Provider for the continuation session; empty inherits the one the previous session is running on |
| `relayModel` | empty | Model for the continuation session; empty inherits the previous session's model |
| `relayReasoningEffort` | empty | Reasoning effort for it; empty inherits the previous session's effort |

The page groups the fields by purpose (when to relay, the continuation session, the title, counting and detection, carried input, relay safety). An emptied number field falls back to the default; an out-of-range value is clamped on save; a checkbox applies at once; the prompt box keeps its newlines.

`promptTemplate` preserves newlines and accepts `{sessionId}`, `{count}`, `{percent}`, `{threshold}` and `{title}`; unknown placeholders stay literal. With both follow switches on, the plugin appends one marker line to the delivered prompt (`[dsh-auto-relay] from=… open=1 archive=1`) for the browser half to read; it does not change how the model reads the task, and it is absent when both switches are off.

The default prompt sends the new session to the **continuity notice at the top of its own conversation** (plugins such as `dsh-session-continuity` name the predecessor there and quote its ending or digest) rather than back into the previous session's log. Two measurements drove that choice: rebuilding context from the log cost eight to twelve extra tool calls spent locating the session file, and the tools the old default named — `session_trace`, `session_event_read` — are not installed in every profile, so the model had to improvise a decompression. Where no notice is present the prompt falls back to reading the workspace's current state (uncommitted changes, files in flight, the task list); when neither settles it, the session asks the user which single task to resume instead of widening the scope on a guess. Replace the field to use your own wording; the placeholders keep working.

Headless deployments can tune an install with `DSH_AUTO_RELAY_ENABLED`, `_THRESHOLD_PERCENT`, `_CONSECUTIVE_COUNT`, `_INCREMENT_TITLE`, `_SEPARATOR`, `_DELAY_SECONDS`, `_IGNORE_SUBAGENTS`, `_ONCE_PER_SESSION`, `_COMPRESS_TOOLS`, `_PERSIST_COUNTER`, `_SWITCH_TO_RELAY`, `_ARCHIVE_OLD_SESSION`, `_CARRY_QUEUE`, `_MAX_QUEUE_CHARS`, `_MAX_QUEUE_ITEMS`, `_CHECK_RELAY_MODEL`, `_RELAY_TIMEOUT_SECONDS`, `_RELAY_PROVIDER`, `_RELAY_MODEL` and `_RELAY_REASONING_EFFORT`. A variable applies only where the settings panel has no value for that field.

## Carried input

Anything the user types while a session is working waits in that session's own queue. On a hand-off the input still waiting travels with the task: it is transcribed into the delivered prompt in order, with an explicit note that these are instructions continuing the work rather than fresh requests to confirm.

`maxQueueChars` and `maxQueueItems` bound how much travels; the remainder stays behind and the prompt says so. The queue is taken **synchronously, at the moment of the hand-off**: it leaves the old session first, and the continuation is reserved second. That order is what closes the race — an old session only declines to open another turn once its queue is empty, so waiting for the reservation first leaves a window in which it opens one and claims a message (measured: 54 ms and one extra task). A failed reservation puts the messages back in their original order and wakes the session, so nothing typed is lost. Switching `carryQueue` off moves nothing and leaves the queue where DSH keeps it.

## When the old session stops

With `archiveOldSession` on, the handing-off session is stopped once the continuation has been reserved, so it cannot redo work that has moved. The stop follows the reservation on purpose: a reservation that failed leaves the old session as the only holder of the work, and it must keep running. A queue truncated by the bounds also skips the stop — those messages stayed behind and the session still has to handle them, which the prompt states. The stop is recorded with a `hook` cause and a reason, so the log does not read as a manual stop. To keep the old session running alongside its successor, switch `archiveOldSession` off.

## When the relay fails

Creating the successor is not the same as it running. The plugin tracks each relay session's first turn: only an **answer from the model** counts as success — an `assistant/message`, a `tool/call`, or a first turn that ends without an error. Only **an error on that first turn before any answer** is treated as a failed relay. On failure the predecessor is taken back out of the archive, the carried input is handed back to its queue, and the old session can continue — with a warning recorded.

The bar deliberately excludes `step/start` and `assistant/attempt`: both are emitted on the way to a failure. The failure actually observed ran `step/start` (+1544 ms) → a failing `assistant/attempt` (+1560 ms) → the fatal `turn/end{kind:'error'}` (+1561 ms). Counting either as success wrote the relay off as healthy one millisecond before the error arrived, so the rescue never ran.

That matches two observed failures: the successor was created and the task was delivered, but its very first model call rejected — once because the model name no longer resolved (`UNKNOWN_MODEL`), once because the route had no credential (`MISSING_CREDENTIAL`) — by which time the old session had already handed the work over.

`relayTimeoutSeconds` is only a waiting bound: exceeding it with no activity records a note and **never** rolls anything back — the relay may simply be waiting for the delivery floor, and undoing a healthy hand-off would be worse than saying nothing.

Before creating anything the plugin also asks the LLM registry whether **the route the successor's first request will actually carry** resolves: the configured one when a pair is set, otherwise the profile default, because that is what the first call hits. A route that cannot resolve skips the hand-off with a warning instead of creating a session that is certain to fail. Only a definite resolution failure blocks it: a missing registry, a missing selection, or a probe that fails for any other reason relays as usual (`checkRelayModel` turns the whole check off).

## Which model the continuation runs on

The relay task cannot carry a model — `new_once` accepts only a working directory and an agent preset, so the successor would be created on whatever the profile's default model is. That is the entry point of the failure: when the default names a model the provider has retired or not enabled, the new session dies on its very first call (`UNKNOWN_MODEL`), and a relay is by definition the continuation of one piece of work, so it belongs on the model that has been doing that work.

So these three fields **inherit the route the previous session is running on** when left empty: provider, model, and reasoning effort all come from the header the handing-off session recorded (falling back to its last resolved request context). That order is measured, not guessed — `request/header` carries `reasoningEffort` and `request/context` does not, so the header is read first.

Filling in `relayProvider` and `relayModel` (optionally `relayReasoningEffort`) pins that route onto the successor the instant the session is created: the plugin hooks `agent/created`, which the agent factory awaits after the session is entered but before the loop's first turn, so the selection is in the log before any request is built. The pin uses `agent.model.select`, so it **does not** rewrite your global default model — that belongs to the model picker, not to a relay plugin acting on your behalf.

That hook is the mechanism, not an optimisation. `model/selection` only affects the **next** request — the projection records it as pending until the following `request/header` retires it — and the successor goes from creation to its first request in about 1.5 seconds. The earlier approach (wait for the session to appear, then select) landed 4 milliseconds after the very `request/header` it was supposed to prevent, so the first call still ran on the wrong model. The polling path is kept as a second net for a session the hook somehow never saw.

Half a pair is not a choice: an incomplete route pins nothing and the inherited route is used.

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
- Carried input, the model pre-flight and the failure rollback depend only on DSH's own `agents`, `llm` and `workspaceRegistry` services. Any of them missing degrades the matching capability — nothing is carried, the pre-flight is skipped (the relay proceeds), the rollback cannot run (warnings are still recorded).
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
