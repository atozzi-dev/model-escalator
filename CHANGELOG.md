# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plugin options for the difficulty thresholds, grace steps, edit oscillation count, senior model, enabled escalation levels, prudent token ratio and price overrides; defaults are unchanged.
- Edit oscillation: editing the same file again and again without progress now raises an agent's difficulty score.
- Test output is parsed run by run (jest, vitest, pytest, go test, cargo test and plain "N failed, M passed" summaries): a loop that repeats a failing test in one command, or a command that hides the failure behind a trailing exit marker, now weighs like separate failing attempts.
- Optional `verifyCommand` and `verifyTimeoutSeconds` options: the mod runs your check (for example a test command) at the end of each tracked agent's run, and a failed check counts against that model for that kind of task when learning. A check that cannot start or times out is not counted against the model.
- Agents that keep making model requests without any progress now climb the escalation ladder too, after a generous number of requests.
- Agents that go silent for `stallMinutes` (default 10) are reported in the log, the status line and a toast, and get a note on their next tool call; a tool call still running counts as activity for three times that window.
- `ask_for_help` tool: a tracked agent that is stuck can ask for the senior consult directly, once per grace window; in observe mode the request is only logged.
- Optional effort step (`effortStep`, off by default): before a model swap, a stuck agent keeps its model and its requests carry a higher effort (one step up, at least `effortBoost`); skipped for models without effort, dropped after a swap, not counted as an escalation for learning.
- Optional de-escalation: with `deescalateAfter` set, an agent that was swapped to a stronger model goes back one tier after that many progress signals, at most once per run (off by default).
- An agent that reaches the human level is paused: its further tool calls, `ask_for_help` included, are refused until you resume it with `/escalator resume <id>` (or `resume all`). `/escalator` lists paused agents; the `pauseAtHuman` option (default on) turns the pause off.
- `modelIds` option and broader model id recognition, so swaps pick the right ids on Amazon Bedrock, Vertex and gateways.
- Swap targets the account does not allow are handled: the step is sent again on the previous model, that model is not tried again in the session, the agent moves to the human level with a notice, and a refused senior model is skipped for consults.
- Senior consults are capped per agent (`maxConsultsPerAgent`, default 3), per session (`maxConsultsPerSession`, default 20) and by dollar budget (`consultBudgetUsd`, default off); a stopped consult falls through to the next ladder level.

### Changed

- The senior consult receives the full text of recent failed attempts (hidden failures included), the files the agent touched and the output of a read-only `git diff --stat`, all capped and with obvious secrets redacted.
- A refused senior consult is retried once on the other senior model with a shorter dossier; if that is refused too, the next ladder step is due immediately instead of after a grace window.
- Senior consults are priced from the token usage their reply reports instead of an estimate from text length; the estimate remains as a fallback.
- The escalation ladder keeps swapping an agent one model up (Haiku, then Sonnet, then Opus) before asking a human. The new `maxTier` option (default `opus`) caps how high a swap may go.
- Fork subagents keep their model and prompt and are no longer tracked, nudged or escalated.
- The nudge note now reads "You are not making progress...", so it fits repeated failures, idle loops and stalls alike.

### Fixed

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
