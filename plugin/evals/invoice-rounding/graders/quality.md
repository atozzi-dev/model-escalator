---
type: llm
focus: { source: file, path: .eval/diff.txt }
weight: 1
---

The input is the diff of the run against the original project. PASS only if all of these hold:
- Amounts and rates are parsed from their text digits into integers (no `Number(text) * 100` or `parseFloat` followed by rounding), `-0` never leaks out, and `roundDiv` rounds exact halves away from zero using integer arithmetic only.
- `applyDiscounts` takes the percentage first with `roundDiv`, caps the coupon at the sum of the positive nets and splits it by largest remainder with ties to the earlier line; `computeTax` rounds per line in `line` mode and once on the taxable sum in `invoice` mode; `buildInvoice` taxes the discounted amounts of taxable lines only.
- The code is general: no special cases for the literal values used in tests.
- The change is limited to the four files in `src/`, readable and consistent with the existing style; the doc comments still match the behaviour and no existing test file was changed.
