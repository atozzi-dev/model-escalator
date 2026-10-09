# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plugin options for the difficulty thresholds, grace steps, edit oscillation count, senior model, enabled escalation levels, prudent token ratio and price overrides; defaults are unchanged.
- Edit oscillation: editing the same file again and again without progress now raises an agent's difficulty score.

### Fixed

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
