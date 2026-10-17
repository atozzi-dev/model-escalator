# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] - 2026-10-17

### Added

- Cheaper-model advice: `/escalator stats` and the statistics panel suggest one tier down for task categories that never get stuck (at least 8 recent runs, almost no escalations or rejected runs, and no evidence that the cheaper tier fails them), with an estimated cost per run. Nothing changes on its own. Only evidence from the cheaper model's own runs (senior reviews, `verifyCommand`, no rework by the lead) counts as measured quality, and only those suggestions are marked strong and shown once per session in `/escalator`. Without it a suggestion says that quality is not measured yet and which check would notice a drop after the switch, or, for read-only work such as reviews and audits, that the mod cannot tell whether the cheaper model would do as well.
- `/escalator` shows the lead's (main conversation) cost apart from subagents and teammates, in the report, the panel and `/escalator export session`: the mod never changes the lead's model, so this is the part only delegation can save.
- `/escalator` and the panel show the session total Claude Code reports next to what the mod metered (requests Claude Code makes on its own do not pass through the mod).
- `/escalator replay sweep option=values ...` replays the recorded sessions over a grid of options (ranges like `2..5`, lists like `3,4,6`, at most 200 combinations) and ranks them by possible false positives, weighted by level, and stuck agents caught.

### Changed

- Task categories are picked from the agent type, the task description and the start of the prompt, with new `review` and `feature` labels, so far fewer runs end up in `other`. Stats already stored keep their old labels.
- With `modelCategories` on, subagents no longer wait for the model label: they start on the keyword category, the label is applied in the background and cached, and the end of a run waits for it at most 3 seconds.
- `/escalator stats`: "1 run" in the singular, steady decayed counts, and lines grouped by agent type with the most expensive first.
- README: the status line points to the changelog for the version and says that the savings are not yet measured with the A/B evals.

## [1.2.0] - 2026-10-16

### Added

- `/escalator export [session|learned|history|all]` prints this session's costs and savings per category, the learned statistics per category and model (with review scores), or the session history as CSV tables to paste into a spreadsheet. It only reads the mod's own store.

### Changed

- The agent map and the statistics panel are easier to read in a side pane: the map is a vertical tree that fits the pane width, with full names (always in the tooltip), larger text, what each agent is doing instead of a generic "thinks", a footer legend and edges routed around the cards; the panel right-aligns numbers and wraps long lines instead of cutting them.

## [1.1.0] - 2026-10-16

### Added

- README section on getting work delegated: example prompts, when not to delegate, and a `CLAUDE.md` snippet that makes delegation the default for multi-part work.
- A/B evals: the runner keeps every run away from your learning store (a private config folder with `CLAUDE_CODE_OAUTH_TOKEN`, or the store moved aside) and keeps an installed copy of the mod out of the runs; three harder cases (`async-cache-ttl`, `invoice-rounding`, `semver-range`).
- The detector notices a shell command that exits 0 but prints the same failure again after the agent changed the command or edited a file (for example a check piped through `tail`), and raises the difficulty score by half a point per repeat; commands that only read (`cat`, `grep`, `git diff`, ...) never count. Recordings keep a hash of such outputs, so `/escalator replay` scores them too.

### Changed

- The senior consult dossier shows the output of a command that exited 0 but reported a failure, instead of a bare "ok".

### Fixed

- The desktop app draws mod panes as of Claude Code 2.1.300: the README and the hints of `/escalator map` and `/escalator panel` in a session without panes now point to the desktop app or a terminal (the VS Code integrated terminal works too).

## [1.0.0] - 2026-10-12

### Added

