# A/B evals: does the escalation ladder match "everything on the strong model"?

Each case runs in two arms with the same suite. From the `plugin/` folder:

```bash
# Control arm: every agent on the lead's model, no interventions
MODEL_ESCALATOR_MODE=baseline claude plugin eval . --ablation none --runs 3 --json results/baseline.json
# Arm under test: the ladder is active
MODEL_ESCALATOR_MODE=active   claude plugin eval . --ablation none --runs 3 --json results/active.json
```

Compare per case: mean grader score, variance across runs, cost. The ladder is acceptable when the score stays within your chosen tolerance (for example 5 percentage points) and the cost goes down.

The default ablation of `claude plugin eval` compares "with the mod" and "without the mod". Without the mod, cheap subagents work unsupervised: a useful comparison, but not "everything on the strong model". That is what the `baseline` arm is for.

The cases here are skeletons: replace the TODOs with real tasks from a sample project (`claude plugin eval init` walks you through it). Prefer deterministic graders (tests that pass) next to an LLM grader for code quality.
