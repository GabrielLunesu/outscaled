# Outscaled

Outscaled is a fork of [VS Code](https://github.com/microsoft/vscode) (Code - OSS) for running many coding agents on machines you own. Create workspaces on your Mac or any VPS, run always-on and scheduled Claude Code and Codex agents in them, see each agent's live status, and work on the files natively in VS Code.

It's a personal build, published as source: no installers, no releases.

## What works today

Phases 1 and 2 (the daemon) run on macOS and Linux, and phase 3 (the VS Code fork) runs on macOS, all built from source. `wsd` listens on loopback and `ws` is its CLI; the fork is a client of every `wsd` you list.

**Workspaces and terminals**

- `ws new <slug> --repo <url>` clones a repo into a new workspace; `ws new <slug> --path <dir>` registers a folder you already have, in place, without copying it. wsd never writes into a workspace.
- `ws term open <workspace> --name <name> --cmd <command>` starts the command in tmux session `ws-<workspace>-<name>`, which you can attach to with `tmux attach` or from herdr.
- Terminals outlive `wsd`: stop or kill it, start it again, and it picks them back up.
- `--always-on` terminals come back by themselves about a second after their process dies, backing off if it keeps crashing.
- `ws health` reports CPU, RAM, disk and terminal counts.
- `--on <server>` selects a remote daemon over SSH using a host or alias from `~/.ssh/config`; `--on local` selects this machine.

**Agent status and tools**

- Terminals running `claude` or `codex` report live status: `working`, `needs_input` (Claude's permission prompts) and `idle`. Hooks are passed when the agent starts, so neither your repos nor your agent settings are edited.
- `ws status` lists every terminal on every server: this machine plus the SSH hosts in `~/.config/outscaled/servers.toml`.
- `ws mcp` gives agents MCP tools to open terminals, send them prompts, wait for them to go idle and read their output, so one Claude Code session can run several Codex agents.
- Scheduled agents in a workspace's `.ws/workspace.toml` (for example `every = "10m"`) run a headless prompt on time; `ws run ls` and `ws run log` show each run and its log.

**The app (VS Code fork)**

- An **Outscaled** sidebar lists the workspaces on your Mac and each VPS, grouped by server, with every terminal's status dot and a "need you" count, updating live.
- Clicking a workspace switches the explorer and editors to it without reloading the window. Mac workspaces open as normal folders; VPS workspaces are served by their `wsd`, so you can browse and edit them from the Mac.
- **Outscaled: Open Grid…** opens launch presets such as "2 Claude + 2 Codex" as a grid of editor-area terminals, each attached to a `wsd` tmux session (`ws attach`). Tab icons follow live status: grey idle, green working, red needs you, red cross crashed.
- Each workspace remembers its grid; switching back, or reloading, restores it on the same sessions.
- A terminal that needs you (or crashes) bounces the Dock icon and shows an in-app notification with a **Focus** button. The app also sends a macOS notification, but macOS only displays it for a signed build; see below.
- The default colour theme is Carbon Candy Matrix Cyber, from [Carbon Candy](https://github.com/viral-team/carbon-candy-theme) (MIT).

[Linux VPS setup](daemon/systemd/README.md) covers cross-compilation, deployment and systemd operation. All commands are in [daemon/README.md](daemon/README.md); the app's features are in [extensions/outscaled/README.md](extensions/outscaled/README.md).

## What's next

Phase 3 has one item left: clickable macOS notifications need the app signed with an Apple development certificate, because macOS refuses notification permission to the unsigned dev build. After Phase 3 is reviewed in daily use, **Phase 4** adds a desktop and a logged-in Chrome on each VPS, shared by agents and you.

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
./daemon/dist/ws term ls demo         # process state and live agent status
./daemon/dist/ws status               # every terminal on every server
# With a deployed VPS and a placeholder SSH alias configured locally:
./daemon/dist/ws health --on vps --json
```

On macOS, new workspaces go in `~/workspaces/` unless configured otherwise. The startup wrapper waits at most about 40 seconds; a failed wait may leave the daemon running, so inspect the log before retrying. Agent commands such as `claude` must already be available. Commands and settings are in [daemon/README.md](daemon/README.md).

### Client

On macOS, install Xcode's Command Line Tools and the Node.js version in `.nvmrc` (for example, `nvm install && nvm use`). From the repo root, install and compile the client, then open a folder:

```sh
scripts/serial.sh npm install
scripts/serial.sh npm run compile
./scripts/code.sh /path/to/folder   # not through serial.sh: it would hold the build lock while the app is open
```

The first launch downloads the development Electron runtime if needed. Click **Outscaled** in the activity bar to see your workspaces; the first time you pick one, the window reloads once into a dedicated Outscaled workspace (saved as `~/.config/outscaled/outscaled.code-workspace`). It connects to the local `wsd` and to the SSH hosts in `~/.config/outscaled/servers.toml`. Its build bundles the shared schemas directly from `protocol/src/index.ts` with zod; there is no separate protocol build. For extension-only changes after the initial client build, run `scripts/serial.sh npm run gulp compile-extension:outscaled`.

## License

MIT, like VS Code itself. See [LICENSE.txt](LICENSE.txt).