- Plugin options for the difficulty thresholds, grace steps, edit oscillation count, senior model, enabled escalation levels, prudent token ratio and price overrides; defaults are unchanged.
- Edit oscillation: editing the same file again and again without progress now raises an agent's difficulty score.
- Test output is parsed run by run (jest, vitest, pytest, go test, cargo test and plain "N failed, M passed" summaries): a loop that repeats a failing test in one command, or a command that hides the failure behind a trailing exit marker, now weighs like separate failing attempts.
- Optional `verifyCommand` and `verifyTimeoutSeconds` options: the mod runs your check (for example a test command) at the end of each tracked agent's run, and a failed check counts against that model for that kind of task when learning. A check that cannot start or times out is not counted against the model.
- Agents that keep making model requests without any progress now climb the escalation ladder too, after a generous number of requests.
- Agents that go silent for `stallMinutes` (default 10) are reported in the log, the status line and a toast, and get a note on their next tool call; a tool call still running counts as activity for three times that window.
- `ask_for_help` tool: a tracked agent that is stuck can ask for the senior consult directly, once per grace window; in observe mode the request is only logged.
- Sampled senior review (`reviewRate`, off by default): a share of the runs of cheaper models gets its diff reviewed by a senior model against a short rubric; the 1-5 score is stored per category and shown by `/escalator stats`. Reviews count against `consultBudgetUsd`.
- Eval runs can set the mode and the reference model through `EVAL_MODEL_ESCALATOR_MODE` and `EVAL_MODEL_ESCALATOR_BASELINE`, since `claude plugin eval` only forwards `EVAL_*` variables; the plain variables win when both are set.
- `explore` option (0 to 1, off by default): sometimes starts a task on the cheaper model that learning had ruled out, using Thompson sampling, never below the requested model; `observe` mode only logs what it would explore.
- Learning judges each run as accepted or not: not escalated, passed `verifyCommand` if set and, when reviewed, scored at least `minReviewScore` (default 3); a review that lands after its run moves it to not accepted once.
- `learnByCost` option (default on): once it has enough priced runs, a task starts on the model with the lowest cost per accepted run, otherwise the failure-rate rule applies; the log says `chosen by cost per accepted run`. `/escalator stats` shows the mean cost per run and per accepted run where known.
- Rework rate (`reworkWindowMinutes`, default 30, 0 is off): when the lead edits, within the window, a file a cheaper agent wrote, that run is moved to not accepted for learning, counted as `reworked` in `/escalator stats` and logged once.
- `/escalator map` opens a live map of the agent network (lead, workers and senior with their models, actions, levels and costs) in a panel on the desktop app, VS Code and mobile; the terminal shows a short note for now.
- Optional model-based task categories (`modelCategories`, off by default): a small model labels each new subagent task (including feature and review work the keywords cannot see), the label is cached, and learning works per label. It adds one short call to uncached spawns; its cost is not counted in the report.
- Learning keeps a small statistics table per project (hashed working directory, at most 30) next to the global one; a project's own evidence decides the starting model once it has enough runs, otherwise the global table applies. `/escalator reset` clears both.
- `respectExplicitModel` option (off by default): when on, a model named in the Agent call is not raised or explored away by learning, and the log notes what learning suggested; the escalation ladder still applies when the agent is stuck.
- `/escalator help`, `/escalator config` (effective options marked when changed, plus mode and baseline sources) and `/escalator history [n]` (recent session summaries); `/escalator reset history` clears the session history.
- `/escalator stats` shows this session's savings per task category (real cost, savings against the strong model, escalations per agent).
- On a subscription, `/escalator` shows a "Plan usage" block with the plan windows Claude Code reports (five-hour, seven-day) and the ladder's estimated saving for the session.
- `/escalator panel` opens a panel with the session cost and savings, plan usage, savings per task category and the learned statistics, refreshed at most once a second while it is open; `/escalator panel close` closes it.
- Map: select an agent with the buttons under the drawing to see its detail (category, tiers, state, difficulty, cost, interventions, last failed attempts) and use Consult now and Swap now; the same actions are available as `/escalator consult <id>` and `/escalator swap <id>`.
- `recordSessions` option (off by default): records what the mod observed in the last N sessions (derived features, hashed signatures and short redacted text, size-capped) in the plugin store; `/escalator reset recordings` clears them.
- `/escalator replay [option=value ...]` replays the recorded sessions with other thresholds, grace steps or levels, without model calls, and compares interventions, possible false positives and a self-check against what happened.
- Seven A/B eval cases (easy to hard) with hidden acceptance tests, tamper-proof test checks and a quality judge, to compare the escalation ladder against an all-strong-model baseline.
- `scripts/ab-run.mjs` runs the A/B eval cases where `claude plugin eval` cannot grant Bash (Windows): a fresh copy of the mod per run, the same graders, and the same result format, so `ab-compare.mjs` reads it unchanged. The agents' shell is not sandboxed.
- `scripts/ab-compare.mjs` compares the baseline and active A/B eval results per case (score, spread, cost, verdict) and can write the table as Markdown; CI runs its tests.
- Learned evidence fades over time (`learningHalfLifeDays`, default 30, 0 never forgets), and `/escalator stats` shows readable counters with the age of each entry instead of raw JSON.
- Notice in the main conversation, read by the lead, when an agent is swapped to a stronger model, its swap target is unavailable, or it needs a human (option `notifyLead`, on by default, at most 10 per session).
- Optional effort step (`effortStep`, off by default): before a model swap, a stuck agent keeps its model and its requests carry a higher effort (one step up, at least `effortBoost`); skipped for models without effort, dropped after a swap, not counted as an escalation for learning.
- Optional de-escalation: with `deescalateAfter` set, an agent that was swapped to a stronger model goes back one tier after that many progress signals, at most once per run (off by default).
- An agent that reaches the human level is paused: its further tool calls, `ask_for_help` included, are refused until you resume it with `/escalator resume <id>` (or `resume all`). `/escalator` lists paused agents; the `pauseAtHuman` option (default on) turns the pause off.
- `modelIds` option and broader model id recognition, so swaps pick the right ids on Amazon Bedrock, Vertex and gateways.
- Swap targets the account does not allow are handled: the step is sent again on the previous model, that model is not tried again in the session, the agent moves to the human level with a notice, and a refused senior model is skipped for consults.
- Senior consults are capped per agent (`maxConsultsPerAgent`, default 3), per session (`maxConsultsPerSession`, default 20) and by dollar budget (`consultBudgetUsd`, default off); a stopped consult falls through to the next ladder level.

