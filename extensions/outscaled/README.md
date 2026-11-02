# Outscaled extension

The built-in extension owns one `DaemonService` connection per server. The core sidebar and agents view receive snapshots through the bridge; the `ws` filesystem provider shares those daemon connections and SSH tunnels.

## Default colour theme

Fresh profiles use **Carbon Candy Matrix Cyber**. Choose another theme with
**Preferences: Color Theme**; an explicit user choice takes precedence over this
extension's `workbench.colorTheme` default (`carbon-candy-matrix-neon-blur`, the
contributed theme id used by VS Code as its settings id).

The theme is by Alessandro Torrisi (Viral Team), from
[Carbon Candy](https://github.com/viral-team/carbon-candy-theme), pinned to commit
[`0793a0766d658923681c662bbc4c49c873113623`](https://github.com/viral-team/carbon-candy-theme/tree/0793a0766d658923681c662bbc4c49c873113623).
`themes/carbon-candy-matrix-neon-blur.json` is copied byte for byte; its MIT licence
and copyright are in [themes/LICENSE-carbon-candy.txt](themes/LICENSE-carbon-candy.txt).
Only this colour theme is bundled; Carbon Candy's runtime and icon themes are not
included.

The full Carbon Candy extension can also be installed. VS Code gives each theme
an internal id derived from its extension and path, so the contributions coexist.
For duplicate settings ids, the theme registry returns the first match. Built-in
extensions register before user extensions, so the default resolves to Outscaled's
bundled copy even with Carbon Candy installed.

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

Core preserves Code editors and editor-group layout in native VS Code working sets, keyed by workspace. Switching roots and switching Agents / Code use one serialized core path. Dirty editors keep VS Code's normal protection.

The filesystem provider supports stat, list, read and write through `/v1/fs`.
Daemon failures become the corresponding VS Code filesystem errors. Watching is
a no-op; mkdir, delete and rename report that wsd does not support them yet.

## Agents view (Phase 4, item 1)

The regular workbench opens in Agents mode. One core editor fills the main area with native terminal panes.

The core **Workspaces** sidebar replaces the extension tree with one row per workspace in bridge order. Each row shows its name, a badge counting waiting agents, one status dot per terminal (including agents outside the grid), and a muted folder path, branch when known, and VPS server name. Local home paths shorten to `~`. Offline workspaces stay listed, dimmed and labelled Offline. Clicking a row switches workspace; clicking a dot switches and focuses that agent. Arrow keys move through the list and Enter switches; ⌘1 through ⌘9 (Ctrl on other platforms) select the first nine workspaces from anywhere, in either mode. Empty lists explain `ws new <name>`. Status updates retain row and dot nodes and keyboard focus.

Code mode shows the native Explorer and restores its editors and tabs. Agents mode hides tabs and editor title actions. The title control replaces the command center with the selected workspace and available local Git branch, **New agents**, a cross-workspace needs-you count, and **Agents / Code**. Layout controls are disabled. Chat and workbench chrome removal are a separate contribution.

**Outscaled: Open Grid…** and **New agents** open the existing preset picker. The built-ins are **2 Claude + 2 Codex**, **1 Claude + shell**, and shells in six layouts: single, side by side, stacked, 2×2, four across, and two stacked with a full-height pane on the right. Presets fill left to right, then top to bottom; the full-height right pane in 2+1 fills last. Layouts are split trees defined in `src/vs/workbench/contrib/outscaled/common/agentsLayout.ts`, with an insertion operation for later pane menus.

Each pane has an agent name, runtime badge, and live status: grey idle, green working, red needs you, or a red cross for crashed. Waiting panes have a red outline. Native terminal command routing, keyboard input, copy/paste, select all, find, clear, links, and the terminal context menu use VS Code's existing terminal services and contributions. A small core subclass of the native terminal editor service redirects reveal/focus calls for owned panes back to Agents, while ordinary terminals use the upstream implementation.

Core owns attach clients in a long-lived owner per workspace. Hiding the editor, switching roots or modes, and closing Code editors do not dispose or reattach them. Changing presets changes placement while retaining existing clients. Explicit terminal kill commands detach the client; daemon sessions remain daemon-owned. A daemon membership removal disposes the corresponding client. New daemon-created terminals join the grid; terminals omitted by a replacement preset remain retained for later views. Background-strip UI is a later checklist item.

Panes run `ws attach <workspace> <name>`, adding `--on <host>` for VPS workspaces. Set **outscaled.wsPath** if needed; otherwise the extension searches PATH, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. `WSD_PORT` and `WSD_TMUX_SOCKET` pass through when set. A fresh terminal-list request reuses running daemon terminals, including a concurrent create from another client. Transient clients are rebuilt after a window reload from persisted grid membership, attaching the original daemon ids and tmux sessions without launching agents again.

### Internal bridge

`common/agentsBridge.ts` is the shared, dependency-free version 1 contract, imported by core and bundled into the extension. `_outscaled.agents.publish` sends workspace identity, root, selection, connectivity, optional branch and daemon folder path (distinct from virtual VPS roots), layout tree, terminal state, and launch descriptors. Core returns a receipt with client process ids and visibility. `_outscaled.agents.inspect` reads current visibility for notification suppression. `_outscaled.agents.request` asks the extension to switch workspace, open the preset picker, or focus a daemon terminal by identity. Invalid versions or payloads are logged and return an error receipt; they cannot reach view construction. Core never connects to a daemon or starts an SSH tunnel.

`GridMemory` stores validated split trees and known daemon identities in workspace state under `outscaled.agentsGrids.v1`. It reconciles immutable terminal ids, leaving empty slots for removed terminals, and never matches a replacement session by name. Preset and focus requests await a fresh membership snapshot through the existing connection, so a snapshot started before terminal creation cannot remove a new attach client. Per-workspace Code working sets and mode use core's `outscaled.workspaceModes.v1` storage. The initial entry into the dedicated Outscaled window may reload once; pending preset/focus requests resume afterwards.

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

The Playwright acceptance check uses a throwaway profile, config, private `WSD_PORT` and `WSD_TMUX_SOCKET`, and fake Claude/Codex executables that echo typed input. It verifies the core sidebar and removal of the extension tree, row and dot switching, live badges and hovers, keyboard navigation and workspace shortcuts in both modes, pane headers, status hooks and needs-you routing across workspaces, native paste/find, unchanged terminal instances and attach process ids after closing Code editors, preserved tmux output, two workspace grids after reload, and all six layout geometries. A private SSH double also verifies `ws attach --on`, input and Code-mode file reads for a VPS workspace, without contacting a real SSH host or the daemon on port 7770. It saves screenshots and proof records to the supplied directory, then stops the app, daemon and private tmux server and removes fixture state. Use `UI_INSPECT_LAUNCH=1` to pause after each launch screenshot for visual inspection; create `launch-inspected` in the evidence directory to continue.


## New agents (Phase 4, item 2)

Press ⌘N anywhere, including inside a terminal, or click **New agents** in the title bar. Choose a preset and click **Create**, or type a command such as `2x2 claude`, `codex right`, `2 claude 2 codex`, `stacked shell` or `claude every 30m`. The dialog shows the interpreted layout, agent per pane, run mode and placement; unrecognized text is reported. All six layouts support pane-specific Claude, Codex and Shell choices.

**Replace View** replaces grid membership without stopping any daemon session. Replaced agents remain in the sidebar dots and stay outside the grid after reload. **Add to View** places the chosen layout to the right of the whole grid; **Right of…** and **Below…** insert beside the pane focused before opening the dialog. The first new pane receives focus. New launches allocate the next unused name for each runtime, including names held by exited terminals. Existing sessions are never restarted by a launch.

**Quick** creates ordinary terminals. **Always On** passes the daemon's `alwaysOn` flag. **Scheduled** accepts intervals such as `30m`, `2h` and `1d` and can be saved as a preset, but Create remains disabled until Phase 4 item 5 implements scheduled agents in terminals. A first prompt is passed as one safely quoted initial argument to Claude and Codex, so it survives startup screens. Shell panes ignore it.

**Save as Preset** stores all choices under a name for the selected workspace (including its server), in `$OUTSCALED_CONFIG_DIR/presets.toml`, defaulting to `~/.config/outscaled/presets.toml`. The file uses `[[preset]]` entries with `workspace`, `name` and a `choices` table. Saves replace a matching name in that workspace and preserve other workspaces. This is personal configuration outside the repository. Built-in presets remain available alongside saved ones.

The version 1 internal bridge adds validated `presets`, `savePreset` and `launch` requests; old request and snapshot shapes remain valid. Core owns the modal and pure command parser; the extension owns persistence, launch planning and daemon calls. The legacy **Open Terminal Grid** command continues to reuse its named terminals.

Run the hermetic acceptance harness after building client and extension output:

```sh
scripts/serial.sh node extensions/outscaled/test/ui.mts /absolute/path/to/evidence
```

It uses a dynamically assigned daemon port, a private tmux socket, throwaway app profile and configuration, and fake agent/SSH executables. It verifies existing terminal behavior plus the modal, typed commands, non-destructive replacement and reload, insertion, literal first prompts, run modes and saved presets; it writes screenshots and cleanup evidence to the chosen folder.

## Changes and Code (Phase 4, item 7)

**Changes** in the title bar shows the selected workspace's daemon-reported changed-file count. Its drawer lists statuses and agent attribution, with newest edits first. Codex attribution is marked approximate and explains its limits on hover; unavailable attribution is reported once for the workspace. Select a file to see a native read-only diff against HEAD, or choose **Open in Editor** for a normal Code-mode diff tab. Added and untracked files compare with empty content, deleted files compare to empty, and renames use the original path at HEAD. Arrow keys move through files, Enter selects the diff, and Escape closes the drawer and restores focus.

Enter a message and choose **Commit** to stage and commit the displayed files through the built-in Git extension's API. The extension rechecks the file set, refuses unrelated staged files (including files outside a workspace subfolder), shows Git errors and hook output, and refreshes the daemon snapshot after the attempt. Empty messages and empty changes disable Commit with a reason. VPS workspaces list files and attribution, and **Open in Editor** opens the remote file; their drawer explains that diffs and Commit come later.

**Code** retains native editors and adds a compact sidebar view switcher for Explorer, Search, Source Control, Run and Debug, and Extensions. Hovers show their existing keyboard shortcuts. The switcher moves into the title bar while the sidebar is hidden. A narrow native secondary sidebar lists grid agents, background agents and schedules with live status dots; selecting an agent restores Agents and focuses its pane or opens its background card. **Agents** restores the same terminal panes, split sizes and focus, while Code's native working sets retain its editor tabs and layout.

The optional changes fields and validated change/open/commit requests keep bridge version 1 compatible with older messages. Daemon connections remain in the extension and refetch changes on selection, stream hints, reconnect and commit. The hermetic UI harness also checks a Git workspace, fake Claude tool edits and Codex turns, native drawer/tab diffs, a rejected Git hook followed by a successful commit, the empty state, Code navigation, live rail dots and cards, preserved grid geometry, and VPS file opening.
