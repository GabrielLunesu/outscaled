import { expect, test } from "bun:test";
import { State } from "../src/state";
import { Terminals } from "../src/terminals";
import { Tmux } from "../src/tmux";
import { fixture, workspace } from "./helpers";

for (const locale of [undefined, "C"]) {
  test(`tmux preserves terminal state and session names with ${locale === undefined ? "no locale" : "LC_ALL=C"}`, async () => {
    const f = fixture();
    const state = new State(f.config.statePath);
    const saved = new Map(Object.entries(process.env).filter(([key]) =>
      key === "LANG" || key.startsWith("LC_") || key === "HOME" || key === "SHELL"));
    try {
      for (const key of saved.keys()) delete process.env[key];
      if (locale !== undefined) process.env.LC_ALL = locale;
      process.env.HOME = f.root;
      process.env.SHELL = "/bin/bash";
      const tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
      const terminals = new Terminals(state, tmux);
      const ws = { ...workspace, path: f.root };
      state.insertWorkspace(ws);

      const terminal = await terminals.open(ws, { name: "shell" });
      expect(terminal.state).toBe("running");
      expect(terminal.pid).toBeGreaterThan(0);
      expect(await terminals.list(ws.slug)).toEqual([terminal]);
      await terminals.reconcile();
      expect(state.getTerminal(terminal.id)).toEqual(terminal);

      const name = "ws-demo-café";
      const pid = await tmux.createSession(name, f.root, "/bin/sh", "sleep 600");
      const sessions = [{ name, pid }, { name: terminal.session, pid: terminal.pid! }];
      expect(await tmux.listSessions()).toEqual(sessions);
      const panes = await tmux.listPanes();
      expect(panes.map(({ name, pid }) => ({ name, pid }))).toEqual(sessions);
      for (const pane of panes) {
        expect(pane.pane).toMatch(/^%\d+$/);
        expect(pane.dead).toBe(false);
      }
    } finally {
      // Never touch the default socket, even if opening or parsing fails.
      Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]);
      for (const key of Object.keys(process.env)) {
        if (key === "LANG" || key.startsWith("LC_") || key === "HOME" || key === "SHELL") delete process.env[key];
      }
      for (const [key, value] of saved) process.env[key] = value;
      state.close();
      f.cleanup();
    }
  });
}
