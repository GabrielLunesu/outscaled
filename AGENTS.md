# Agent instructions

Outscaled is a fork of microsoft/vscode at the repo root. Our own code lives in a few folders beside VS Code's; everything else is upstream.

## Source of truth

[docs/spec.md](docs/spec.md) and its phase checklists define what to build. If a task needs a decision the spec doesn't cover, stop and ask. Don't guess.

## Where code goes

- `daemon/`: `wsd` and the `ws` CLI (Bun, TypeScript)
- `protocol/`: shared API and event types (zod schemas)
- `extensions/outscaled/`: the built-in extension (sidebar, grid, presets, PC panel)
- `src/vs/workbench/contrib/outscaled/`: core VS Code changes, only for workspace switching, live tab status and needs-you notifications
- `desktop/`: VPS desktop setup and Chrome launcher

Keep changes inside these folders so upstream merges stay easy. When you do touch VS Code's own code, follow [.github/copilot-instructions.md](.github/copilot-instructions.md).

## The repo is public

Never commit secrets, server names, IPs, emails or anything from your own machines. Real servers and presets live in `~/.config/outscaled/`, outside the repo. A gitleaks pre-commit hook backs this up; never bypass it.

## Heavy commands run one at a time

Builds, compiles, watch tasks, full test suites, dependency installs, and starting the app or a dev server always go through `scripts/serial.sh`, which holds a machine-wide lock:

```sh
scripts/serial.sh bun install
scripts/serial.sh bun test
```

A single test file, or a typecheck or lint of the package you touched, can run directly.

## Commits and PRs

- Conventional Commits with a scope, such as `feat(daemon): …`, `fix(extension): …`, `chore(fork): …`. Imperative, under 72 characters, with a body when the why isn't obvious.
- One logical change per PR, titled as the change, with a short what-and-why and the checklist item it ticks.
- Small changes go straight to `main`. Anything spanning several files, or ticking a phase checklist item, goes through a PR.
