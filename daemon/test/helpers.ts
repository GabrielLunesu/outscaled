import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { Terminal, Workspace } from "@outscaled/protocol";

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wsd-test-"));
  const env = {
    ...process.env,
    WSD_CONFIG_DIR: join(root, "config"),
    WSD_STATE_DIR: join(root, "state"),
    WSD_WORKSPACES_DIR: join(root, "workspaces"),
    WSD_TMUX_SOCKET: join(root, "tmux.sock"),
    WSD_PORT: "7770",
  };
  mkdirSync(env.WSD_CONFIG_DIR);
  return {
    root,
    env,
    config: { ...loadConfig({ env, hostname: "test-host.example" }), port: 0 },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const workspace: Workspace = {
  slug: "demo", path: "/example/workspaces/demo", repo: null, inPlace: false, createdAt: "2026-01-01T00:00:00.000Z",
};
export const terminal: Terminal = {
  id: "terminal-1", workspace: "demo", name: "shell", command: "/bin/sh", session: "ws-demo-shell",
  alwaysOn: false, state: "running", restarts: 0, pid: null, createdAt: workspace.createdAt,
};
