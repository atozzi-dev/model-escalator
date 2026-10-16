---
max_turns: 45
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our dependency resolver picks wrong versions: prereleases sort above releases, `^0.x` ranges let in too much, partial versions in comparisons are mishandled, hyphen ranges cut too early, and prereleases slip into ranges that should exclude them. A few failing cases are in `test/semver.test.mjs` (run `node --test`), but they only scratch the surface. The behaviour is specified in the doc comments of `src/version.mjs`, `src/range.mjs` and `src/satisfies.mjs`: make the three files follow them exactly, including strict version syntax, comparator sets for every range form, and the prerelease rule.

You are the lead. Read the code, write a short plan of independent subtasks (one per module), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
