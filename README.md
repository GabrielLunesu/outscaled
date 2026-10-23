# Outscaled

Outscaled is a fork of [VS Code](https://github.com/microsoft/vscode) (Code - OSS) for running many coding agents on machines you own. Create workspaces on your Mac or any VPS, run always-on and scheduled Claude Code and Codex agents in them, see each agent's live status, and work on the files natively in VS Code.

It's a personal build, published as source: no installers, no releases.

## What works today

The daemon core (phase 1) runs on the Mac, from source. `wsd` is a small local daemon and `ws` is its CLI:

- `ws new <slug> --repo <url>` clones a repo into a new workspace; `ws new <slug> --path <dir>` registers a folder you already have, in place, without copying it.
- `ws term open <workspace> --name <name> --cmd <command>` starts the command in tmux session `ws-<workspace>-<name>`, which you can attach to with `tmux attach` or from herdr.
- Terminals outlive `wsd`: stop or kill it, start it again, and it picks them back up.
- `--always-on` terminals come back by themselves about a second after their process dies, backing off if it keeps crashing.
- `ws health` reports CPU, RAM, disk and terminal counts.

Everything runs on the local machine for now: `--on <server>` for a VPS isn't there yet.

## What's next

1. **Daemon on a VPS:** run `wsd` on a server and reach it over SSH with `--on <server>`, which completes phase 1.
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

You need macOS (Linux should work but is untested), [Bun](https://bun.sh) 1.3 or newer, tmux and git.

```sh
# Skip VS Code's large history blobs and LFS test caches
GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none https://github.com/GabrielLunesu/outscaled.git
cd outscaled
git config core.hooksPath .githooks   # gitleaks pre-commit hook; needs gitleaks installed

# Build and start the daemon
(cd protocol && bun install)
cd daemon && bun install && bun run build
./dist/wsd &                          # listens on 127.0.0.1:7770

# Try it
./dist/ws health
./dist/ws new demo --repo https://github.com/octocat/Hello-World.git
./dist/ws term open demo --name a1 --cmd claude --always-on
tmux attach -t ws-demo-a1
```

Workspaces you create go in `~/workspaces/` unless you register a folder with `--path`. Commands and settings are in [daemon/README.md](daemon/README.md).

## License

MIT, like VS Code itself. See [LICENSE.txt](LICENSE.txt).
