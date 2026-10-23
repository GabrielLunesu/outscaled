# Outscaled

Outscaled is a fork of [VS Code](https://github.com/microsoft/vscode) (Code - OSS) for running many coding agents on machines you own. Create workspaces on your Mac or any VPS, run always-on and scheduled Claude Code and Codex agents in them, see each agent's live status, and work on the files natively in VS Code.

It's a personal build, published as source: no installers, no releases.

## What works today

Nothing runs yet. The repo is VS Code 1.143.1 plus the Outscaled scaffolding. Phase 1, the `wsd` daemon, is next.

## What's next

1. **Daemon core:** `wsd` and the `ws` CLI create workspaces and own every terminal as a tmux session.
2. **Status and agent terminals:** live idle, working and needs-you status from Claude Code and Codex hooks, plus MCP tools so agents can open and drive terminals.
3. **Client fork:** the workspace sidebar, terminal grids and live tab status inside VS Code.
4. **Desktop and browser:** a desktop and a logged-in Chrome per VPS, shared by agents and you.

The full plan, with a checklist per phase, is in [docs/spec.md](docs/spec.md).

## Repo layout

| Path | What |
| --- | --- |
| `daemon/` | `wsd` and the `ws` CLI (Bun, TypeScript) |
| `protocol/` | Shared API and event types |
| `extensions/outscaled/` | The built-in extension: sidebar, grid, presets, PC panel |
| `src/vs/workbench/contrib/outscaled/` | Core VS Code changes (from phase 3) |
| `desktop/` | VPS desktop setup and Chrome launcher |
| `docs/` | The spec and the orchestration rules |

Everything else is upstream VS Code, merged in from release tags.

## Run from source

There's nothing to run yet. To set up a checkout:

```sh
# Skip VS Code's large history blobs and LFS test caches
GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none https://github.com/GabrielLunesu/outscaled.git
cd outscaled
git config core.hooksPath .githooks   # gitleaks pre-commit hook; needs gitleaks installed
```

## License

MIT, like VS Code itself. See [LICENSE.txt](LICENSE.txt).
