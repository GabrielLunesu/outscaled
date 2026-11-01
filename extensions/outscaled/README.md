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

## Terminal grids (Phase 3, item 4 and live tab colours from item 5)

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
entry records the editor layout, optional preset id, and desired pane names,
commands, daemon terminal ids and view columns. Closing attach clients retains
these desired assignments. Automatic grid restoration and tracking manual
layout rearrangements are separate follow-up work.

Live client process ids map to daemon terminal ids. Shared daemon updates apply
only changed tab statuses through `_outscaled.setTerminalStatus`: starting and
working agents show a green spinner, idle agents and shells a grey dot,
permission/input requests a red dot, and crashed terminals a red cross. Exited
terminals show idle. No extra stream or SSH tunnel is opened for status.

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
attached 2×2 grid,
live terminal tab colours, session reuse and sidebar terminal focus. Fake Claude
and Codex executables print recognisable output and wait; attach clients use the
built `daemon/dist/ws`. Screenshots, `switch-proof.json` and grid proof records
go to `.agent-validation/grid` (or the first argument). Processes and temporary state are cleaned up on success and failure.
