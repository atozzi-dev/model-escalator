---
max_turns: 45
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Our async cache serves stale data, refetches too often, caches failures and evicts the wrong keys. Failing cases are in `test/cache.test.mjs` (run `node --test`), but they only show part of the problem. The behaviour is specified in the doc comments of `src/cache.mjs`, `src/inflight.mjs` and `src/lru.mjs`: make the code in those three files follow them exactly, including the order in which things happen (what is stored before a waiting caller resumes, which load is "current") and what happens when a key is invalidated while a load or a background refresh is running.

You are the lead. Read the code, write a short plan of independent subtasks (one per module), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
