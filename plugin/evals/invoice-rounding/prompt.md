---
max_turns: 45
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our invoices are off by a cent here and there, returns come out with the wrong sign or rounding, and the tax differs between the two tax modes in ways nobody can explain. Some failing cases are in `test/invoice.test.mjs` (run `node --test`), but they cover only part of the problem. The contract of every function is in the doc comments of `src/money.mjs`, `src/discount.mjs`, `src/tax.mjs` and `src/invoice.mjs`: make the code follow them exactly, including returns (negative amounts), exact halves, `-0`, malformed input and the order of operations. Money must never go through floating point arithmetic where it can change the result.

You are the lead. Read the code, write a short plan of independent subtasks (one per module), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
