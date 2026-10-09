# Security policy

Claude Code mods are not sandboxed: they run with the same access to the machine as Claude Code. This mod is designed to need very little (see "What it touches" in the README), and any change that widens that surface must be called out in the pull request.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab).

## In scope

- The mod reading, writing or sending anything beyond what the README declares.
- Text produced by agents (commands, errors) rendered or forwarded unsafely.
- Ways for a prompt or tool output to make the mod escalate, swap models or spend without limit.
