# Linux VPS operation

Phase 1 uses a personal source build, with one compiled binary serving as both
`wsd` and `ws`. These instructions prepare deployment; they do not establish that
the Mac/VPS health gate or daily-use gate has passed. See [the spec](../../docs/spec.md).

## Prerequisites and source build

Build on macOS or Linux with Bun 1.3.14 or newer and git already available. The
destination is an x86-64 Linux VPS with glibc, systemd, Bash, tmux, git, curl,
`timeout` and administrator access. Bun is bundled in the executable and is not
needed on the VPS. Commands launched in terminals must already be available to
the `ws` account; agent CLIs and their logins are managed separately.

From a checkout of the desired commit, run at the repository root:

```sh
git rev-parse HEAD
bun --version
(cd protocol && ../scripts/serial.sh bun install --frozen-lockfile)
(cd daemon && ../scripts/serial.sh bun install --frozen-lockfile)
mkdir -p daemon/dist/linux-x64
scripts/serial.sh bun build --compile --target=bun-linux-x64 \
  daemon/src/main.ts --outfile daemon/dist/linux-x64/wsd
(cd daemon/dist/linux-x64 && ln -sfn wsd ws)
```

Record the source commit and Bun version with your deployment notes. The direct
[Bun cross-compile command](https://bun.com/docs/bundler/executables) uses the same
`src/main.ts` entrypoint as `daemon/scripts/build.ts`, without changing that build
script. The normal `bun run build` targets the build machine. Keep this Linux
artifact separate from a Mac build and do not execute it on the Mac. Invoking the
relative `ws -> wsd` symlink selects CLI mode. Install both names in the same
directory.

## Copy the deployment inputs

Use an SSH host or alias from your own `~/.ssh/config`. `vps` below is a placeholder;
keep actual targets outside the repository. The account used for these setup
commands needs sudo access and can differ from the daemon's `ws` account.

```sh
VPS=vps
ssh "$VPS" 'mkdir -p ~/wsd-deploy/scripts'
scp daemon/dist/linux-x64/wsd daemon/systemd/wsd.service "${VPS}:wsd-deploy/"
scp scripts/serial.sh "${VPS}:wsd-deploy/scripts/serial.sh"
ssh "$VPS"
```

The remaining setup commands run on the VPS, from `~/wsd-deploy`. Copy the existing
serial wrapper unchanged: it provides the same machine-wide build/start lock
without requiring a source checkout on the VPS.

## Administrator setup

Create the non-root account once on a fresh host. If it already exists, verify its
primary group is `ws`, its home is `/home/ws` and its login shell is `/bin/bash`.

```sh
cd ~/wsd-deploy
sudo useradd --create-home --home-dir /home/ws --shell /bin/bash --user-group ws
sudo install -d -o ws -g ws -m 0750 /home/ws /var/lib/wsd /workspaces
sudo install -d -o root -g ws -m 0750 /etc/wsd
sudo install -d -o root -g root -m 0755 /usr/local/bin /usr/local/lib/outscaled
sudo install -o root -g root -m 0755 scripts/serial.sh /usr/local/lib/outscaled/serial.sh

# Stage and rename so replacing a running executable also works on later updates.
sudo install -o root -g root -m 0755 wsd /usr/local/bin/wsd.new
sudo mv -f /usr/local/bin/wsd.new /usr/local/bin/wsd
sudo ln -sfn wsd /usr/local/bin/ws

sudo tee /etc/wsd/config.toml >/dev/null <<'TOML'
name = "vps"
workspaces_dir = "/workspaces"
TOML
sudo chown root:ws /etc/wsd/config.toml
sudo chmod 0640 /etc/wsd/config.toml
sudo install -o root -g root -m 0644 wsd.service /etc/systemd/system/wsd.service
sudo systemd-analyze verify /etc/systemd/system/wsd.service
sudo systemctl daemon-reload
sudo systemctl enable wsd.service
sudo /usr/local/lib/outscaled/serial.sh timeout 45s systemctl start wsd.service
```

The unit runs `/usr/local/bin/wsd` as `ws:ws`, with `/home/ws` as both `HOME` and
working directory. It reads `/etc/wsd/config.toml`, stores SQLite state in
`/var/lib/wsd/state.db`, creates workspaces under `/workspaces` and listens on
`127.0.0.1:7770`. Registered existing folders must be accessible to `ws`; give that
account the intended access before registering them. Configure any additional
command search paths for the service and the `ws` login shell to match where your
existing tools live.

All dependency installs, builds, full suites and daemon/service starts go through
`scripts/serial.sh` (the installed copy on the VPS). The `systemctl start` command
runs under `timeout 45s` and waits only for the systemd job, so the wrapper releases
the lock. A timeout is a failed setup step: inspect the unit and
logs before retrying; the queued systemd job may still finish. `Type=simple`
becoming active does not establish HTTP readiness; check health separately.

## Health and remote CLI

On the VPS:

```sh
sudo systemctl status wsd.service --no-pager
sudo journalctl -u wsd.service -n 100 --no-pager
curl --fail --show-error --max-time 5 http://127.0.0.1:7770/v1/health
sudo -u ws -H /usr/local/bin/ws health --json
```

On the Mac, use its native `daemon/dist/ws` build (see the [root README](../../README.md)).
With Phase 1 remote CLI support, `--on` accepts a host or alias from
`~/.ssh/config` and reaches the remote loopback daemon over SSH. Configure that
target to log in as `ws` when you also want to attach to its tmux sessions. Keep
the daemon bound to loopback; it needs no public HTTP port.

```sh
./daemon/dist/ws health --json
./daemon/dist/ws health --on vps --json
./daemon/dist/ws new demo --on vps --repo https://github.com/octocat/Hello-World.git
./daemon/dist/ws new existing --on vps --path /workspaces/existing
./daemon/dist/ws term open demo --on vps --name shell
./daemon/dist/ws term ls demo --on vps
ssh -t vps 'tmux attach -t ws-demo-shell'
```

The `--path` directory is on the selected server and must already exist. The
remote SSH login selects the transport; terminals still run as the service's `ws`
user. If your SSH login is an administrator instead, attach on the VPS with
`sudo -u ws -H tmux attach -t ws-demo-shell`.

The Phase 1 done-when check is: `GET /health` returns CPU, RAM, disk and terminal
count on both the Mac and the VPS. The actual versioned URL is `/v1/health`.
Check both responses for `cpu` (cores, load and usage), `ram` and `disk` (total
and used bytes), and `terminals` (total and running). These are verification
instructions, not recorded passing results; deployment and real-host verification
are performed separately by the orchestrator.

## Restart and update behavior

For later updates, repeat the build, copy and binary install steps, preserve the
existing config/state, then run on the VPS:

```sh
sudo -u ws -H tmux list-panes -a -F '#{session_name} #{pane_pid}'
sudo /usr/local/lib/outscaled/serial.sh timeout 45s systemctl restart wsd.service
sudo -u ws -H tmux list-panes -a -F '#{session_name} #{pane_pid}'
sudo -u ws -H /usr/local/bin/ws term ls demo
curl --fail --show-error --max-time 5 http://127.0.0.1:7770/v1/health
```

With the earlier demo terminal running, compare its pane PID before and after the
restart and confirm `ws term ls demo` lists it again. This is a persistence check
to perform on the deployed host, not a recorded result.

`Restart=on-failure` restarts a crashed daemon after one second. `KillMode=process`
is intentional: systemd stops only the main `wsd` process, leaving the tmux server,
panes and their commands alive for re-adoption when `wsd` starts again. The default
control-group kill would terminate those sessions during a restart. See
[systemd's KillMode documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

This unit deliberately shares the normal tmux socket and filesystem with the
`ws` account. Do not add `PrivateTmp`, sandbox restrictions or cgroup-wide process
cleanup: they can hide the socket, kill terminals or prevent agents from using
their normal files and permissions. Attach as `ws`, using the default tmux socket.
An explicit `systemctl stop` leaves terminals running too; a host reboot does not.
Supervision pauses while the daemon is stopped. Do not delete state or tmux sockets
between starts. Use the same state directory and account for re-adoption.
