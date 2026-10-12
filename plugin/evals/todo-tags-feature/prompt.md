---
max_turns: 35
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Agent, mcp__model-escalator__ask_for_help]
---

Add tags to our todo library. The parser, the store and the formatter each need a change:

1. `parseLine` in `src/parse.mjs` returns a new `tags` field (an array, `[]` when there are none). A tag is `#` followed by one or more letters, digits, `_` or `-`, standing as a whole word: at the start of the text or after whitespace, and followed by whitespace or the end of the text (so `C#`, `issue#12` and `#work,` are not tags). Tags are stored lowercased and without the `#`, each once, in order of first appearance. They are removed from the title, and runs of whitespace left in the title collapse to a single space.
2. `TodoStore` in `src/store.mjs`: `list()` accepts a `tag` filter (case-insensitive, with or without a leading `#`) that combines with the existing filters, and a new method `tagCounts()` returns `[tag, count]` pairs sorted by count descending, then by tag name.
3. `formatItem` in `src/format.mjs` appends the tags after the due part, each with its `#`, for example `[ ] call Ann (due 2024-05-01) #urgent #home`. Items without a `tags` field still format as before.

Update the doc comments to match.

You are the lead. Write a short plan of independent subtasks (one per source file; they can run in parallel), and delegate each subtask to a subagent with the Agent tool, passing `model: "haiku"`. Every subtask must add its own tests in a new file under `test/` (for example `test/tags-parse.test.mjs`). Do not edit the source files yourself: review what the subagents report and send a follow-up subagent if something is still wrong.

Rules: do not modify the existing files under `test/` and do not touch anything under `.eval/`. When the work is done, run `node .eval/check.mjs` as your last command and end with its first line.
