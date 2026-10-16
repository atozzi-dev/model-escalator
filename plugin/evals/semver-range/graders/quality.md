---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- `version.mjs` follows the documented syntax (no leading zeros, strict parts) and the semver precedence rules: numeric identifiers compare as numbers and sort below alphanumeric ones, a prerelease sorts below its release.
- `range.mjs` produces the documented comparator sets: caret keeps the leftmost non-zero part, tilde bumps the minor (or the major when only a major is given), partials in `>`, `>=`, `<`, `<=` and in hyphen ranges expand as documented, and spaces after an operator are accepted.
- `satisfies.mjs` applies the prerelease rule per comparator set, and `maxSatisfying` keeps the first of equal versions.
- The code is general: no special cases for the literal strings used in tests, no hand-written lookup tables of expected results.
- The change is limited to the three files in `src/`, readable and consistent with the existing style; the doc comments still match the behaviour and no existing test file was changed.
