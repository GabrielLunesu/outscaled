# wsd and ws

From `daemon/`, with Bun 1.3.14 or newer and curl installed:

```sh
cd ../protocol
../scripts/serial.sh bun install
bunx tsc --noEmit
cd ../daemon
../scripts/serial.sh bun install
../scripts/serial.sh bun test
bunx tsc --noEmit
../scripts/serial.sh bun run build
./dist/wsd
```

In another terminal, from `daemon/`:

```sh
./dist/ws health
./dist/ws health --json
```

The build produces one executable, `dist/wsd`, and a relative `dist/ws` symlink.
Keep the symlink when copying them elsewhere: the invoked name selects the CLI.
For development use `bun src/wsd.ts` and `bun src/ws.ts health`.
Run the daemon directly so it does not hold the build lock for its lifetime.

## Commands

| Command | Does |
| --- | --- |
| `ws health` | CPU, RAM, disk and terminal counts |
| `ws new <slug>` | Empty workspace in the workspaces folder |
| `ws new <slug> --repo <url>` | Clone a repo into a new workspace |
| `ws new <slug> --path <dir>` | Register an existing folder in place; nothing is copied, moved or written |
| `ws term open <workspace> --name <name> [--cmd <command>] [--always-on]` | Start a terminal as tmux session `ws-<workspace>-<name>` in the workspace folder; without `--cmd` it opens your login shell |
| `ws term ls <workspace>` | List a workspace's terminals and their state |

Every command takes `--json` for raw output, and `--on <server>`, where only `local` works for now.

Terminals run on tmux's default socket, so `tmux attach -t ws-<workspace>-<name>` or herdr can attach to them. They keep running when wsd stops, and wsd re-adopts them when it starts. When an `--always-on` terminal's process dies, wsd restarts the same command in the same pane after 1 s, 5 s, 30 s, then every 5 min; after five quick failures in a row it marks the terminal `crashed` and stops.

## Configuration

Configuration is read from `config.toml` inside the config directory:

```toml
name = "example"
workspaces_dir = "/example/workspaces"
```

Environment variables override file settings and OS defaults. The name defaults
to the short hostname. The SQLite database is `state.db` inside the state directory.

| Variable | macOS default | Linux default |
| --- | --- | --- |
| `WSD_CONFIG_DIR` | `~/.config/wsd` | `/etc/wsd` |
| `WSD_STATE_DIR` | `~/.local/share/wsd` | `/var/lib/wsd` |
| `WSD_WORKSPACES_DIR` | `~/workspaces` | `/workspaces` |
| `WSD_PORT` | `7770` | `7770` |
| `WSD_TMUX_SOCKET` | unset (default tmux socket) | unset (default tmux socket) |

Use absolute directory paths.
