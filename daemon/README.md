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
| `ws status [--json]` | Every terminal on every configured server, with server, workspace, name, process state and agent status (`-` when absent) |
| `ws new <slug>` | Empty workspace in the workspaces folder |
| `ws new <slug> --repo <url>` | Clone a repo into a new workspace |
| `ws new <slug> --path <dir>` | Register an existing folder in place; nothing is copied, moved or written |
| `ws term open <workspace> --name <name> [--cmd <command>] [--always-on]` | Start a terminal as tmux session `ws-<workspace>-<name>` in the workspace folder; without `--cmd` it opens your login shell |
| `ws term ls <workspace>` | List terminals with process state and agent status (`-` for shells); `--json` includes runtime, status and `statusChangedAt` |
| `ws attach <workspace> <name> [--on <server>]` | Attach the current terminal to a running wsd terminal locally or over SSH; no `--json` |
| `ws run ls <workspace>` | List runs, newest first: agent, status, start time, exit code and run id; accepts `--json` |
| `ws run log <run-id>` | Print the run's combined stdout and stderr |
| `ws hook claude-code` | Forward Claude hook JSON from stdin to the local daemon using `WSD_TERMINAL` and `WSD_PORT`; silent, best effort, always exits 0 |
| `ws hook codex <notify-json>` | Forward Codex's last-argument notify JSON to the local daemon; silent, best effort, always exits 0 |
| `ws mcp [--on <server>]` | Serve agent terminal tools over stdio MCP, using the local daemon or the existing SSH client |

The health, new, term and run ls commands take `--json` for raw output.
All these commands, including run log, take `--on <server>`.
The default is `local`, which connects directly to the local daemon.

`ws status` always queries `local` first, then the SSH hosts listed in
`~/.config/outscaled/servers.toml`, in file order:

```toml
[[server]]
host = "example-alias"
```

Set `OUTSCALED_CONFIG_DIR` to override that directory. A missing file means local
only; duplicate hosts, an explicit `local`, and invalid SSH targets are errors.
Status takes no `--on` option. It queries servers in parallel using the existing
10-second SSH startup and 3-second HTTP timeouts. Text output has aligned columns
and omits empty servers; failures name the server on stderr. JSON output is an
array of `{server, terminals}` or `{server, error}` entries, including empty
servers. Either mode exits 1 if any server fails, after reporting the available
results. `GET /v1/terminals` supplies each server's terminals across workspaces,
sorted by workspace and name, with the same session freshness as `ws term ls`.

Claude commands (including an absolute path to `claude`) launch with a wsd-owned
`claude-settings.json` in the state directory. Its hooks call the CLI by absolute
path and report `idle` at session start and turn end, `working` on prompts and
tool use, and `needs_input` on permission requests. Idle reminders are ignored.
The stored command remains the original command; workspace and user Claude
settings are never edited.

Codex commands launch with `-c 'notify=[<absolute ws argv>, "hook", "codex"]'`.
The original command is stored unchanged, and no Codex config files are edited.
`agent-turn-complete` notifications report `idle`. Every 500 ms the supervisor
checks `pane_output_generation` where tmux provides it, otherwise it checks
`window_activity` for that pane's window (one-second resolution, including tmux
3.6). The fallback cannot distinguish output batches within the same second.
New output after idle reports `working`, with a one-second grace period after
notify for Codex's final redraw.
Fresh Codex terminals become `idle` after about two seconds without output.
The activity fallback allows up to one extra second for timestamp uncertainty.
Composer redraws while typing also count as output; this fallback cannot
reliably distinguish them from agent output.

Agent status starts at `starting` and is independent of process state. An
always-on agent returns to `starting` when respawned; exited and crashed agents
retain their last status. Every status change emits `terminal.status`.

The hook command is local-only and takes no `--on` or `--json` options. It does
nothing outside wsd terminals and gives up after about a second if wsd is down.

## Live updates

`GET /v1/stream` upgrades to one broadcast WebSocket on the same loopback
listener as the HTTP API. Remote clients use an SSH tunnel to port 7770.
An ordinary HTTP GET returns 400 with a `websocket_required` error.

Each text frame contains one JSON object validated by the protocol package's
`StreamMessage` schema:

