# Outscaled — System Spec

Oct 23, 2026 · @Gabriel

## Overview

One app to create workspaces on any machine you own (your Mac or any VPS), run always-on and scheduled agents in them, see every file in native VS Code, and jump onto that machine's desktop when an agent needs a human.

**Goals**

- **Workspaces anywhere:** pick local or a server; a workspace is a folder agents work in.
- **Servers registered once**, health-checked continuously.
- **A herdr-style sidebar:** every workspace and its agents with live status; one click switches workspace.
- **Native terminal grids:** open 1, 2 or 4 terminals in a workspace with one click and launch Claude Code or Codex in each. No manual terminal juggling.
- **Live status on every terminal tab:** idle, working, or needs you.
- **Agent-controlled terminals:** agents can open terminals, launch more agents and read what happens in them, natively.
- **Always-on and scheduled agents:** native sessions that keep running, or a prompt or script every X minutes.
- **A desktop and logged-in Chrome per server**, shared between the agents and you.

**Non-goals for v1**

- Installers, onboarding and versioned releases: v1 is a personal build, published as source on GitHub.
- Phone access and push notifications.
- Networking beyond SSH: v1 reaches remote daemons through SSH tunnels.
- Several workspaces visible at once; v1 switches between them.
- Team accounts or multiple users.
- Our own agent loop. We host Claude Code and Codex; we don't replace them.
- Windows hosts.

## Workspaces and terminals

The main screen is a herdr-style sidebar on the left and the selected workspace's terminal grid on the right; the explorer, editor and git view follow whichever workspace is selected.

**Sidebar**

- Workspaces grouped by server; under each, its terminals with agent name and a status dot.
- Click a workspace and the explorer and terminal grid switch to it. Click a terminal to focus that pane.
- A badge on each workspace counts terminals that need you, so you see it without opening the workspace.

**Terminal grid**

- One-click layouts, drawn below: single, side by side, stacked, 2×2, four across, and two stacked with one full-height pane on the right.
- Launch presets fill the grid, such as "2 Claude + 2 Codex" or "1 Claude + shell", plus presets saved per workspace.
- Every pane is a native VS Code terminal in the editor area, attached to a tmux session the daemon owns. Agents keep running when you switch workspace or close the app.
- Each workspace remembers its grid, and switching back restores it.

&#91;embedded content: grid layouts · 6 built in\]

A launch preset fills panes left to right, top to bottom; in 2 + 1, the full-height right pane comes last.

**Status on terminal tabs**

| Status | Tab shows | Detected from |
| --- | --- | --- |
| Idle | Grey dot | Claude Code Stop hook; Codex notify at turn end; shell prompt back |
| Working | Green spinner | Claude Code UserPromptSubmit and PreToolUse hooks; output activity |
| Needs you | Red dot, sidebar badge, OS notification | Claude Code Notification hook (permission or input request) |
| Crashed | Red cross | Process exited unexpectedly |

**Agent-controlled terminals**

This is the job a terminal multiplexer does (what tmux and herdr are), built in natively. `wsd` exposes terminals to agents as an MCP server and through the `ws` CLI:

- `terminal_open(name, command)`: open a pane in the agent's workspace, for example a new Codex agent.
- `terminal_list()`: panes and their status.
- `terminal_read(id, lines)`: recent output.
- `terminal_send(id, text)`: type into a pane.
- `terminal_wait(id, status)`: block until a pane is idle or needs input.

Panes an agent opens appear in your sidebar and grid like any other, so you can watch them or take over.

## Architecture

Every machine runs the same daemon (`wsd`), and the fork and the CLI are both clients of it.

&#91;embedded content: system architecture · client, tailnet, daemons\]

Adding a server means installing `wsd` and adding its address in the client, which starts health checks. Each VPS has its own desktop with the apps you installed there; the Mac needs none.

## Core concepts and data model

Seven entities cover everything; each daemon stores its own in SQLite, and the client merges them across machines.

