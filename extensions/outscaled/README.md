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
during switches. It also checks the sidebar's live status behavior. Screenshots
and a `switch-proof.json` record go to `.agent-validation/switch` (or the first
argument). Processes and temporary state are cleaned up on success and failure.
