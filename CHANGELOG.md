# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

### Added

- Difficulty detector: repeated error signatures, failing test counts, per-model thresholds, grace window between interventions.
- Escalation ladder: nudge and senior consult delivered through the tool result `context`, hot model swap in `turn.step`, stop and hand back to the user.
- Basic learning: start task categories that escalate too often on a stronger model.
- Modes: `active`, `observe`, `baseline`, `off`.
- Cost metering from per-request usage, savings estimate, status line, `/escalator` command, session history.
- A/B eval skeleton.
