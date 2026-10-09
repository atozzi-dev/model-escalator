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

## What it touches

The mod uses only its own key-value store, the UI (log, status line, toasts), two environment variables (read only), the clock, one slash command, and one-shot model calls for the senior consult. It does not read or write your files, run processes, or use the network. A consult sends the stuck agent's recent commands and error messages to the senior model, through the same provider as the rest of your session.

## How savings are estimated

Real spend comes from the token usage each model request reports, priced at API list prices. The reference prices the same requests on the lead's model, in an optimistic version (same tokens) and a prudent one (a stronger model would have needed fewer tokens). The hidden costs of escalating (wasted steps before a swap, cache rewrites, consults) are part of real spend, so savings can come out negative, and the report says so. On a subscription plan, read the percentage as the share of usage limits saved.

## Roadmap

Live verification first, then a richer detector (edit oscillation, stalls, verification gate), a help tool for agents, de-escalation, agent teams support, quality checks (sampled senior review, rework rate, A/B evals), learning that optimizes cost per accepted task, and an animated live map of the agent network.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
