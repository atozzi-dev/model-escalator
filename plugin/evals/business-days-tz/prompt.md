---
max_turns: 45
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our invoicing service computes due dates in business days, and the numbers are wrong for our New York office: Fridays are treated as Thursdays, and the overdue counter is one too high. Colleagues in other countries report different wrong results, especially around the dates when clocks change. The failing cases are in `test/bizdays.test.mjs` (run `node --test`). The contract is in the doc comments of `src/bizdays.mjs` and `src/schedule.mjs`: results must be the same in every time zone, on every date.

You are the lead. Read the code, write a short plan of independent subtasks, and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
