# model-escalator

A [Claude Code](https://code.claude.com) mod that lets cheap models do the parallel work and brings in a stronger model only when one of them gets stuck.

> **Status: early prototype (0.1).** The core loop is covered by tests that run through the Claude Code engine, but it has not been verified in live sessions yet. Expect breaking changes.

## What it does

- **Watches every subagent and in-process teammate.** It scores lack of progress (the same error again and again, failing tests that do not improve), not errors as such.
- **Intervenes with the least it takes**, one step at a time:
  1. a nudge to the agent: stop, re-read the error, change approach;
  2. a one-shot consult with a senior model, whose advice is handed to the agent;
  3. a hot swap: the same agent keeps its context and continues on a stronger model;
  4. a stop that hands control back to you.
- **Learns which model fits which kind of task.** When cheap models keep escalating on a category of task, the next agent of that kind starts on a stronger model.
- **Measures the savings while you work.** Every model request is metered and compared with what the same work would have cost on the lead's model.

## Install

Requires Claude Code 2.1.287 or later.

```
/plugin install model-escalator --marketplace atozzi-dev/model-escalator
```

Mods are not sandboxed. Before installing any mod you can list what it hooks and calls, without running it:

```
claude plugin validate <path-to-plugin>
```

## Usage

The mod works on its own once installed.

| Control | Effect |
|---|---|
| `/escalator` | Session cost, estimated savings, interventions |
| `/escalator stats` | What the mod has learned per task category |
| `/escalator reset` | Forget what it has learned |
| `MODEL_ESCALATOR_MODE=observe` | Measure and log what it *would* do, without intervening. Recommended for the first days |
| `MODEL_ESCALATOR_MODE=baseline` | Run every agent on the reference model, no interventions (control arm for A/B evals) |
| `MODEL_ESCALATOR_MODE=off` | Pass everything through |
| `MODEL_ESCALATOR_BASELINE` | Reference model for savings; defaults to the lead's model |

## Configuration

Options are set from `/config` (or under `pluginConfigs` in settings) and apply after a reload. Invalid values fall back to the default.

| Option | Default | Effect |
|---|---|---|
| `thresholdHaiku` / `thresholdSonnet` / `thresholdOpus` | 3 / 4 / 6 | Difficulty score at which an agent that started on that model gets its next intervention. Lower means earlier intervention |
| `graceSteps` | 4 | Steps to wait after an intervention before the next one |
| `seniorModel` | `opus` | Model asked for advice at the consult level, alias or full id |
| `levels` | `nudge,consult,swap,human` | Comma-separated enabled levels. Disabled ones are skipped: `nudge,swap,human` turns the senior consult off |
| `prudentTokenRatio` | 0.65 | Share of the tokens a stronger baseline model is assumed to need, between 0 (exclusive) and 1. Used for the prudent end of the savings estimate |
| `prices` | built-in list prices | Optional JSON overriding USD per million token rates per model, e.g. `{"sonnet":{"input":3,"output":15}}`. Rates: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` |

The environment variables `MODEL_ESCALATOR_MODE` and `MODEL_ESCALATOR_BASELINE` are not plugin options; they work as described in [Usage](#usage).

## What it touches

The mod uses only its own key-value store, the UI (log, status line, toasts), two environment variables (read only), the clock, one slash command, and one-shot model calls for the senior consult. It does not read or write your files, run processes, or use the network. A consult sends the stuck agent's recent commands and error messages to the senior model, through the same provider as the rest of your session.

In `active` mode the mod also adds one announcement paragraph to the prompt of every subagent and teammate it tracks, so they can tell its supervisor notes apart from text in tool output. The other modes leave prompts untouched.

## How savings are estimated

Real spend comes from the token usage each model request reports, priced at API list prices. The reference prices the same requests on the lead's model, in an optimistic version (same tokens) and a prudent one (a stronger model would have needed fewer tokens). The hidden costs of escalating (wasted steps before a swap, cache rewrites, consults) are part of real spend, so savings can come out negative, and the report says so. On a subscription plan, read the percentage as the share of usage limits saved.

## Known limitations

- **The savings report is not a full bill.** It counts the requests that go through the agent loops. A few requests Claude Code makes on its own (for example prompt suggestions) are not visible to the mod, so in short sessions the total can be up to about 15% lower than `/cost`.
- **Supervisor notes are tagged, not hidden.** The mod's notes reach the agent next to tool results. The announcement in each tracked prompt carries a per-session tag (`[supervisor:xxxxxx]`), so an agent can tell a real note from text injected through tool output. Text that claims to be a supervisor note without that tag is not one.

## Roadmap

Live verification first, then a richer detector (edit oscillation, stalls, verification gate), a help tool for agents, de-escalation, agent teams support, quality checks (sampled senior review, rework rate, A/B evals), learning that optimizes cost per accepted task, and an animated live map of the agent network.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