| Entity | What it is | Key fields |
| --- | --- | --- |
| Server | A machine running `wsd` (your Mac or a VPS) | id, name, tailnet address, proce (local / vps), health, desktop (VPS only) |
| Workspace | A folder on a server that agents work in: a fresh clone, or an existing folder registered in place | id, server, path (`/workspaces/<slug>` or the existing folder), repo URL, default browser profile |
| Agent | A process that lives in a workspace | id, workspace, runtime (claude-code / codex / script), mode (always-on / scheduled / one-off), tmux session, state |
| Schedule | When a scheduled agent fires | agent, interval or cron, prompt file or command, overlap policy (skip / queue) |
| Run | One execution of a scheduled or one-off agent | id, agent, started, ended, exit code, log path |
| Event | Something that happened that the client should know | id, server, workspace, agent, type, payload, time, acked |
| Desktop | The server's GUI session | stream URL, Chrome profiles, CDP port per profile |

Agent states run `starting → working → needs_input → idle`, with `stopped` and `crashed` as exits; `needs_input` is the state that triggers a notification.

A **terminal** is one pane in a workspace's grid, backed by a tmux session the daemon owns. It runs a shell or an agent and carries that agent's status, which is what its tab and the sidebar show.

## Daemon (wsd)

`wsd` is one binary per machine, run as a systemd service on VPSs and a launchd agent on the Mac, listening on localhost. It is the product; the client is a view over it.

**Responsibilities**

1. Report health: version, uptime, CPU, RAM, disk, agent counts.
2. Create, list and delete workspaces; clone a repo into a new one, or register an existing folder in place without copying or moving it.
3. Own every terminal as a tmux session: start, stop and supervise them, track their status, and expose them to agents over MCP.
4. Run schedules and record each run with its log.
5. Receive hook calls from Claude Code, Codex and scripts, and turn them into events.
6. Push events to connected clients.
7. Manage the desktop: Chrome profiles and CDP ports.
8. Serve files to the client's cross-server view.

**Process model**

- Each agent runs in its own tmux session named `ws-<workspace>-<agent>`, so herdr and WezTerm can still attach directly.
- Always-on agents restart with backoff (1 s, 5 s, 30 s, then capped at 5 min). After five failed restarts the agent goes to `crashed` and an event fires.
- Agents run as a non-root `ws` user.

**On-disk layout**

```
/etc/wsd/config.toml          # server name, tailnet bind, notify targets
/etc/wsd/presets.toml         # grid layouts and launch presets
/var/lib/wsd/state.db         # SQLite: workspaces, agents, schedules, runs, events
/var/lib/wsd/logs/<slug>/<agent>/<run>.log   # one log per scheduled or one-off run
/workspaces/<slug>/           # the repo or folder agents work in
/workspaces/<slug>/.ws/
    workspace.toml            # agents, schedules, browser profile
    prompts/<name>.md         # prompts for scheduled agents
/workspaces/.trash/           # soft-deleted workspaces
```

On the Mac, `wsd` runs as you and the root volume is read-only, so the defaults move to your home folder: workspaces in `~/workspaces/`, config in `~/.config/wsd/`, state in `~/.local/share/wsd/state.db` and run logs in `~/.local/share/wsd/logs/`. On any machine, `workspaces_dir` in `config.toml` overrides where new clones go.

Config lives inside the workspace, so it travels with the repo. `wsd` only reads it: it never writes into a workspace, so folders registered in place stay clean.

```toml
[[agent]]
name    = "builder"
runtime = "claude-code"
mode    = "always-on"

[[agent]]
name    = "ad-check"
runtime = "claude-code"
mode    = "scheduled"
every   = "30m"
prompt  = "prompts/ad-check.md"
browser = "ads"           # Chrome profile on this server's desktop
```

## Daemon API

