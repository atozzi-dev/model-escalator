---
max_turns: 35
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Users of our bill-splitting library report that shares sometimes do not add up to the bill (a cent goes missing or appears out of nowhere), and that refunds print as garbage such as `-1.0-5`. Some failing cases are in `test/split.test.mjs` (run `node --test`). The intended behaviour, including how leftover cents are assigned, refunds and input validation, is specified in the doc comments of `src/split.mjs` and `src/money.mjs`: make the code follow them exactly.

You are the lead. Read the code, write a short plan of independent subtasks (one per affected file), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
