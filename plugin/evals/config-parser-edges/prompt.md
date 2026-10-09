---
max_turns: 45
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our configuration parser in `src/config.mjs` mangles real files: URLs with `#` lose their tail, quoted values with `;` are cut, continuation lines are glued without a space, repeated sections lose keys, and error messages point at the wrong line. Failing cases are in `test/config.test.mjs` (run `node --test`). The format is specified in the doc comment at the top of `src/config.mjs`: make `parseConfig` follow it exactly. You may restructure the parser if that makes it simpler.

You are the lead. Read the code, write a short plan of independent subtasks, and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
