---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `parseLine` adds a `tags` array following the requested syntax (whole-word `#tag`, lowercased, unique, in order), removes tags from the title and collapses whitespace, without changing how due dates and the done flag are parsed.
- `TodoStore.list` supports a case-insensitive `tag` filter (leading `#` optional) that combines with the other filters, and `tagCounts()` sorts by count descending, then by name.
- `formatItem` appends `#tag` entries after the due part and still works for items without `tags`.
- New tests were added in new files under `test/` and they cover the new behaviour, including the word-boundary rules; existing test files are unchanged.
- The code is small, readable, consistent with the existing style, and the doc comments describe the new behaviour.
