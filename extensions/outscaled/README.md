# Outscaled extension

The built-in extension owns one `DaemonService` connection per server. The sidebar
and the `ws` filesystem provider share those connections and SSH tunnels.

## Workspace switching (Phase 3, item 3)

Click a workspace in the Outscaled sidebar, or run **Switch Outscaled Workspace**
(`outscaled.switchWorkspace`). The first click opens a dedicated multi-root window
and can reload once. Its workspace file is created at
`$OUTSCALED_CONFIG_DIR/outscaled.code-workspace`, defaulting to
`~/.config/outscaled/outscaled.code-workspace`.

Folder zero is the fixed, empty, read-only `ws://outscaled/` placeholder. Switching
replaces only folder one using `workspace.updateWorkspaceFolders` and waits for
the folder-change event before handling another switch. Local workspaces use
their actual `file://` folder; VPS roots use `ws://<host>/<slug>/`. VS Code may
normalize away that trailing slash. The selected workspace is persisted and
marked in the sidebar.

Clean file editors from the previous workspace close and are remembered by host
and slug, including their editor group and which tab was active. Switching back
reopens them. Dirty editors stay open without an automatic save. Editor memory
is stored in extension workspace state. `WorkspaceSelection` in
`src/workspaces/selection.ts` exposes the current selection and
`onDidChangeSelectedWorkspace`, carrying the previous and current workspace for
terminal-grid consumers.

The filesystem provider supports stat, list, read and write through `/v1/fs`.
Daemon failures become the corresponding VS Code filesystem errors. Watching is
a no-op; mkdir, delete and rename report that wsd does not support them yet.

## Terminal grids (Phase 3, items 4–5)

Run **Outscaled: Open Grid…** in a selected workspace, or use its workspace
context menu. The built-ins are **2 Claude + 2 Codex**, **1 Claude + shell**,
and shells in each of six layouts: single, side by side, stacked, 2×2, four
across, and two stacked with a full-height pane on the right. Presets and fill
order live in `src/grid/presets.ts`. Panes fill left to right, then top to bottom;
the full-height right pane in 2+1 fills last.

Each native editor terminal runs `ws attach <workspace> <name>`, adding
`--on <host>` for a VPS. Set **outscaled.wsPath** to an executable path if needed;
otherwise the extension searches PATH, `~/.local/bin`, `/opt/homebrew/bin`, then
`/usr/local/bin`. `~/` paths are supported. `WSD_PORT` and `WSD_TMUX_SOCKET` pass
through to attach clients when set. Agents launch through the shared
`DaemonService`; a fresh terminal-list request reuses an already running name,
including a concurrent create from another client. Numbering is per command,
so the default uses `claude-1`, `claude-2`, `codex-1`, `codex-2`.

Closing a tab detaches its client; the daemon session keeps running. Opening the
preset again reuses those sessions. Clicking a sidebar terminal focuses its
existing client, or attaches in the active editor group after switching to that
workspace. Attach clients are transient so VS Code does not restore them on its
own. The initial switch into the dedicated window can reload; explicit grid or
terminal opens resume after that reload.

`TerminalGrid.memory` exposes `GridMemory` (`src/grid/memory.ts`), with a durable
snapshot in workspace state under `outscaled.workspaceGrids`. Each host/slug
entry records the actual editor layout (including sizes), optional preset id,
and pane names, commands, daemon terminal ids and view columns. Tab objects bind
owned attach clients to their editor groups; manual moves and closes update the
snapshot. Group/tab events capture changes, with a deduplicated local layout
poll to catch sash resizes and a final flush on extension deactivation.

