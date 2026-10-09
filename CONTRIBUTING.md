# Contributing

Thanks for helping. This project is a Claude Code mod written in TypeScript.

## Setup

- Claude Code 2.1.287 or later, Node.js and TypeScript (`npm i -g typescript`).
- Load the mod once with `claude --plugin-dir ./plugin` from the repository root. Claude Code writes the API types for your build into `plugin/.claude-plugin/types/`.
- That folder is ignored by git because the types belong to your local build. Do not commit it.
- The mod lives in `plugin/`. Run every command below from there:

```bash
claude plugin test .       # unit tests and tests through the engine
claude plugin validate .   # what the mod hooks and calls, without running it
tsc -p .                   # type check
```

Try it live from the repository root with `claude --plugin-dir ./plugin` (it reloads on save).

## How we work

- Open an issue before anything larger than a small fix.
- Test first: write the failing test, then the code.
- Decision logic goes in pure modules under `plugin/hooks/` (no `$` calls). `register.ts` only wires events and performs actions.
- A hook must never block an agent because of the mod's own failure: catch, then pass through.
- All three commands must be clean before a pull request. Do not weaken or skip tests. CI skips the type check when the published types are older than the pinned engine, so run `tsc -p .` locally.
- Any change that widens what the mod touches (new API namespaces, files, processes, network) must be called out in the pull request and in the README.
- Everything in the repository is in English.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative mood, lower case, no trailing period.

```
feat(detector): detect edit oscillation on the same file
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`, `ci`.

## Pull requests

One topic per pull request. Describe what changed, why, and how you tested it, including any live check. Add a line to `CHANGELOG.md` under Unreleased for user-visible changes.
