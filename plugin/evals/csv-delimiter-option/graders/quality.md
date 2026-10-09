---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- Both `parseCsv` and `toCsv` take an optional options object with a `delimiter`, validated the same way (single character, not `"`, `\r` or `\n`, else `TypeError`), with `","` as the default.
- The parser uses the delimiter where it used the comma; the serialiser quotes on the delimiter instead of a hard-coded comma. No unrelated behaviour changed.
- New tests were added in new files under `test/` and they exercise the new option (custom delimiters, quoting, invalid values); existing test files are unchanged.
- The code is small, readable and consistent with the existing style; doc comments describe the option.
