---
max_turns: 35
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our job runner misbehaves in production: it sometimes runs one task more than the concurrency limit, returns results in the wrong order, keeps starting tasks after a failure, and the retry wrapper gives up one attempt too early with the wrong backoff. Failing cases are in `test/pool.test.mjs` (run `node --test`). The contract of `runPool` in `src/pool.mjs` and of `withRetry` in `src/retry.mjs` is in their doc comments: make the code follow it exactly, including empty input, failures and invalid limits.

You are the lead. Read the code, write a short plan of independent subtasks (one per affected file), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