| Type | Message |
| --- | --- |
| `terminal.status`, `agent.needs_input`, `agent.crashed`, `run.started`, `run.finished` | The stored `Event` object, including `id`, `workspace`, `terminal`, `payload`, `time` and `acked`; sent after persistence commits |
| `workspace.changed` | `{type: "workspace.changed", workspace: "demo"}` when a workspace is created, a terminal opens, or a terminal's process state changes (including shell exits and agent restarts) |
| `server.health` | `{type: "server.health", payload: <Health>}` every 15 seconds, using the same body as `GET /v1/health` |

The last two types are live-only and never enter the events table. On
`workspace.changed`, refetch that workspace's terminals (and the workspace list
if the slug is new). Connect the socket before fetching current state over HTTP,
and reconcile notifications received during that fetch. Repeat this on reconnect:
the stream has no snapshot, replay, cursor, subscriptions or client commands.

```ts
import { StreamMessage } from "@outscaled/protocol";

const stream = new WebSocket("ws://127.0.0.1:7770/v1/stream");
stream.onmessage = event => {
  const message = StreamMessage.parse(JSON.parse(String(event.data)));
  console.log(message);
};
```

Broadcasts never wait for clients. A backed-up or failed send drops that socket;
other clients continue receiving events. Closed sockets are removed, idle
connections use WebSocket pings, and shutdown closes every connected socket.
On Bun 1.3.14, shutdown bounds the wait for Bun's stale WebSocket counter after
a server-side close ([upstream issue](https://github.com/oven-sh/bun/issues/36223)).

## Agent terminal tools over MCP

Point Claude Code or another MCP client at the compiled `ws` executable:

```json
{
  "mcpServers": {
    "ws": {
      "command": "/absolute/path/to/ws",
      "args": ["mcp", "--on", "local"]
    }
  }
}
```

For a remote daemon, replace `local` with an SSH host or alias. `WSD_PORT` in
the server's `env` selects a custom daemon port, just as for other CLI commands.
Only MCP protocol messages go to stdout; diagnostics go to stderr.

| Tool | Input and result |
| --- | --- |
| `list_terminals` | Optional `workspace`; returns terminals with name, process state, agent status and command. Omit workspace for all workspaces on this server |
| `open_terminal` | `workspace`, `name`, optional `command` and `alwaysOn`; opens a terminal and returns its record |
| `send_input` | `workspace`, `name`, optional `text`, `keys` and `submit`; returns the terminal record after sending input |
| `wait_for_status` | `workspace`, `name`, optional `status` (default `idle`) and `timeoutSeconds` (default 600, max 3600); returns the matching terminal or a tool error on exit or timeout |
| `read_output` | `workspace`, `name`, optional `lines` (default 200, max 5000); returns `{text}` including scrollback |

A new Codex or Claude terminal can show a folder-trust or onboarding screen.
Inspect it with `read_output` and answer using `send_input` keys such as `Down`
and `Enter` before sending a prompt. For two agents, open both with
`command: "codex"`, handle their startup screens, send each its prompt, then
wait for each to be idle and read its output. A submitted input immediately
sets agent status to `working`, so a following wait cannot return the old idle.

The underlying API also exposes:

- `POST /v1/workspaces/:ws/terminals/:name/input` with `{text?, keys?, submit?}`.
  Text is sent as one tmux bracketed paste (when the app enables bracketed paste),
  preserving newlines and UTF-8. Keys follow the paste; `submit: true` sends an
  additional Enter after a short paste-processing pause. Submit defaults to true
  when text is provided. Use `submit: false` to leave text in the composer.
  Key names accept letters, digits and hyphens (for example `Escape`, `C-c`,
  `Down`); unsafe spellings are rejected before sending any input.
- `GET /v1/workspaces/:ws/terminals/:name/output?lines=N` returns `{text}` with
  wrapped lines joined and trailing blank lines removed. The default is 200
  lines and the maximum is 5000; out-of-range limits return 400.

Both routes return 404 for unknown terminals and 409 for terminals that are no
longer running. They use the same lifecycle lock as hooks and supervision.

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
ws attach demo a1 --on example-alias
```

Install and start `wsd` on the remote machine first, bound to localhost. The CLI
runs the system `ssh` executable with structured arguments and opens a private
Unix socket forwarding to `127.0.0.1:7770` on that machine. `WSD_PORT` selects
the daemon port for both local and remote requests; configure a custom SSH port
in `~/.ssh/config` instead. Each invocation owns its tunnel and removes the
socket and SSH processes on completion, error, or SIGINT/SIGTERM/SIGHUP.

API SSH tunnels use your existing config, identity files, agent, proxy/jump settings and
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
also interpreted on the selected server. `ws attach` connects your current
terminal to a session on the selected server.

### Attach to a terminal

```sh
ws term open demo --name sh1
ws attach demo sh1
ws attach demo a1 --on example-alias
```

Attach first checks through the API that the named terminal exists and is
`running`; an unavailable daemon, unknown terminal or non-running terminal
produces a clear error and exit code 1. Local attach runs
`tmux -u attach-session -t =ws-<workspace>-<name>`, adding `-S <socket>` when
`WSD_TMUX_SOCKET` is set, just as wsd does. Use the same socket setting as wsd.

Remote attach checks through the existing SSH API tunnel, closes it, then runs
`ssh -t <host> sudo -n -u ws -H tmux -u attach-session -t =ws-<workspace>-<name>`.
The SSH login must be allowed to run tmux as the daemon's `ws` account without a
sudo password; sudo failures appear directly in the terminal. This uses the
remote `ws` account's default tmux socket; a local `WSD_TMUX_SOCKET` is not sent.

The child inherits the real terminal for input, resizing and UTF-8 colours.
`TMUX` is removed from its environment so attach also works inside another tmux.
Detach with tmux's prefix then `d` (normally Ctrl-b, then d), or close the window;
the session and its process keep running. The CLI returns tmux's or SSH's exit
code and does not accept `--json`.

Remote behavior is covered by isolated fake-SSH tests and has been verified on
a real Linux VPS, including cloning, in-place registration and terminal access.

Terminals run on tmux's default socket, so `tmux attach -t ws-<workspace>-<name>` or herdr can attach to them. They keep running when wsd stops, and wsd re-adopts them when it starts. When an `--always-on` terminal's process dies, wsd restarts the same command in the same pane after 1 s, 5 s, 30 s, then every 5 min; after five quick failures in a row it marks the terminal `crashed` and stops.

## Scheduled agents

Create `.ws/workspace.toml` in a registered workspace and a prompt file relative
to `.ws/`, for example `.ws/prompts/ad-check.md`:

```toml
[[agent]]
name = "ad-check"
runtime = "claude-code"
mode = "scheduled"
every = "10m"
prompt = "prompts/ad-check.md"
```

`runtime` accepts `claude-code`, `codex` or `script`. Scripts use
`command = "./check.sh"` in place of `prompt`. Names are unique workspace slugs;
intervals are positive whole numbers followed by `s`, `m`, `h` or `d`. Prompt
paths and their symlink targets must stay inside `.ws/`. Other modes and unknown
keys are ignored. Invalid files or entries are skipped with a diagnostic once
until the problem changes or is fixed. wsd only reads workspace configuration.

wsd checks configuration every two seconds. The first run starts one interval
after discovery, and later runs are due one interval after the previous start.
SQLite preserves the clock across restarts. An overdue schedule runs once;
missed intervals never accumulate a backlog. If a run is still active at its
next due time, that execution is skipped and the next check is an interval later.
Changing an interval recalculates its due time from the last start (or first
discovery); removing a schedule cancels future executions and retains its runs.

Each execution runs in the workspace through `$SHELL -l -c` (falling back to
`/bin/sh`), with stdin from `/dev/null`. Claude runs `claude -p <prompt>` and
Codex runs `codex exec <prompt>`; prompt text is passed as data. Both output
streams go directly to `<state dir>/logs/<workspace>/<agent>/<run-id>.log`.
Runs record start/end time, exit code and `running`, `succeeded`, `failed` or
`interrupted` status. Non-zero exits produce an error in the `run.finished`
event. wsd stores `run.started` and `run.finished` events in SQLite.

Graceful shutdown stops polling and terminates active scheduled processes;
unfinished runs from a previous daemon are marked interrupted on startup.
Always-on and one-off entries in workspace.toml are not launched yet.

```sh
ws run ls demo
ws run ls demo --json --on example-alias
ws run log <run-id> --on example-alias
```

The API serves `GET /v1/workspaces/:ws/runs` as a JSON array (newest first) and
`GET /v1/runs/:id/log` as plain text. Unknown workspaces, unknown runs and missing
log files return 404.

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
