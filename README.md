# model-escalator

model-escalator is a [Claude Code](https://code.claude.com) mod that runs subagents and in-process teammates on cheaper models and watches them. When one gets stuck (the same error again and again, failing tests that do not improve) it intervenes one step at a time: a nudge; a one-off consult with a senior model whose advice goes back to the agent; a hot swap that moves the same agent one model tier up and keeps its context; and finally a stop that hands control back to you. It also learns which model to start each kind of task on, and it meters what the work costs against the same work on your lead's model. The savings are estimates from API list prices, not guarantees: escalations and consults are part of the real cost, so a session can come out worse than the baseline.

Status: early release (see [CHANGELOG.md](CHANGELOG.md) for the current version). The detector's defaults are calibrated on real sessions, but the savings have not yet been measured with the A/B evals in `plugin/evals/`: treat the reported figures as estimates. Start with `observe` mode on a real project (see [Quick start](#quick-start)).

## Requirements and installation

Requires Claude Code 2.1.287 or later.

From the marketplace in this repository, inside Claude Code:

```
/plugin marketplace add atozzi-dev/model-escalator
/plugin install model-escalator@model-escalator
```

For development, clone the repository and load the mod from its root (it reloads when the files change):

```
claude --plugin-dir ./plugin
```

Mods are not sandboxed: they run with your permissions. To see what the mod hooks and calls without running it, clone the repository and run `claude plugin validate plugin`; the output is listed in [What it touches](#what-it-touches).

## Quick start

After installing, nothing needs configuring. The mod runs in `active` mode: it tracks every subagent and in-process teammate, leaves your lead model alone, and intervenes only on the agents it sees get stuck. Within a session:

- `/escalator` shows the session cost, the estimated savings and the interventions so far; once per session it adds a one-line hint when a task category runs on a stronger model than it seems to need.
- `/escalator map` opens the live map of agents (picture below).
- `/escalator panel` opens a panel with the session at a glance and what the mod has learned; `/escalator stats` prints the learned statistics as text.

For the first days on a project, measure before letting it act. Start Claude Code with the mode set to `observe`, which logs what the mod would do without intervening:

```bash
MODEL_ESCALATOR_MODE=observe claude          # bash, zsh, Git Bash
```

```powershell
$env:MODEL_ESCALATOR_MODE = "observe"; claude   # PowerShell
```

Compare the log with what actually happened, then switch to `active` by unsetting the variable.

## Modes

The mode is read from the `MODEL_ESCALATOR_MODE` environment variable when the session starts. Unknown values fall back to `active`.

| Mode | Effect |
|---|---|
| `active` (default) | Intervenes: nudges, consults, swaps, pauses, and learns from the outcome of each run |
| `observe` | Measures and logs what it would do, without intervening. Recommended for the first days |
| `baseline` | Every subagent starts on the reference model. No interventions, no learning, no exploration. This is the control arm of the A/B evals |
| `off` | Passes everything through; no agent is tracked |

`MODEL_ESCALATOR_BASELINE` sets the reference model, used for the savings figures and by `baseline` mode. It accepts an alias (`opus`) or a full model id. When it is not set, the reference is the lead's model.

`claude plugin eval` forwards only variables that start with `EVAL_`, so the mode and the reference can also be given as `EVAL_MODEL_ESCALATOR_MODE` and `EVAL_MODEL_ESCALATOR_BASELINE`. The plain variables win when both are set.

## How the ladder works

Each tracked agent has a difficulty score. It grows when the agent repeats the same failing command or error, when it keeps failing tests without progress, when it edits the same file again and again between failed attempts (`oscillationEdits`), when a shell command exits 0 but prints the same failure (`FAIL`, `Error:`, a traceback) again after the agent changed the command or edited a file (commands that only read, such as `cat`, `grep` or `git diff`, never count), and when it makes many model requests without progress. Progress (for example failing tests dropping) resets it. Test summaries of jest, vitest, pytest, go test, cargo test and bun test are read. Some results never count: a call that Claude Code refused before it ran (a permission rule or prompt, the auto mode classifier, a hook, a stale or unread file, a blocked `sleep`), the same failure repeated by the parallel calls of one assistant message, and new failing tests added while writing tests first (a failing count that goes up).

When the score reaches the threshold of the agent's starting tier (`thresholdHaiku`, `thresholdSonnet`, `thresholdOpus`) and `graceSteps` steps have passed since the last intervention, the next enabled level fires:

1. **nudge**: a note asking the agent to pause, re-read the last error in full and continue with a different approach;
2. **consult**: one call to the senior model (`seniorModel`, default `opus`) with a dossier of the agent's recent attempts; the advice reaches the agent with its next tool result;
3. **effort** (off by default, see `effortStep`): the same model with a higher effort;
4. **swap**: the same agent continues one tier up (Haiku, then Sonnet, then Opus), up to `maxTier`, keeping its context;
5. **human**: the agent is paused (its further tool calls are refused) until you resume it with `/escalator resume <id>`, or the pause is left as a note with `pauseAtHuman` off.

Agents that already run on the highest allowed tier skip the swap. `levels` removes levels from the list; the effort level is controlled by `effortStep` only.

Learning is separate from the ladder. A run is accepted when it was not escalated, passed `verifyCommand` if one is set, and (when reviewed) scored at least `minReviewScore`. For each task category the mod starts new agents on the requested tier and moves the start one tier up while that tier fails (is not accepted) in more than 40% of at least 5 runs; once there is enough priced data, it picks the tier with the lowest cost per accepted run instead (`learnByCost`). Evidence fades with `learningHalfLifeDays`.

Some features are off by default because they change cost or behaviour in ways the A/B evals have not yet confirmed:

- `effortStep`: a higher effort costs more output tokens, and changing it rewrites the prompt cache.
- `deescalateAfter`: returning to a cheaper model rewrites the prompt cache and may bring the block back.
- `explore`: deliberately runs some tasks on a model learning had ruled out; some tasks should not run on a weaker model.
- `reviewRate`: each sampled review is one senior call.
- `modelCategories`: adds one background classification call per uncached spawn (the spawn does not wait for it), and its cost is not in the report.
- `respectExplicitModel`: the mod cannot tell a model you asked for from one the lead chose, and lead agents often name a cheap model; correcting that choice is what learning is for.

## Getting work delegated

The mod acts only on subagents and in-process teammates. It never changes your main conversation, so when Claude Code does all the work itself on the lead model there is nothing to escalate, and the mod can only measure the cost. Delegation is what makes the savings possible, and Claude Code does not always delegate on its own: for a multi-part request, ask for it explicitly.

Prompts that work well:

- "Split this feature into independent parts (the parser, the validator and the tests), and hand each part to a subagent on haiku. Review their results before you finish."
- "Run the test suite and fix the failing tests in a background subagent on haiku. Tell me when it is done."
- "Add a CSV export to the reports page. Use one subagent for the backend and one for the tests, both on sonnet, and integrate the result yourself."

Not every request is worth delegating. A one-file edit is faster done directly, so for a small change ask Claude Code to do it itself:

- "Rename `userId` to `accountId` in `src/auth.ts`. Do it yourself, without subagents."

Naming a model in the request is fine: the ladder still escalates a stuck agent. The option `respectExplicitModel` (off by default) only decides whether learning may change the starting model of an agent whose Agent call names one; when it is on, the named model is kept and the ladder still applies.

To make delegation the default for multi-part work in one project, paste this into the project's `CLAUDE.md`. Claude Code reads it when a session starts, so start a new session after the change:

```markdown
## Delegation

For a request with two or more independent parts (several modules, pages or files that do not depend on each other's unwritten code):

- write a short plan first;
- hand each part to a subagent with the Agent tool, on `haiku` for routine work and `sonnet` for parts that need judgement;
- give each subagent a self-contained prompt: the files to touch, the interface to keep, and how to check the result;
- keep the integration and the final verification yourself.

Do not delegate questions, explanations, changes to one or two files, or tightly coupled work: do those yourself.
```

The rule applies to every request in that project, so keep the last paragraph: without it, small requests get split into subagents too, which costs more than doing them directly.

## Commands

These are the subcommands listed by `/escalator help`:

| Command | Effect |
|---|---|
| `/escalator` or `/escalator report` | Session cost, estimated savings and interventions (the default) |
| `/escalator stats` | What the mod has learned per task category, the review scores of sampled runs, cheaper-model suggestions for categories that never get stuck, and this session's savings per category |
| `/escalator config` | The effective configuration and the environment mode, with the variable each value came from |
| `/escalator history [n]` | The last `n` recorded sessions (default 10, at most 50) |
| `/escalator export [session\|learned\|history\|all]` | This session's costs, the learned statistics or the session history as CSV tables (default `session`), printed as text to paste into a spreadsheet; reads the plugin store only |
| `/escalator map` | Open the live network of agents |
| `/escalator panel [close]` | Open (or close) a panel with the session, plan usage, savings per category and learned statistics |
| `/escalator consult <id>` | Ask the senior model about an agent now; the advice reaches it on its next tool call. Active mode only |
| `/escalator swap <id>` | Move an agent one tier up, from its next request (the map's detail buttons do the same). Active mode only |
| `/escalator resume <id>\|all` | Resume agents paused at the human level |
| `/escalator replay [option=value ...]` | Replay the recorded sessions (`recordSessions`) with other options and compare with what happened, without any model call. See [Replaying sessions](#replaying-sessions) |
| `/escalator reset` | Forget the learned statistics (the session history and the task category cache are kept) |
| `/escalator reset history` | Clear the recorded session history |
| `/escalator reset recordings` | Clear the session recordings kept for replay (`recordSessions`) |
| `/escalator help` | List the subcommands |

`<id>` is the agent's id or its name. An unknown subcommand shows the list.

### The agent map and the stats panel

`/escalator map` draws the lead, every worker and the senior model, each with its model, what it is doing, its difficulty level and its cost, and the escalations and consults between them. In Claude Code in a terminal it is a coloured text tree with a spinner on working agents; in the desktop app (Claude Code 2.1.300 or later) it is an animated SVG; the VS Code extension does not draw mod panes as of 2.1.296, so use its integrated terminal (see Limitations). The command says which surface it used, or that the session has none. Selecting an agent with the buttons under the drawing shows its detail (category, tiers, state, difficulty, cost, interventions, last failed attempts), with Consult now and Swap now buttons in active mode.

![Example agent map: the lead on Opus, three workers on Haiku, Sonnet and Opus, a consult to the senior model and a swap from Haiku to Sonnet](docs/agent-map.svg)

The example is a fictional session drawn by the mod's own renderer (`plugin/hooks/render-svg.ts`). The map is a vertical tree sized for a side pane: it scales down in a narrower pane, and hovering an agent shows its full name, model and figures. `/escalator panel` shows the same figures as text and boxes, with numbers aligned in columns, refreshed about once a second while the panel is open.

## Configuration

Options are set from `/config` or under `pluginConfigs` in your settings (key `model-escalator`). A change applies after the mod reloads. An invalid value falls back to the default, and values outside their range are clamped or ignored as noted. `/escalator config` shows every value in force and marks the ones that differ from the default.

| Option | Default | Meaning |
|---|---|---|
| `thresholdHaiku` | 3 | Difficulty score at which an agent that started on Haiku gets its next intervention |
| `thresholdSonnet` | 5 | The same, for an agent that started on Sonnet |
| `thresholdOpus` | 7 | The same, for an agent that started on Opus |
| `graceSteps` | 4 | Steps to wait after an intervention before the next one |
| `oscillationEdits` | 5 | Edits of the same file made after a failed attempt, without progress, tolerated before each further such edit raises the score. Edits with no failure in between never count |
| `stallMinutes` | 10 | Minutes without any event after which a running agent is reported as stalled (log, status line, toast in active mode); its next tool call gets the next ladder note. A tool call still running counts as activity for three times this long. Nothing is reported while the session is closed or the account is at its usage limit |
| `verifyCommand` | empty (off) | Check run at the end of each tracked agent's run, for example `npm test`. Split on spaces, quotes group, no shell: no pipes or redirects. A non-zero exit counts as a failed run for learning. See the note below |
| `verifyTimeoutSeconds` | 120 | How long the check may run before it is abandoned and ignored (at most 600) |
| `reviewRate` | 0 (off) | Share of the finished runs of cheaper models that a senior model reviews, from 0 to 1 (`0.1` is about one run in ten). Each review is one senior call |
| `reviewModel` | empty (senior) | Model that reviews a sampled run, alias or full id |
| `seniorModel` | `opus` | Model asked for advice at the consult level, alias or full id |
| `levels` | `nudge,consult,swap,human` | Comma-separated enabled levels; disabled ones are skipped (`nudge,swap,human` turns the consult off) |
| `maxTier` | `opus` | Highest tier a swap may reach: `haiku`, `sonnet` or `opus` |
| `prudentTokenRatio` | 0.65 | Share of the tokens a stronger baseline model is assumed to need, between 0 (exclusive) and 1; used for the prudent end of the savings estimate |
| `prices` | empty (built-in) | JSON overriding USD per million tokens per model, e.g. `{"sonnet":{"input":3,"output":15}}`. Rates: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` |
| `modelIds` | empty (built-in) | JSON with the full model id to send on a swap, per tier, e.g. `{"sonnet":"us.anthropic.claude-sonnet-..."}`. Needed on Bedrock, Vertex or a gateway when a swap reports the model as not available |
| `maxConsultsPerAgent` | 3 | Senior consults one agent may get; a refused call and its retry count as one. `0` allows none |
| `maxConsultsPerSession` | 20 | Senior consults across all agents of the session, counted the same way. `0` allows none |
| `consultBudgetUsd` | 0 | Dollars the senior calls (consults and reviews) may cost in the session; `0` means no dollar limit |
| `pauseAtHuman` | true | Refuses all further tool calls of an agent at the human level, until you resume it. Off keeps the note only. Active mode only |
| `notifyLead` | true | Adds a short notice to the main conversation (read by the lead) when an agent is swapped up, cannot be swapped, or needs a human. At most 10 per session. Active mode only |
| `deescalateAfter` | 0 (off) | Progress signals (failing tests dropping or reaching 0) after which a swapped agent goes back one tier, once per run. `observe` only logs it |
| `effortStep` | false | Adds an effort level between the consult and the swap: the agent keeps its model and its requests carry a higher effort until its next swap. `observe` only logs it |
| `effortBoost` | `high` | Lowest effort the effort level raises a request to: `low`, `medium`, `high`, `xhigh` or `max`. A request always goes at least one step up |
| `learningHalfLifeDays` | 30 | Days after which learned evidence counts half; `0` never forgets |
| `learnByCost` | true | Once a category has enough priced runs, start it on the model with the lowest cost per accepted run, if that beats the failure-rate choice by more than 10%. Off keeps the failure-rate rule only |
| `minReviewScore` | 3 | From 1 to 5: a sampled run reviewed below this score counts as not accepted for learning |
| `explore` | 0 (off) | From 0 to 1: how often a task starts on a cheaper model that learning had ruled out, to check whether it became good enough. Never below the model the task asked for. `observe` only logs it |
| `respectExplicitModel` | false | When on and the Agent call names a model, learning and exploration do not change the starting model. The ladder still applies |
| `modelCategories` | false | Refines the task category of each new subagent with one short call to a small model (Haiku) on top of the keyword category (agent type, description and the start of the prompt). The agent starts at once on the keyword category; the label is cached and used for recording the run and for later spawns. A failed call keeps the keywords |
| `reworkWindowMinutes` | 30 | Minutes after a cheaper run during which an edit by the lead to a file that run wrote counts as rework: the run is moved to not accepted once. `0` turns it off. Only edits made through Claude Code are seen |
| `recordSessions` | 0 (off) | Records what the mod observed in each session and keeps the last N sessions (at most 50), so `/escalator replay` can try other options on them. Works in every mode except `off`, `observe` included. See [Session recordings](#session-recordings) |

`verifyCommand` runs without a shell, so on Windows give the real executable: `npm.cmd test`, or `node node_modules/jest/bin/jest.js`. On Windows `bash` usually resolves to the WSL launcher (`C:\Windows\System32\bash.exe`); use the full path of Git Bash instead. A command that cannot start or hits `verifyTimeoutSeconds` is not counted as a failed run. Check the command once by hand first: a command that starts but fails for an unrelated reason counts as a failed run.

## Session recordings

With `recordSessions` above 0 the mod records, for each agent it follows, the stream its detector reads: the spawn (task category, requested and starting tier), each tool result as features (tool name, number of failed attempts, a hash of the error signature, the failing count of each test run, a hash of the edited file and, for a shell command that exited 0 but printed a failure, a hash of its normalised output and of its command line), each model request (tier, effort, token usage), the ladder actions taken (marked as logged only in `observe`), consults and their cost, help requests, stalls, de-escalations, refused models, manual consults, swaps and resumes, the end of each run (escalated or not, aborted) and its outcome when known (verification, review score, rework). Times are kept as milliseconds since the session started.

Privacy: the only text kept is the agent's name (redacted, at most 40 characters) or its task category, and the text of up to 300 error signatures per session (the normalised first 160 characters of the error, with numbers and file paths replaced, then redacted with the same patterns as the senior dossier). Commands, tool output, prompts, advice and file paths are never kept; files, error signatures, and the outputs and commands of shell calls that exited 0 but printed a failure are compared through a hash. Redaction is pattern based, so treat the recordings like the rest of the plugin's store.

Size: one session is capped at 256 KiB of JSON text; a longer session drops its oldest events first, counts them, and marks the agents that lost events. All recordings together are capped at 1.25 MiB (the store holds 4 MiB in all); the oldest sessions go first. Fifty agents with eight events each take about 35 KiB. Recording appends in memory only: the store is written at the end of an agent's run (at most once every 5 seconds), every 30 seconds while agents run, and when the session ends. A reload of the mod keeps the recording but loses the events since its last write. `/escalator reset recordings` clears them.

### Replaying sessions

`/escalator replay` runs the recorded sessions through the same detector and ladder code with the options in force, changed by the `option=value` pairs you give, for example `/escalator replay thresholdHaiku=4 graceSteps=6 levels=nudge,swap,human`. It accepts `thresholdHaiku`, `thresholdSonnet`, `thresholdOpus`, `graceSteps`, `levels`, `effortStep`, `effortBoost`, `maxTier`, `oscillationEdits`, `idleSteps`, `idleWeight`, `stallMinutes`, `maxConsultsPerAgent`, `maxConsultsPerSession`, `consultBudgetUsd`, `deescalateAfter` and `pauseAtHuman`, with the same validation as the options; an invalid value or another option is refused with the list. It makes no model call and changes nothing.

The output compares the recorded interventions with the candidate's, per level and per task category, counts escalated runs, lists possible false positives (agents that finished well with no intervention but that the candidate would hit) and the agents that differ most, with the tool result at which each action fires. A self-check replays each session with the options it was recorded with and reports how many recorded interventions it reproduces; `/escalator replay` with no option shows the options in force against the recording.

Limits: the replay does not simulate the models. After an intervention each agent does what it did in the recording, so a note, consult or swap that comes earlier or later would have changed what followed; read the results as where the ladder would fire on the same work, not as outcomes. The start tier chosen by learning, verifications and reviews are not run again; consult answers are reused in order. Sessions recorded in `observe` or `baseline` mode replay as `observe`. Agents whose recording is incomplete (trimmed, cleared or interrupted by a reload) are skipped.

## How savings are estimated

Real spend comes from the token usage each model request reports, priced at API list prices. The reference prices the same requests on the lead's model, in an optimistic version (same tokens) and a prudent one (a stronger model would have needed fewer tokens). Escalation costs (steps wasted before a swap, cache rewrites, consults, reviews) are part of real spend, so the saving can be negative, and the report says so. On a subscription, read the figure as the share of usage limits saved: `/escalator` then also shows a "Plan usage" block with the plan windows Claude Code reports, next to the estimate from API prices, which is not a reading of the plan limits. With API billing there are no plan windows and the block is left out.

## What it sends to the senior model

A consult sends one dossier to the senior model, through the same provider as your session. It contains: the task (first 2000 characters), the agent's tier and interventions so far, its recent attempts (up to 12, oldest first, each with the tool, a short summary of its input and the outcome; error text capped), the files it touched (up to 20), the output of `git diff --stat` in the project folder, and, when the agent asked for help itself, the problem and the attempts it described. The whole dossier is capped at 12000 characters; a retry after a refused call uses a shorter cap (6000). Obvious secrets are redacted by pattern matching first: private key blocks, `Authorization` headers, `password`, `token`, `secret` and `api key` assignments, well-known key prefixes, and long hex or base64 runs. This is a heuristic, not a guarantee; review what would leave your machine before you enable the mod on a project with secrets in its output.

A sampled review (`reviewRate`) sends the task and the diff of the files the agent edited (`git diff HEAD`, capped at 12000 characters, at most 50 files; above that, the whole working tree diff) with a short rubric, and gets back a 1 to 5 score.

## What it touches

This section lists what `claude plugin validate plugin` reports for the mod. Nothing else is read, written or called.

- **Hooks:** `session.start`, `session.end`, `agent.spawn`, `tool.call` (all tool calls, to follow the agents, and the `ask_for_help` call), `turn.step` (usage metering, and the model rewrite on a swap), `turn.complete`, `command.run` (`/escalator`), `ui.render` (the map and stats panes), `ui.close`. Hooks that can block an agent catch their own errors and let the call through.
- **Command:** `/escalator`.
- **Tool:** `ask_for_help`, registered in active and observe mode. Every agent of the session sees it, the lead included; only tracked agents get an answer, and other callers get "Help is not available for this agent."
- **Panels:** the map and the stats panel (`$.ui.open`, `$.ui.invalidate`, `$.ui.close`, `$.ui.panes`, `$.ui.resolve`, `$.session.surfaces` to tell whether the session draws panels at all).
- **UI output:** log lines, status line, toasts (`$.ui.log`, `$.ui.status`, `$.ui.toast`), and in active mode short notices in the main conversation (`$.session.append`, `notifyLead`).
- **Environment variables (read only):** `MODEL_ESCALATOR_MODE`, `MODEL_ESCALATOR_BASELINE`, `EVAL_MODEL_ESCALATOR_MODE`, `EVAL_MODEL_ESCALATOR_BASELINE`.
- **Session state:** key `model-escalator.session` (`$.state.get`, `$.state.set`): the per-agent snapshot, including recent tool summaries (file paths and command lines) and error text. It is redacted only when it is sent to the senior model.
- **Store** (`$.store.get`, `$.store.set`, `$.store.delete`): `stats` (learned counters per category and start tier), `projects` (the same per project; the working directory is stored as a hash), `sessions` (session summaries: mode, reference model, cost totals; no prompts), `adviceHinted` (when each cheaper-model hint was last shown, so it is not repeated within a week), `categories` (the classification cache: the subagent type, the first 120 characters of its description and the first 12 words of its prompt, normalised, with the label; at most 200 entries), and with `recordSessions` on, `recordings` (the last N session recordings: per-agent events as hashed features, redacted error signatures and agent labels; 256 KiB per session and 1.25 MiB in all, see [Session recordings](#session-recordings)). `/escalator reset` clears `stats` and `projects`; `/escalator reset history` clears `sessions`; `/escalator reset recordings` clears `recordings`.
- **Model calls** (`$.model.complete`, `$.model.classify`): the senior consult; the sampled review (`reviewRate`); a one-token probe of a swap target when a swap fails with an error the mod does not recognise; and the category classification (`modelCategories`, Haiku by default). Model calls go through the provider of your Claude Code session; the mod makes no network calls of its own.
- **Processes** (`$.process.run`, no shell): `git diff --stat` in the project folder at each consult; `git diff HEAD`, read only with external diff drivers and text filters off, for a sampled review; and the `verifyCommand` you set, at the end of each tracked run. The agent's output never chooses a command.
- **Plan usage** (`$.session.usage`): read only, and only shown by `/escalator` and the panel.
- **Clock** (`$.clock.now`, `$.clock.after`, `$.clock.every`, `$.clock.sleep`): redraws, stall checks and batched saves.
- **Command registration** (`$.command.register`) for `/escalator`.

The mod does not write your files and has no network access of its own.

## Interaction with other mods and plugins

These points come from the engine's documentation of hooks and from this mod's code. Running the mod together with another mod that also rewrites `model` on `agent.spawn` or `turn.step`, or that adds `context` to `tool.call` results, has not been tested.

- Hooks for an event run as a chain: each one receives the event through `next(e)` and passes on what it changes. The engine documentation does not state which plugin's hook is outermost when several plugins hook the same event, so the order of two mods is not known.
- Model rewrites: when another mod also rewrites `model`, the final model the API receives is not known from the documentation, and the mod does not check for it. The mod takes the model it is handed as the model in use, so a rewrite made before its own is recorded in its learning and savings as the model that ran.
- Notes: the mod's notes travel as `context` on tool results, and the announcement it adds to tracked prompts carries a per-session tag. Another mod's `context` on the same result is not known to be merged or dropped.
- If you run both, start with `observe` on one of them and check the log and `/escalator` figures against `/cost`.

## Evaluations

The repository includes seven A/B eval cases, comparing the escalation ladder with an all-strong-model baseline on tasks from easy to hard, with hidden acceptance tests. See [plugin/evals/README.md](plugin/evals/README.md) for how to run them; on Windows, where `claude plugin eval` cannot grant Bash, use `scripts/ab-run.mjs` (same results format, see the "Windows" section there). `scripts/ab-compare.mjs` compares the baseline and active results per case (score, spread, cost, verdict) and can write the table as Markdown: `node scripts/ab-compare.mjs baseline.json active.json`.

## Limitations

- **Requests Claude Code makes on its own** (for example prompt suggestions) are not visible to the mod. In short sessions the report's total can be up to about 15% below `/cost`.
- **Plan usage is account-wide.** The windows come from the account, not from this session alone.
- **Rework sees only the lead's edits made through Claude Code.** Edits in an editor or by shell commands are not seen. Rework tracking lives in memory: a reload of the mod forgets the runs it was watching.
- **Classification cost is not counted.** The call behind `modelCategories` returns no usage, so the report leaves it out.
- **Notes need a tool call.** A note reaches an agent only with a tool result. An agent that ends its turn without calling a tool does not see it until its next call.
- **Counters on reload.** Counters are written at most once a second when many agents are active, so a reload can lose up to about a second of them.
- **Models your organisation does not allow.** A refused swap target is not tried again in the session, the agent moves to the human level and you get a notice. A refused senior model is skipped for consults.
- **Bedrock, Vertex and gateways.** The mod learns each tier's id from the requests it sees and prefers the shape of the lead's id; for a tier it never saw it uses the first-party id. If swaps report a model as not available, set `modelIds`.
- **Supervisor notes are tagged, not hidden.** A note carries a per-session tag (`[supervisor:xxxxxx]`) so an agent can tell it from text in tool output. Text that claims to be a note without that tag is not one.
- **Panes outside the terminal.** The desktop app draws mod panes as of Claude Code 2.1.300. The VS Code extension did not as of 2.1.296: there `/escalator map` and `/escalator panel` say so instead of opening a pane nobody sees. Use Claude Code in a terminal (the VS Code integrated terminal works) or the desktop app. The mod itself, `/escalator`, `/escalator stats` and the other text commands work everywhere.
- **Savings are estimates.** They come from list prices and the token counts the requests report; they are not a bill.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the three checks (`claude plugin test .`, `claude plugin validate .`, `tsc -p .` from `plugin/`) and how changes are reviewed. Security issues: see [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
