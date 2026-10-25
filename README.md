# Outscaled

Outscaled is a fork of [VS Code](https://github.com/microsoft/vscode) (Code - OSS) for running many coding agents on machines you own. Create workspaces on your Mac or any VPS, run always-on and scheduled Claude Code and Codex agents in them, see each agent's live status, and work on the files natively in VS Code.

It's a personal build, published as source: no installers, no releases.

## What works today

Phase 1 provides the daemon core for macOS and Linux, built from source. `wsd` listens on loopback and `ws` is its CLI:

- `ws new <slug> --repo <url>` clones a repo into a new workspace; `ws new <slug> --path <dir>` registers a folder you already have, in place, without copying it.
- `ws term open <workspace> --name <name> --cmd <command>` starts the command in tmux session `ws-<workspace>-<name>`, which you can attach to with `tmux attach` or from herdr.
- Terminals outlive `wsd`: stop or kill it, start it again, and it picks them back up.
- `--always-on` terminals come back by themselves about a second after their process dies, backing off if it keeps crashing.
- `ws health` reports CPU, RAM, disk and terminal counts.
- `--on <server>` selects a remote daemon over SSH using a host or alias from `~/.ssh/config`; `--on local` selects this machine.

[Linux VPS setup](daemon/systemd/README.md) covers cross-compilation, deployment and systemd operation. Mac/VPS health checks and the Phase 1 daily-use gate still require orchestrator verification.

## What's next

Next is **Phase 2: status and agent terminals**, after Phase 1 verification: live idle, working and needs-you status from Claude Code and Codex hooks, plus MCP tools so agents can open and drive terminals. Phase 3 adds the client sidebar and terminal grids; Phase 4 adds the VPS desktop and browser.

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

You need [Bun](https://bun.sh) 1.3.14 or newer, tmux, git and curl. These commands build and start on macOS; for Linux use the [VPS instructions](daemon/systemd/README.md). Clone the source, then run the remaining commands from its root:

```sh
# Skip VS Code's large history blobs and LFS test caches
GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none https://github.com/GabrielLunesu/outscaled.git
cd outscaled
git config core.hooksPath .githooks   # gitleaks pre-commit hook; needs gitleaks installed

# Build and start the daemon
(cd protocol && ../scripts/serial.sh bun install --frozen-lockfile)
(cd daemon && ../scripts/serial.sh bun install --frozen-lockfile)
(cd daemon && ../scripts/serial.sh bun run build)
# Start in the background and bound the readiness wait, releasing the serial lock.
scripts/serial.sh sh -eu -c '
  mkdir -p "$HOME/.local/share/wsd"
  nohup ./daemon/dist/wsd >"$HOME/.local/share/wsd/wsd.log" 2>&1 </dev/null &
  daemon_pid=$!
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    kill -0 "$daemon_pid" || exit 1
    if curl --fail --silent --max-time 1 http://127.0.0.1:7770/v1/health >/dev/null; then
      echo "wsd ready (PID $daemon_pid)"
      exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Startup timed out; inspect ~/.local/share/wsd/wsd.log" >&2
  exit 1
'

# Try it
./daemon/dist/ws health
./daemon/dist/ws new demo --repo https://github.com/octocat/Hello-World.git
./daemon/dist/ws term open demo --name a1 --cmd claude --always-on
tmux attach -t ws-demo-a1
# With a deployed VPS and a placeholder SSH alias configured locally:
./daemon/dist/ws health --on vps --json
```

On macOS, new workspaces go in `~/workspaces/` unless configured otherwise. The startup wrapper waits at most about 40 seconds; a failed wait may leave the daemon running, so inspect the log before retrying. Agent commands such as `claude` must already be available. Commands and settings are in [daemon/README.md](daemon/README.md).

## License

MIT, like VS Code itself. See [LICENSE.txt](LICENSE.txt).
