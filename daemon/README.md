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
```

Start the daemon with the bounded `scripts/serial.sh` startup wrapper in the
[root README](../README.md#run-from-source), which releases the lock once the
daemon is ready. Then, from `daemon/`:

```sh
./dist/ws health
./dist/ws health --json
```

The build produces one executable, `dist/wsd`, and a relative `dist/ws` symlink.
Keep the symlink when copying them elsewhere: the invoked name selects the CLI.
For development, substitute `bun ./daemon/src/wsd.ts` for the daemon executable
in that startup wrapper and use `bun src/ws.ts health` from `daemon/`.

## Commands

| Command | Does |
| --- | --- |
| `ws health` | CPU, RAM, disk and terminal counts |
| `ws new <slug>` | Empty workspace in the workspaces folder |
| `ws new <slug> --repo <url>` | Clone a repo into a new workspace |
| `ws new <slug> --path <dir>` | Register an existing folder in place; nothing is copied, moved or written |
| `ws term open <workspace> --name <name> [--cmd <command>] [--always-on]` | Start a terminal as tmux session `ws-<workspace>-<name>` in the workspace folder; without `--cmd` it opens your login shell |
| `ws term ls <workspace>` | List a workspace's terminals and their state |

Every command takes `--json` for raw output and `--on <server>`. The default is
`local`, which connects directly to the local daemon.

## Remote commands over SSH

`--on` accepts a host alias from your own `~/.ssh/config`, an SSH hostname, or an
ordinary `user@host` target. It does not use a server registry. Keep real host
addresses, usernames, keys and presets outside this public repository.

```sh
ws health --on example-alias
ws new demo --on example-alias --repo https://example.invalid/project.git
ws new existing --on example-alias --path '/absolute/server/folder with spaces'
ws term open demo --on example-alias --name a1 --cmd claude
ws term ls demo --on example-alias --json
```

Install and start `wsd` on the remote machine first, bound to localhost. The CLI
runs the system `ssh` executable with structured arguments and opens a private
Unix socket forwarding to `127.0.0.1:7770` on that machine. `WSD_PORT` selects
the daemon port for both local and remote requests; configure a custom SSH port
in `~/.ssh/config` instead. Each invocation owns its tunnel and removes the
socket and SSH processes on completion, error, or SIGINT/SIGTERM/SIGHUP.

SSH uses your existing config, identity files, agent, proxy/jump settings and
known-host checks. It runs in batch mode, so establish host trust and unlock any
required keys with SSH beforehand: password, passphrase and first-contact trust
prompts cannot be answered by `ws`. Connections are independent of SSH's shared
control sockets and stay in the foreground so the CLI can clean them up.

The CLI waits up to 10 seconds for the tunnel and remote daemon's health endpoint.
Authentication and forwarding failures include SSH diagnostics. HTTP requests
time out after 3 seconds, except workspace creation/cloning, which allows 30
minutes. Interrupting or timing out a request closes the connection; an operation
already accepted by the remote daemon may still finish there. Check its state
before retrying.

Remote `--path` **must be an absolute path on the server**. The CLI rejects `~`,
`~/...` and relative paths, and sends absolute paths unchanged for the server to
resolve and register in place. Quote paths containing spaces or shell characters.
Use an explicit server path such as `/absolute/server/folder`; unquoted `~` is
expanded by your local shell before `ws` can validate it. Local `--path` retains
relative-path and tilde expansion. Repository URLs and terminal commands are
also interpreted on the selected server. To attach with tmux or herdr, run them
on that server.

Remote behavior is covered by isolated fake-SSH tests and has been verified on
a real Linux VPS, including cloning, in-place registration and terminal access.

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