HTTP + JSON for commands and one WebSocket for live events and terminal streams, at `http://localhost:7770/v1`. The `ws` CLI and the client use the same API.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/health` | Version, uptime, CPU, RAM, disk, agent counts |
| GET / POST | `/workspaces` | List; create `{slug, repo?}` |
| DELETE | `/workspaces/:ws` | Move to `.trash`; hard delete only with `?purge=true`. A folder registered in place is only unregistered, never moved |
| GET / POST | `/workspaces/:ws/terminals` | List; open `{name, command, alwaysOn?}` as tmux session `ws-<workspace>-<name>` |
| GET / POST | `/workspaces/:ws/agents` | List; create from a workspace.toml entry or inline |
| POST | `/agents/:id/start` · `stop` · `restart` | Lifecycle |
| POST | `/agents/:id/input` | Send text to the agent's tmux pane |
| GET | `/agents/:id/runs` · `/runs/:id/log` | Run history and logs |
| GET / PUT | `/fs/:ws/*path` | Stat, list, read, write for the client's file view |
| GET | `/desktop` | Stream URL, Chrome profiles, CDP ports |
| POST | `/hooks/:runtime` | Hook intake; accepted from localhost only |
| WS | `/stream` | Events; subscribe to an agent's terminal by id |

**Event types:** `agent.started`, `agent.needs_input`, `agent.finished`, `agent.crashed`, `run.started`, `run.finished`, `server.health` (every 15 s), `workspace.changed`.

**Terminal events:** every status change fires `terminal.status` with the terminal id and its new state, which drives the tab colours and sidebar badges.

**Transport and auth:** out of scope for v1. `wsd` binds to localhost, and the client reaches remote daemons through an SSH tunnel it opens itself.

## Agents

Agents come in three modes, and every mode reports "needs you" through the same event, so one notification path covers all of them.

**Modes**

1. **Always-on:** an interactive Claude Code or Codex session in tmux, supervised and restarted on crash. You attach from a VS Code terminal or herdr.
2. **Scheduled:** every X minutes `wsd` runs a headless command in the workspace (`claude -p "<prompt>"`, `codex exec "<prompt>"`, or any script), logs the output and records a run. If the previous run is still going, the next one is skipped.
3. **One-off:** started from the client with a prompt; recorded as a run.

**Needs-me detection**

- **Claude Code:** `wsd` starts Claude with its hooks passed at launch (`claude --settings <file>`), so nothing is written into the workspace. Its hooks call `ws hook claude-code`: a prompt or tool use means `working`, a permission prompt means `needs_input`, and the end of a turn means `idle`.
- **Codex:** `wsd` starts Codex with `-c notify=["ws", "hook", "codex"]`, leaving the global Codex config alone; Codex calls it with a JSON payload when a turn completes (`idle`), and new pane output means `working`.
- **Scripts:** a non-zero exit fires `run.finished` with an error; a script can also call `ws notify "<message>"`.
- **Fallback:** a pane with no output for N minutes while its process is alive fires a low-priority "possibly stuck" event.

**Routing:** in the app only. The terminal tab turns red, the workspace gets a badge in the sidebar, and an OS notification fires for `needs_input` and `crashed`.

## Desktop and browser

Every VPS has its own desktop, set up directly on the host (XFCE plus Selkies for streaming), so apps you install on a server show up on its desktop and all its workspaces share it. The Mac needs none: you're already on its desktop.

- **Per-server apps:** install whatever a server needs on that VPS; other servers stay different.
- **Chrome per profile:** launched by `wsd` with `--user-data-dir=/home/ws/chrome/<profile>` and `--remote-debugging-port=<9222+n>`, bound to localhost.
- **Agent access:** Playwright MCP (`--cdp-endpoint`) or chrome-devtools-mcp (`--browser-url`). `wsd` writes the MCP config into the workspace's `.mcp.json`.
- **You take over** by opening the server's PC panel: the same windows, live. First logins and 2FA are always yours.
- **Persistence:** profiles are never wiped, so logins stay.
- **Local Mac:** no desktop stream; agents use your own Chrome, and the PC panel is hidden.

## Client (the fork)

The client is a direct fork of microsoft/vscode (Code-OSS) at the repo root, so the whole app sits in one tree and is patched in place. Branding and Open VSX are set in `product.json`. Most features ship as a built-in extension in `extensions/outscaled/`; core changes live in `src/vs/workbench/contrib/outscaled/` wherever possible, which keeps upstream merges small.

| Feature | How | Core patch |
| --- | --- | --- |
| Workspace sidebar | Tree view fed by each daemon, with status dots and need-you badges | No |
| Switch workspace in one window | Multi-root window over `ws://<server>/<workspace>`; switching changes which root and which terminals show | Yes: hide other workspaces' terminals and restore each grid |
| Terminal grid and launch presets | Editor-area terminals placed with the editor layout command (2×2 and others), each attached to a daemon tmux session | No |
| Live status on terminal tabs | Extensions can set a terminal's icon and colour only at creation, so live changes need core | Yes |
| Agent dashboard | Webview over every daemon's events | No |
| PC panel | Webview embedding the server's Selkies URL | No |
| Branding, onboarding, add-server flow | Later; v1 is a personal build | Yes |

VPS workspaces are daemon-served: the explorer, editor and search read files through the daemon, so switching is instant and language servers run on your Mac. A full remote window (open-remote-ssh) can come later if heavy remote coding needs it.

## Assumptions

One trusted user on machines they own: this is a power tool for heavy multi-agent work, not a hardened platform.

- Daemons bind to localhost; remote daemons are reached over SSH.
- Agents run with your own permissions and logins; no sandboxing between workspaces.
- Deletes are soft, into `/workspaces/.trash`.
- Chrome profiles are never wiped, so logins persist.

Agents use the Claude Code and Codex subscription logins already on each machine. `wsd` launches `claude` and `codex` as they are and never stores or manages credentials.

## Tech choices

TypeScript end to end: the daemon, the CLI, the extension and the fork share one set of API types.

| Component | Choice | Why |
| --- | --- | --- |
| Daemon + CLI | TypeScript on Bun, compiled to one binary (`bun build --compile`) | Decided. Same language as the client; one file to install per server. |
| State | SQLite, one file per machine | Zero ops |
| Terminals | tmux sessions owned by `wsd` | Survive app restarts; herdr and WezTerm can still attach |
| Agent terminal tools | MCP server inside `wsd`, plus the `ws` CLI | Works from both Claude Code and Codex |
| Status detection | Claude Code hooks, Codex `notify`, output activity | Native signals first, heuristics only as fallback |
| Desktop | XFCE + Selkies on each VPS host | WebRTC, clipboard and file transfer; fine on CPU-only VPSs |
| Browser control | Chrome + CDP with Playwright MCP or chrome-devtools-mcp | Works with both Claude Code and Codex |
| Client | Direct fork of microsoft/vscode at the repo root | Whole app in one tree; upstream merged in from release tags |
| Full remote window | open-remote-ssh | Later, only if daemon-served files fall short |

## Roadmap

v1 is phases 1 to 4, desktop included. The daemon comes first: phases 1 and 2 are usable from the CLI and herdr, so the fork in phase 3 starts from a working system.

&#91;embedded content: roadmap · 5 phases, a gate after each\]

A phase is done when its gate holds in daily use, not when the code merges.

## Build brief

Everything an agent needs to start: the decisions, the repo layout, and a done-when checklist per v1 phase. One agent session per phase; a phase starts only when the previous phase's checks pass.

**Decisions**

| Decision | Choice |
| --- | --- |
| v1 scope | Phases 1 to 4: daemon, status and agent terminals, client fork, desktop and browser |
| Remote workspaces | Daemon-served files in one window; no VS Code server on the VPS |
| Audience | Personal build, open source from day one (MIT); no installer, onboarding or releases |
| Daemon | Bun + TypeScript, compiled to one binary |
| Client | Fork of microsoft/vscode at the repo root; features in a built-in extension, core changes only for workspace switching and live tab status |
| Remote access | SSH tunnels opened by the client |
| CLI server target | `--on local` or an SSH host/alias from `~/.ssh/config`; server details stay outside the repo |
| Server list | `~/.config/outscaled/servers.toml` lists the SSH hosts that `ws status` covers; `local` is always included |
| Agent hooks | Passed at launch (`claude --settings`, `codex -c notify=…`); never written into workspaces or global agent configs |
| Agent MCP tools | `ws mcp`, a stdio MCP server that talks to the wsd API |
| Run logs | In wsd's state folder (`logs/<workspace>/<agent>/<run>.log`), never inside the workspace |
| Pane attach | Grid panes run `ws attach <workspace> <name> [--on <server>]`: `tmux attach` locally, `ssh -t <host> sudo -n -u ws tmux attach` on a VPS |
| Workspace roots | Mac workspaces open as local `file://` folders (native git, search and language servers); VPS workspaces as `ws://<server>/<workspace>`, served by wsd |

**Repo layout (the VS Code fork is the root)**

```
/                                    microsoft/vscode fork: src/, build/, product.json, package.json
src/vs/workbench/contrib/outscaled/  core changes: workspace switching, live tab status
extensions/outscaled/                built-in extension: sidebar, grid, presets, PC panel
daemon/                              wsd + ws CLI (Bun, TypeScript)
protocol/                            shared API and event types (zod schemas)
desktop/                             VPS desktop setup (XFCE + Selkies) + Chrome launcher
docs/                                spec.md, ORCHESTRATOR.md
scripts/serial.sh                    one build or full test suite at a time
```

**Phase 1 · Daemon core: done when**

- [x] `ws new <slug> --on <server> [--repo <url> | --path <dir>]` creates the folder and clones the repo, or registers an existing folder in place.
- [x] `ws term open <workspace> --name a1 --cmd claude` creates tmux session `ws-<workspace>-a1`, and herdr can attach to it.
- [x] Killing `wsd` leaves terminals running; restarting it re-adopts them.
- [x] An always-on agent killed with `kill -9` restarts within 5 s.
- [x] `GET /health` returns CPU, RAM, disk and terminal count on both the Mac and the VPS.

**Phase 2 · Status and agent terminals: done when**

- [x] A Claude Code terminal shows `working` within 1 s of a prompt, `idle` at turn end, and `needs_input` on a permission prompt.
- [x] A Codex terminal shows `working` on output and `idle` on notify.
- [x] `ws status` lists every terminal on every server with its state.
- [x] From inside Claude Code, the MCP tools open two Codex terminals, send each a prompt, wait for idle and read their output.
- [x] A schedule with `every = "10m"` runs a headless prompt and stores its log.

**Phase 3 · Client fork: done when**

- [x] The fork runs from source on macOS with the built-in extension.
- [ ] The sidebar shows workspaces from the Mac and one VPS, with status dots updating live.
- [ ] Clicking a VPS workspace switches explorer and editor to it without reloading the window.
- [ ] "2 Claude + 2 Codex" opens a 2×2 grid of terminals attached to tmux sessions.
- [ ] Tab colours change live (grey, green, red), and switching back to a workspace restores its grid.
- [ ] Needs-you fires an OS notification; clicking it focuses that terminal.

**Phase 4 · Desktop and browser: done when**

- [ ] `ws desktop setup <server>` installs XFCE + Selkies on the VPS host, and its desktop shows in the PC panel through the SSH tunnel.
- [ ] `ws browser open <profile>` starts Chrome with its own profile and CDP port, and the workspace's `.mcp.json` points Playwright MCP at it.
- [ ] An agent completes a browser task in a profile you logged into, while you watch in the PC panel and can take over.
- [ ] An app you install on one VPS appears on that server's desktop and not on the others.

**Biggest risk:** the two core patches in phase 3. Before building features there, run a spike: get the fork running from source, then prototype live tab colours and per-workspace terminal restore. If either is much harder than expected, we learn it before the extension work depends on it.

## Open source workflow

Outscaled is public on GitHub from the first commit, but run like a personal project: no releases or version numbers, just a history anyone can read.

- **Repo:** `outscaled`, public, MIT license. VS Code's own source is MIT too, so LICENSE.txt keeps Microsoft's copyright notice beside ours. microsoft/vscode stays as the upstream remote, merged in from release tags.
- **Branching:** small changes go straight to `main`. Anything spanning several files, or ticking a phase checklist item, goes through a PR. CI checks are advisory, never blocking.
- **PRs:** one logical change each, titled as the change ("Re-adopt tmux sessions when wsd restarts"), with a short what-and-why and the checklist item it ticks.
- **Commits:** Conventional Commits with a scope, such as `feat(daemon): …`, `fix(extension): …`, `chore(fork): …`. Imperative, under 72 characters, with a body when the why isn't obvious.
- **README:** what Outscaled is, what works today, what's next, and how to run it from source. Updated when a phase lands; it's allowed to change as the plan changes.
- **AGENTS.md** (read by Codex; `CLAUDE.md` points to it for Claude Code): the repo is public; follow the commit and PR rules above; never commit secrets, server names, IPs, emails or anything from your own machines; this spec and the phase checklists are the source of truth.
- **Keeping it clean:** `.gitignore` covers `.ws/logs`, `.env` and local config, and a gitleaks pre-commit hook catches secrets before they're pushed. Your own servers and presets live outside the repo, in `~/.config/outscaled/`.

## Open questions

None left. Launch presets are defined in `presets.toml`; "2 Claude + 2 Codex" ships as the default.