Before a root switch, the extension snapshots and closes the outgoing workspace's
attach clients through `Terminal.dispose()`, bypassing editor-terminal kill
confirmations without changing `terminal.integrated.confirmOnKill`. It waits for
their tabs to disappear before setting the next layout. If tab removal stalls
for three seconds, it logs an error and continues the switch. After switching it
sets the remembered layout and reattaches the incoming panes before reopening
file editors. The same selected grid restores automatically after a window reload, from workspace state in that Outscaled
window. No core grid patch or window/extension-host reload is needed for switches.
Restore only lists daemon terminals and attaches running original ids; missing,
exited, crashed, restarting or replaced terminals are omitted, leaving any empty
groups in the saved layout. It never creates agents. A failed daemon request
leaves the remembered grid available for the next switch/reload instead of
replacing it with an empty snapshot.

Live client process ids map to daemon terminal ids. Shared daemon updates apply
only changed tab statuses through `_outscaled.setTerminalStatus`: starting and
working agents show a green spinner, idle agents and shells a grey dot,
permission/input requests a red dot, and crashed terminals a red cross. Exited
terminals show idle. No extra stream or SSH tunnel is opened for status.

## Needs-you notifications (Phase 3, item 6)

Real transitions into needs-input or crashed send an OS toast and an in-app warning or error with the same title and text and a **Focus** button. Both follow `outscaled.notifications.enabled` and are suppressed when the window is focused and that pane is visible. Startup and reconnect snapshots establish silent baselines. Each transition produces one in-app message, even while an earlier OS toast is pending.

When the window is in the background, core also requests attention through `FocusMode.Notify`: a Dock bounce and badge on macOS, or a frame flash elsewhere, without stealing focus. This runs alongside the OS toast because macOS can silently drop notifications from an ad-hoc signed dev build while Electron still reports success. Clicking the OS toast or **Focus** switches to the workspace and focuses or opens the terminal through the same routing path. Pending messages ignore clicks after disposal or removal of the terminal/server.

## Validation

From the repository root, with existing dependencies and client output:

```sh
scripts/serial.sh npm run gulp compile-extension:outscaled
npm --prefix extensions/outscaled run typecheck
scripts/serial.sh npm --prefix extensions/outscaled test
```

Build the fixture daemon if `daemon/dist/wsd` is absent:

```sh
(cd daemon && ../scripts/serial.sh bun run build)
scripts/serial.sh node extensions/outscaled/test/ui.mts
```

The Playwright check uses throwaway profiles, config, registered local files,
remote files, two isolated daemons, tmux sockets and fake SSH. It checks remote
editing/saving, native local roots, editor restoration, dirty-editor retention,
selection after an explicit reload, and renderer/extension-host/tunnel survival
during switches. It also checks the sidebar's live status behavior, a real
attached 2×2 grid, live terminal tab colours, session reuse and sidebar terminal focus. It switches
between a local 2×2 agent grid and a remote side-by-side Claude/shell grid,
verifies a typed marker and the same daemon identities after restoration, proves
renderer/extension-host/tunnel survival, then reloads and checks the selected
grid restores automatically. It also verifies manual cross-group moves, closed
panes and omission of an exited daemon terminal. The harness retains the default
`confirmOnKill` setting, waits for VS Code to detect every attach client's child
process, verifies live child PIDs before switches, and fails if detach requests a
native termination confirmation. Explicit user closes are confirmed by the
test-only native-dialog observer. Fake Claude and Codex executables print
recognisable output and wait; attach clients use the built `daemon/dist/ws`.
The notification scenarios first simulate an OS-toast click, then remove the test interception and exercise the real core command with workspace B selected and the workbench window blurred (disabling Playwright focus emulation so the host observes native focus). They assert an informational Dock bounce without stealing focus, one in-app warning with **Focus**, and restoration of workspace A with terminal keyboard focus after clicking it. Native OS-toast display and click delivery remain outside the hermetic check. Screenshots `26-fallback-background.png` and `27-fallback-focus-terminal.png` and `notification-fallback-proof.json` record this fallback. Screenshots, `switch-proof.json` and grid proof records go to `.agent-validation/grid` (or the first argument). Processes and temporary
state are cleaned up on success and failure.
