---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- Comments are recognised only at the start of a line or after whitespace and never inside a quoted value; quoted values are parsed character by character with the documented escapes; continuation lines drop the backslash, trim and join with one space; repeated sections merge; error line numbers are 1-based and point at the offending line.
- The parser is general: no special cases for the literal strings used in tests, no regular expression tricks that only work for the sample inputs.
- The code is readable (small helpers rather than one long tangle) and consistent with the existing style; the doc comment still matches the behaviour.
- No existing test file was changed.
