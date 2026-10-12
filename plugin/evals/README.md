# A/B evals: does the escalation ladder match "everything on the strong model"?

The suite runs the same coding tasks in two arms and compares score and cost:

- **baseline**: every agent runs on the reference model (the lead's model, or `MODEL_ESCALATOR_BASELINE`), no interventions. This is the control arm.
- **active**: subagents start on the cheap model the lead asks for and the ladder escalates them only when they get stuck.

In every case the lead (the session model) plans the work and delegates it to subagents on `haiku`, so the mod has agents to supervise. Some subtasks are easy enough for a cheap model, others are built to make it loop.

## Requirements

- Claude Code 2.1.295 or later, logged in.
- `node` 20 or later and `bash` on the `PATH` (on Windows, Git Bash). The cases use only Node built-ins (`node:test`, `node:assert`): no network, no package installs.
- On Windows, `claude plugin eval` starts each scaffold as plain `bash` from your `PATH`. In PowerShell and `cmd` the first `bash` on the `PATH` is usually the WSL launcher (`C:\Windows\System32\bash.exe`), and every run then fails with `scaffold failed (exit 1): ... execvpe(/bin/bash) failed`. Put Git Bash first for that terminal, in PowerShell: `$env:PATH = "C:\Program Files\Git\usr\bin;" + $env:PATH`. A Git Bash terminal already has it first.

## Running both arms

From the `plugin/` folder:

```bash
# Control arm: every agent on the reference model, no interventions
EVAL_MODEL_ESCALATOR_MODE=baseline claude plugin eval . --ablation none --scaffold \
  --allow-tools Bash Edit Write mcp__model-escalator__ask_for_help \
  --model opus --runs 3 --max-cost-usd 60 --json evals/results/baseline.json

# Arm under test: the ladder is active
EVAL_MODEL_ESCALATOR_MODE=active claude plugin eval . --ablation none --scaffold \
  --allow-tools Bash Edit Write mcp__model-escalator__ask_for_help \
  --model opus --runs 3 --max-cost-usd 60 --json evals/results/active.json
```

Why each flag:

- `EVAL_MODEL_ESCALATOR_MODE`: `claude plugin eval` passes only `EVAL_*` variables (and a short fixed list such as `PATH` and `TZ`) from your shell to the runs, so `MODEL_ESCALATOR_MODE` itself never reaches them. The mod reads `EVAL_MODEL_ESCALATOR_MODE` and `EVAL_MODEL_ESCALATOR_BASELINE` when the plain variables are not set.
- `--ablation none`: the default ablation compares "with the mod" against "without the mod". Without the mod, cheap subagents work unsupervised: a useful comparison, but not "everything on the strong model". Both arms here load the mod; the mode decides what it does.
- `--scaffold`: each case builds its working folder with `scaffold.sh`. Without this flag the folder stays empty and every run fails.
- `--allow-tools`: shell and file edits are gated in eval runs; the cases need them, and subagents need the mod's `ask_for_help` tool.
- `--model opus`: pins the lead, so both arms share the same lead and the same reference model.
- `--runs 3`: three runs per case and arm, enough to see the variance. Use more for a decision that matters.
- `--max-cost-usd`: hard ceiling per arm; see the estimate below.
- `--json`: the full result (per run: score, turns, cost, grader verdicts) for the comparison.

The first run in this folder asks you to confirm that you trust the plugin. A run with `--json` (or in CI) cannot ask and stops with "not a trusted plugin directory": add `--trust-plugin`, or run once without `--json` to trust the folder. For a quick smoke test, filter cases: `--case paginate-off-by-one`, `--tag easy` or `--tag hard`, and `--runs 1`. The judge of the LLM grader defaults to Haiku; `--judge-model` changes it.

## The cases

| Case | Difficulty | What it exercises | Lead turns |
|---|---|---|---|
| `paginate-off-by-one` | easy | Two one-line off-by-one bugs in two files (page count, item range label). A cheap model should finish alone: the ladder should stay quiet. | 25 |
| `csv-delimiter-option` | easy | Small feature in two independent files (parser and serialiser), with input validation and new tests. | 25 |
| `split-bill-remainder` | medium | Largest-remainder money split with tie-breaking, refunds and validation; negative amount formatting. Easy to "fix" with a rounding hack that fails the property tests. | 35 |
| `task-pool-order` | medium | Concurrency-limited promise pool: limit off by one, result order, stop-on-failure semantics, sync throws; an off-by-one retry with exponential backoff. | 35 |
| `todo-tags-feature` | medium | Feature across three modules (parser, store, formatter) that the lead can delegate in parallel; precise word-boundary rules for `#tags`. | 35 |
| `business-days-tz` | hard | Date arithmetic mixing UTC parsing with local getters: correct in some time zones, wrong in others and around DST changes; start-exclusive counting. Acceptance tests run in three time zones. A cheap model tends to fix one zone and break another. | 45 |
| `config-parser-edges` | hard | INI-like parser with quoting, escapes, inline comments that need preceding whitespace, continuation lines, merged sections and 1-based error lines. Many interacting edge cases: the classic place where a cheap model loops. | 45 |

Timeouts are 600 s (easy), 900 s (medium) and 1200 s (hard) per run.

### How a case is built

```
<case>/
  case.yaml          name, description, tags, scaffold_script
  prompt.md          frontmatter (max_turns, timeout_seconds, allowed_tools) and the user prompt
  scaffold.sh        builds the working folder (calls ../_harness/setup.mjs)
  project/           the code the agent works on, with its visible tests in test/
  hidden/            acceptance tests the prompt does not mention
  graders/*.md       one grader per file
```

`_harness/setup.mjs` copies `project/` into the run folder, puts `hidden/`, a pristine copy of the project and `check.mjs` under `.eval/`, and records the sha256 of every protected file (existing tests, hidden tests, the check itself). The prompt asks the lead to finish with `node .eval/check.mjs`, which:

1. runs the project's tests (`test/*.test.mjs`, including any new test file) and the hidden acceptance tests;
2. compares the protected files with their recorded hashes, so a test edited to make it pass turns the result into a failure;
3. writes `.eval/result.txt` (first line `PASS` or `FAIL`) and `.eval/diff.txt` (the change against the original project).

### Graders

| Grader | Type | Weight | Passes when |
|---|---|---|---|
| `tests-pass` | `regex` on `.eval/result.txt` | 3 | the first line is `PASS`: visible and hidden tests pass and no protected file changed |
| `quality` | `llm` on `.eval/diff.txt` | 1 | the fix addresses the cause, is minimal, has no special cases for test values and fits the existing style |
| `delegated` | `tool_used` (`Agent` with `haiku`) | 0.5 | the lead delegated at least one subtask to a haiku subagent, so the run exercised supervision |
| `new-tests` | `file_exists` (`test/*.test.mjs` created) | 0.5 | feature cases only: new test files were added |

A run's score is the weighted fraction of graders that passed. `tests-pass` dominates on purpose: a run that does not pass the tests cannot score above 0.4. If the lead never runs the check, `.eval/result.txt` does not exist and `tests-pass` fails.

Limits: the hashes catch edited tests whatever tool edited them, but not a deliberately rewritten `check.mjs` together with its manifest; and the result reflects the code at the moment the check ran, so a change made after it is not graded. Both would show in `diff.txt` (for project files) and in the transcript.

## Reading the results

Compare the two JSON files with the script at the repository root (Node 22 or later, no dependencies):

```bash
node scripts/ab-compare.mjs plugin/evals/results/baseline.json plugin/evals/results/active.json \
  --tolerance 5 --markdown ab-report.md
```

It prints one row per case with:

- **mean score** (0 to 100) and standard deviation over the runs, per arm, and the score difference in points: a case that flips between pass and fail shows a large deviation and needs more runs before any conclusion;
- **mean cost per run** per arm (`costUsd` of the JSON) and the cost difference in percent; runs without cost data show `n/a`;
- a **verdict**: `OK` when the active score is within `--tolerance` points (default 5) of the baseline and the cost is lower, `WORSE` when the score drops more, `COSTLIER` when the score holds but the cost does not go down, `NO COST` when a cost is missing, `MISSING` when the case is in one file only.

A totals row gives the mean score, the cost per run summed over the cases and the saving in percent. The exit code is 0 when every case is `OK`, 1 otherwise and 2 on bad input, so it can gate a pipeline. `--markdown <file>` writes the same table as Markdown for a pull request. Errored runs are counted with their score and listed in a note.

For correctness without the judge's noise, also look at the `tests-pass` grader alone in the JSON.

The ladder is acceptable when, case by case and on the whole suite, the active score stays within your chosen tolerance of the baseline (for example 5 percentage points) and the cost goes down. Expect the easy cases to save the most with no escalation at all, and the hard cases to show escalations: there the saving may be small or negative, and the score is what matters. A hard case where both arms fail says nothing about the ladder. The JSON cost, measured by the eval runner, is the reference for the comparison, not the mod's own estimate.

## Cost of one full A/B run

Rough estimate with the list prices (USD per million tokens: Opus 4/20, Haiku 0.10/0.50, cache read 0.20 and 0.01) and an Opus lead:

- baseline: about 2 to 3 USD per run (lead about 0.8, two or three Opus subagents about 0.5 each), so 7 cases × 3 runs ≈ 45 to 60 USD;
- active: about 1 to 1.5 USD per run (same lead, Haiku subagents, a few consults and swaps on the hard cases), so ≈ 20 to 30 USD;
- judge: a few cents for the whole suite.

One full A/B run (7 cases × 2 arms × 3 runs) costs roughly 65 to 90 USD; the turn caps and timeouts bound the worst case at about twice that. `--max-cost-usd 60` per arm stops a run that drifts. On a subscription the dollar figures are indicative.

## Checking a case without spending

```bash
mkdir /tmp/try && cd /tmp/try
bash /path/to/plugin/evals/<case>/scaffold.sh
node --test             # the visible tests (fail for bug cases)
node .eval/check.mjs    # FAIL before the fix
```

After a correct fix `node .eval/check.mjs` prints `PASS`; editing any existing file under `test/` turns it back into `FAIL`.

## Adding a case

Copy a case folder, replace `project/` and `hidden/`, and adapt `case.yaml`, `prompt.md` and `graders/quality.md`. Keep the prompt's last paragraph (delegate to haiku subagents, do not touch `test/` or `.eval/`, run the check last) so every case is graded the same way. Check it as above, before and after a reference fix kept outside the repository.
