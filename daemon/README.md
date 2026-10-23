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