### Changed

- New detector defaults, calibrated on observed runs: `thresholdSonnet` 5, `thresholdOpus` 7, `oscillationEdits` 5, and an idle allowance of 60 requests at 0.1 points each.
- The same failure from parallel calls of one assistant message counts once, a failing test count that goes up (writing tests first) adds nothing, and oscillation counts only edits made after a failed attempt.
- With many simultaneous agents the mod writes its session state less often: tool calls that only move counters are batched to one write per second, and the agent map no longer rewrites the state on every redraw.
- The agent map also works in the terminal: `/escalator map` shows a coloured text tree with an animated spinner on working agents.
- Log lines, the paused list and lead notices name an agent by its spawn name and show the task it claimed from the shared task list.
- The senior consult receives the full text of recent failed attempts (hidden failures included), the files the agent touched and the output of a read-only `git diff --stat`, all capped and with obvious secrets redacted.
- A refused senior consult is retried once on the other senior model with a shorter dossier; if that is refused too, the next ladder step is due immediately instead of after a grace window.
- Senior consults are priced from the token usage their reply reports instead of an estimate from text length; the estimate remains as a fallback.
- The escalation ladder keeps swapping an agent one model up (Haiku, then Sonnet, then Opus) before asking a human. The new `maxTier` option (default `opus`) caps how high a swap may go.
- Fork subagents keep their model and prompt and are no longer tracked, nudged or escalated.
- The nudge note now reads "You are not making progress...", so it fits repeated failures, idle loops and stalls alike.

### Fixed

- An agent spawned without a name is labelled by its task description on the map, in the logs and in `/escalator` commands, instead of by its category or raw id.
- Calls that Claude Code refused before running them (permission rules, auto mode, hooks, a worktree guard, stale or unread files, a blocked sleep) no longer count towards an agent's difficulty score; recordings mark them.
- Test summaries of `bun test` (and `claude plugin test`) are read, so failing counts and progress work in bun projects.
- No stall is reported while the session is closed or the account is at its usage limit.
- `/escalator map` and `/escalator panel` say when the session has no surface that draws mod panes (for example the VS Code extension) instead of reporting a pane as opened.
- A paused agent can still hand back its report and use `SendMessage` and the task-list tools, so the human-level summary reaches the lead; `/escalator resume` reminds you to message an agent that already ended its turn.
- A slow command that is still running and then succeeds no longer earns the agent a "not making progress" note; the stall is only reported to the lead.
- Agents already on the top model no longer get a swap step or a false "you run on a stronger model" note.
- Learned statistics no longer lose updates when several agents finish at the same time: all store writes go through a single queue.
- `MODEL_ESCALATOR_BASELINE` now stays the reference model instead of being overwritten by the lead's model on every request.
- Hot model swap now sends a full model id (the one seen in the session, else the current default) instead of the bare alias, which the API rejected with a 404.
- The senior consult now has a 2000-token cap and logs the reason and token usage to the debug log when it returns no advice.
- Savings estimate now uses verified Haiku 5.5 prices, its long-context rates, and the cache write price of each loop (1-hour for the main loop, 5-minute for subagents and teammates).
- Supervisor notes are now tagged with a per-session id announced in the subagent's prompt, so agents can tell them from injected text and follow them.
- The savings ledger, tracked agents and supervisor tag are kept when Claude Code reloads the plugin mid-session.
- The repetition nudge asks the agent to pause and continue with a different approach instead of saying "Stop", which a teammate read as a stop order.

## [0.1.0] - 2026-10-09

### Added

- Difficulty detector: repeated error signatures, failing test counts, per-model thresholds, grace window between interventions.
- Escalation ladder: nudge and senior consult delivered through the tool result `context`, hot model swap in `turn.step`, stop and hand back to the user.
- Basic learning: start task categories that escalate too often on a stronger model.
- Modes: `active`, `observe`, `baseline`, `off`.
- Cost metering from per-request usage, savings estimate, status line, `/escalator` command, session history.
- A/B eval skeleton.
