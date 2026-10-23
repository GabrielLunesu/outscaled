# wsd and ws

Minimal Bun daemon and CLI for macOS and Linux. `GET /v1/health` reports real
CPU, RAM, disk, uptime and stored terminal counts. Workspace and terminal routes
validate their inputs and return `501 not_implemented`; their CLI commands are
also stubs. The daemon binds only to `127.0.0.1`. Remote CLI servers are not yet supported.

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
../scripts/serial.sh ./dist/wsd
```

In another terminal, from `daemon/`:

```sh
./dist/ws health
./dist/ws health --json
```

The build produces one executable, `dist/wsd`, and a relative `dist/ws` symlink.
Keep the symlink when copying them elsewhere: the invoked name selects the CLI.
For development use `../scripts/serial.sh bun src/wsd.ts` and `bun src/ws.ts health`.
Tests compile and exercise both names, run real HTTP servers on temporary ports,
and isolate all configuration, state, workspace and tmux paths in temporary directories.
Run the tests through the serial wrapper, including the CLI test file (which builds).

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

Use absolute directory paths. No tmux commands run in this scaffold. Disk health
uses the workspaces directory, or its nearest existing parent without creating it.
CPU usage is sampled asynchronously over 100 ms; uptime is time since daemon start.
Version comes from the daemon package version.

`@outscaled/protocol` exports Zod schemas and matching TypeScript types directly
from source. JSON uses camelCase; timestamps are UTC ISO 8601 strings; event IDs
and terminal IDs are strings assigned by callers. An omitted terminal command is
reserved for the host's login shell when terminal opening is implemented.
`State` supplies typed inserts, lookups, lists, workspace updates, terminal state
updates and event acknowledgements. Migrations use `PRAGMA user_version` and reject
databases newer than the daemon. Events retain their references as historical IDs.
