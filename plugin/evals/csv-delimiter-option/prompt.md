---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our small CSV library only handles commas. Add an optional `options` argument with a `delimiter` to both `parseCsv(text, options)` in `src/parse.mjs` and `toCsv(rows, options)` in `src/stringify.mjs`:

- `delimiter` defaults to `","`; without options everything works exactly as today.
- It must be a single character other than `"`, `\r` or `\n`; anything else throws a `TypeError`.
- `toCsv` quotes a field when it contains the delimiter, a double quote or a line break (a comma is no longer special when the delimiter is not a comma).
- Update the doc comments to match.

You are the lead. Read the code, write a short plan of independent subtasks (one per source file), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Every subtask must add its own tests in a new file under `test/` (for example `test/delimiter-parse.test.mjs`). Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
