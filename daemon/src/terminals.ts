import { userInfo } from "node:os";
import type { OpenTerminalRequest, Terminal, Workspace } from "@outscaled/protocol";
import type { State } from "./state";
import { Tmux } from "./tmux";

export class TerminalConflict extends Error {}

export class Terminals {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: State, private readonly tmux: Tmux) {}

  reconcile(): Promise<void> {
    return this.serial(async () => {
      const sessions = new Map((await this.tmux.listPanes()).map(pane => [pane.name, pane]));
      for (const terminal of this.state.listTerminals()) {
        if (terminal.alwaysOn && sessions.has(terminal.session)) await this.tmux.retainPane(terminal.session);
      }
      this.state.db.transaction(() => {
        for (const terminal of this.state.listTerminals()) {
          const pane = sessions.get(terminal.session);
          // A dead, exhausted always-on pane must stay crashed across restarts.
          if (terminal.alwaysOn && terminal.state === "crashed" && (!pane || pane.dead)) {
            sessions.delete(terminal.session);
            continue;
          }
          this.state.updateTerminalState(terminal.id, pane === undefined
            ? { state: "exited", pid: null }
            : pane.dead
              ? { state: terminal.alwaysOn ? "restarting" : "exited", pid: null }
              : { state: "running", pid: pane.pid });
          sessions.delete(terminal.session);
        }
      })();
      for (const name of sessions.keys()) {
        if (name.startsWith("ws-")) console.log(`wsd: leaving untracked tmux session ${name} alone`);
      }
    });
  }

  // Reconciliation, HTTP operations and supervision share one lifecycle lock.
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  open(workspace: Workspace, request: OpenTerminalRequest): Promise<Terminal> {
    return this.serial(async () => {
      const session = `ws-${workspace.slug}-${request.name}`;
      const conflict = () => new TerminalConflict(`Terminal session ${session} is already running`);
      if (await this.tmux.hasSession(session)) throw conflict();
      const shell = process.env.SHELL || userInfo().shell || "/bin/sh";
      let pid: number;
      try {
        pid = await this.tmux.createSession(session, workspace.path, shell, request.command, request.alwaysOn);
      } catch (error) {
        // Another client may have created the session since has-session.
        if (await this.tmux.hasSession(session)) throw conflict();
        throw error;
      }
      try {
        return this.state.db.transaction(() => {
          this.state.db.query("DELETE FROM terminals WHERE workspace = ? AND name = ?")
            .run(workspace.slug, request.name);
          return this.state.insertTerminal({
            id: crypto.randomUUID(), workspace: workspace.slug, name: request.name,
            command: request.command ?? shell, session, alwaysOn: request.alwaysOn ?? false,
            state: "running", restarts: 0, pid, createdAt: new Date().toISOString(),
          });
        })();
      } catch (error) {
        // Do not leave an untracked process behind if persistence fails.
        if (await this.tmux.hasSession(session)) await this.tmux.killSession(session);
        throw error;
      }
    });
  }

  list(workspace: string): Promise<Terminal[]> {
    return this.serial(async () => {
      const sessions = new Set((await this.tmux.listSessions()).map(session => session.name));
      return this.state.listTerminals(workspace).map(terminal => {
        if (!sessions.has(terminal.session) && terminal.state !== "crashed") {
          return this.state.updateTerminalState(terminal.id, { state: "exited", pid: null })!;
        }
        return terminal;
      });
    });
  }
}
