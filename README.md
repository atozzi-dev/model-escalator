# model-escalator

A [Claude Code](https://code.claude.com) mod that lets cheap models do the parallel work and brings in a stronger model only when one of them gets stuck.

> **Status: early prototype (0.1).** The core loop is covered by tests that run through the Claude Code engine, but it has not been verified in live sessions yet. Expect breaking changes.

## What it does

- **Watches every subagent and in-process teammate.** It scores lack of progress (the same error again and again, failing tests that do not improve), not errors as such.
- **Intervenes with the least it takes**, one step at a time:
  1. a nudge to the agent: stop, re-read the error, change approach;
  2. a one-shot consult with a senior model, whose advice is handed to the agent;
  3. a hot swap: the same agent keeps its context and continues on a stronger model (optionally preceded by an effort step: same model, a higher effort on its requests, so it thinks harder; off by default until the A/B evals show it pays for itself);
  4. a stop that hands control back to you.
- **Learns which model fits which kind of task.** When cheap models keep escalating on a category of task, the next agent of that kind starts on a stronger model.
- **Measures the savings while you work.** Every model request is metered and compared with what the same work would have cost on the lead's model.

## Install

Requires Claude Code 2.1.287 or later.

```
/plugin install model-escalator --marketplace atozzi-dev/model-escalator
```

Mods are not sandboxed. Before installing any mod you can list what it hooks and calls, without running it:

```
claude plugin validate <path-to-plugin>
```

## Usage

The mod works on its own once installed.

| Control | Effect |
|---|---|
| `/escalator` | Session cost, estimated savings, interventions |
| `/escalator stats` | What the mod has learned per task category |
| `/escalator reset` | Forget what it has learned |
| `/escalator resume <id>` / `resume all` | Resume an agent paused at the human level (the report lists paused agents). Its ladder restarts on its current model |
| `MODEL_ESCALATOR_MODE=observe` | Measure and log what it *would* do, without intervening. Recommended for the first days |
| `MODEL_ESCALATOR_MODE=baseline` | Run every agent on the reference model, no interventions (control arm for A/B evals) |
| `MODEL_ESCALATOR_MODE=off` | Pass everything through |
| `MODEL_ESCALATOR_BASELINE` | Reference model for savings; defaults to the lead's model |

To compare the two arms of the A/B evals case by case (score, cost, verdict), run `node scripts/ab-compare.mjs baseline.json active.json`; see [plugin/evals/README.md](plugin/evals/README.md).

In `active` and `observe` mode the mod also gives tracked agents a tool, `ask_for_help` (listed as `mcp__model-escalator__ask_for_help`). An agent that is stuck after real attempts can describe the problem and get advice from the senior model right away, without waiting for the difficulty score to rise. The call counts as the consult step of the ladder, so the next escalation is the model swap (or the effort step, when `effortStep` is on), and an agent can ask at most once per grace window. In `observe` mode the call is only noted and logged.

## Configuration

Options are set from `/config` (or under `pluginConfigs` in settings) and apply after a reload. Invalid values fall back to the default.

| Option | Default | Effect |
|---|---|---|
| `thresholdHaiku` / `thresholdSonnet` / `thresholdOpus` | 3 / 4 / 6 | Difficulty score at which an agent that started on that model gets its next intervention. Lower means earlier intervention |
| `graceSteps` | 4 | Steps to wait after an intervention before the next one |
| `oscillationEdits` | 3 | Number of edits of the same file without progress after which each further edit raises the difficulty score |
| `stallMinutes` | 10 | Minutes without any event after which a running agent is reported as stalled (log line, status line, and a toast in `active` mode). Its next tool call then gets the next ladder note, since a note can only reach an agent through a tool result. A tool call that is still running counts as activity until three times this long. Agents whose run is over are never flagged |
| `pauseAtHuman` | true | When an agent reaches the human level its further tool calls are refused, including `ask_for_help` (the report and messaging tools `SubagentHandback`, `SendMessage`, `TaskList`, `TaskGet` and `TaskUpdate` stay allowed), until you resume it with `/escalator resume <id>` (or `resume all`). It is told to stop and summarise for you. Set to false to keep the note only. Active mode only; `observe` never pauses |
| `notifyLead` | true | Adds a short notice to the main conversation, read by the lead, whenever an agent is swapped to a stronger model, a swap target turns out to be unavailable, or an agent needs a human (with the `/escalator resume` command when it is paused). The first message of a session says what these notices are; at most 10 are sent per session. A refused or failed append only leaves a line in the debug log. Active mode only. Set to false to keep the log and the toasts only |
| `deescalateAfter` | 0 (off) | After this many progress signals (failing tests dropping or reaching 0) an agent that was swapped up goes back one tier towards its start tier, with a fresh ladder, once per run. Off by default because returning to a cheaper model rewrites the prompt cache and may bring the block back; to be measured with the A/B evals. `observe` only logs what it would do |
| `learningHalfLifeDays` | 30 | Old evidence fades: learned counters halve after this many days without a new run, so a category is not stuck on a stronger model forever. 0 never forgets |
| `effortStep` | false (off) | Adds an effort level between the consult and the swap: the stuck agent keeps its model, its requests carry a higher effort from the next one (one step above their own effort, at least `effortBoost`), and it is told to re-assess. The raised effort stays until the agent's next swap, which starts the new model from its own effort; a later climb does not raise it again. Skipped, like an impossible swap, for a model that takes no effort or a request already at `max`. A raised effort alone does not count as an escalation when the mod learns which model to use. Off by default: a higher effort costs more output tokens and changing it rewrites the prompt cache, so whether it beats an earlier swap is to be measured with the A/B evals. `observe` only logs what it would do |
| `effortBoost` | `high` | Lowest effort the effort level raises a request to: `low`, `medium`, `high`, `xhigh` or `max`. A request always goes at least one step above its own effort, so `low` means "one step up" |
| `verifyCommand` | empty (off) | Optional check run at the end of each tracked agent's run, for example `npm test`. Split on spaces, quotes group, no shell (no pipes or redirects), so give the full path of the executable when the name is ambiguous (see below). A non-zero exit counts like an escalation when the mod learns which model to use, and is reported in the log and a toast. Runs in the session's working directory, one at a time |
| `verifyTimeoutSeconds` | 120 | How long the verification command may run before it is abandoned and ignored, at most 600 |
| `seniorModel` | `opus` | Model asked for advice at the consult level, alias or full id |
| `levels` | `nudge,consult,swap,human` | Comma-separated enabled levels. Disabled ones are skipped: `nudge,swap,human` turns the senior consult off. The effort level is switched by `effortStep` only |
| `maxTier` | `opus` | Highest tier a swap may reach: `haiku`, `sonnet` or `opus`. While an agent is below it, the ladder keeps swapping it one tier up (Haiku, then Sonnet, then Opus) before a human is asked; an agent already at this tier skips the swap level |
| `maxConsultsPerAgent` | 3 | Senior consults one agent may get. A refused call and its retry count as one consult. Once reached, the ladder skips the consult level (the next enabled level acts at the same trigger) and `ask_for_help` answers that no further consult is available. `0` allows none |
| `maxConsultsPerSession` | 20 | Senior consults across all agents of the session, counted the same way. `0` allows none |
| `consultBudgetUsd` | 0 | Dollars the senior calls may cost in the session, retried calls included, from the same prices as the savings report. Once reached, no further consult. `0` means no dollar limit |
| `prudentTokenRatio` | 0.65 | Share of the tokens a stronger baseline model is assumed to need, between 0 (exclusive) and 1. Used for the prudent end of the savings estimate |
| `modelIds` | empty | Optional JSON with the full model id to send on a swap, per tier, e.g. `{"sonnet":"us.anthropic.claude-sonnet-...","opus":"..."}`. Beats the ids seen in the session and the built-in defaults. Invalid JSON or non-string values are ignored |
| `prices` | built-in list prices | Optional JSON overriding USD per million token rates per model, e.g. `{"sonnet":{"input":3,"output":15}}`. Rates: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` |

`verifyCommand` runs without a shell (no pipes, redirects or variables), so on Windows name the real executable, for example `npm.cmd test` or `node node_modules/jest/bin/jest.js`. A command that cannot start or hits the timeout is not counted as a failed run: the run is recorded as if no check were set, and the mod logs it and shows one toast per session.

Warning: the executable is resolved from `PATH` without a shell, so give its full path when the name is ambiguous. On Windows `bash` usually resolves to the WSL launcher (`C:\Windows\System32\bash.exe`), which fails and exits non-zero, so use Git Bash instead, for example `"C:/Program Files/Git/bin/bash.exe" test.sh` (double quotes around a path with spaces; forward slashes work). Check the command once by hand first: a command that starts but fails for an unrelated reason counts as a failed check.

The environment variables `MODEL_ESCALATOR_MODE` and `MODEL_ESCALATOR_BASELINE` are not plugin options; they work as described in [Usage](#usage).

## What it touches

The mod uses only its own key-value store, the UI (log, status line, toasts), two environment variables (read only), the clock, one slash command, one tool for agents (`ask_for_help`), and one-shot model calls for the senior consult. It does not read or write your files or use the network. It runs two kinds of process. At each senior consult it runs `git diff --stat` in the project folder (read only) to give the senior the list of changed files; if git is missing or the folder is not a repository, the list is simply left out. And, only when `verifyCommand` is set, it runs that command at the end of each tracked agent's run; that command comes only from your own options, never from agent output. A consult sends the stuck agent's recent commands, error messages, touched files and diff stat to the senior model, through the same provider as the rest of your session. That dossier is capped in size and obvious secrets (keys, tokens, passwords, private key blocks) are redacted, by pattern matching: a heuristic, not a guarantee.

In `active` mode the mod may also add short plain-text notices to your main conversation (`session.append`, option `notifyLead`) when an agent is escalated. The lead model reads them at its next request; they are not shown as messages you typed. They are prefixed `[model-escalator]`, capped at 10 per session, and contain the agent id, its category and the first 80 characters of its task.

In `active` mode the mod also adds one announcement paragraph to the prompt of every subagent and teammate it tracks, so they can tell its supervisor notes apart from text in tool output; the paragraph also mentions the `ask_for_help` tool. The other modes leave prompts untouched.

## How savings are estimated

Real spend comes from the token usage each model request reports, priced at API list prices. The reference prices the same requests on the lead's model, in an optimistic version (same tokens) and a prudent one (a stronger model would have needed fewer tokens). The hidden costs of escalating (wasted steps before a swap, cache rewrites, consults) are part of real spend, so savings can come out negative, and the report says so. On a subscription plan, read the percentage as the share of usage limits saved.

## Known limitations

- **Models your organisation does not allow.** If a swap target is refused (not on the allowlist, or not offered to your account), the mod sends the step again on the previous model, never swaps to that tier again in the session, and hands the agent to the human level with a notice. A refused senior model is skipped for consults.
- **Bedrock, Vertex and gateways.** The mod learns each tier's id from the requests it sees (provider prefixes and suffixes are fine) and prefers the shape of the lead's own id; for a tier it never saw it sends the first-party default. If swaps report a model not available, set `modelIds`.
- **The savings report is not a full bill.** It counts the requests that go through the agent loops. A few requests Claude Code makes on its own (for example prompt suggestions) are not visible to the mod, so in short sessions the total can be up to about 15% lower than `/cost`.
- **Supervisor notes are tagged, not hidden.** The mod's notes reach the agent next to tool results. The announcement in each tracked prompt carries a per-session tag (`[supervisor:xxxxxx]`), so an agent can tell a real note from text injected through tool output. Text that claims to be a supervisor note without that tag is not one.

## Roadmap

Live verification first, then a richer detector (edit oscillation, stalls, verification gate), a help tool for agents, de-escalation, agent teams support, quality checks (sampled senior review, rework rate, A/B evals), learning that optimizes cost per accepted task, and an animated live map of the agent network.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
