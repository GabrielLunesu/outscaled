import { userInfo } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OpenTerminalRequest, Terminal, TerminalRuntime, Workspace } from "@outscaled/protocol";
import type { State } from "./state";
import { Tmux } from "./tmux";

export class TerminalConflict extends Error {}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Read only the first shell word; never evaluate the user's command to detect
// its runtime. Keep its original spelling and the remaining command intact.
function firstWord(command: string): { word: string; end: number } {
  let word = "";
  let quote = "";
  let index = 0;
  while (/\s/.test(command[index] ?? "") && index < command.length) index++;
  for (; index < command.length; index++) {
    const char = command[index]!;
    if (!quote && /[\s;&|<>()]/.test(char)) break;
    if (char === quote) { quote = ""; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
    if (char === "\\" && quote !== "'" && index + 1 < command.length) {
      const next = command[index + 1]!;
      if (!quote || /[$`"\\\n]/.test(next)) {
        index++;
        if (next !== "\n") word += next;
        continue;
      }
    }
    word += char;
  }
  return { word, end: index };
}

export function terminalRuntime(command: string): TerminalRuntime | null {
  const name = basename(firstWord(command).word);
  return name === "claude" ? "claude-code" : name === "codex" ? "codex" : null;
}

export function writeClaudeSettings(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  // A copied compiled binary need not have a sibling ws symlink. The explicit
  // dispatch flag works regardless of the executable's installed name.
  const cli = import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, "--ws-cli"]
    : [process.execPath, join(import.meta.dir, "ws.ts")];
  const command = [...cli, "hook", "claude-code"].map(shellQuote).join(" ");
  const hooks = Object.fromEntries([
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Notification",
  ].map(event => [event, [{
    ...(event === "Notification" ? { matcher: "permission_prompt" } : {}),
    hooks: [{ type: "command", command, timeout: 1 }],
  }]]));
  const path = join(stateDir, "claude-settings.json");
  writeFileSync(path, JSON.stringify({ hooks }, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export class Terminals {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: State,
    private readonly tmux: Tmux,
    private readonly launch?: { claudeSettings: string; port: number },
  ) {}

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
      const id = crypto.randomUUID();
      const command = request.command ?? shell;
      const runtime = terminalRuntime(command);
      const createdAt = new Date().toISOString();
      let launchCommand = request.command;
      if (runtime === "claude-code") {
        if (!this.launch) throw new Error("Claude hook settings are not configured");
        const { end } = firstWord(command);
        launchCommand = `${command.slice(0, end)} --settings ${shellQuote(this.launch.claudeSettings)}${command.slice(end)}`;
      }
      let pid: number;
      try {
        pid = await this.tmux.createSession(session, workspace.path, shell, launchCommand, request.alwaysOn, {
          WSD_TERMINAL: id, WSD_PORT: String(this.launch?.port ?? 7770),
        });
      } catch (error) {
        // Another client may have created the session since has-session.
        if (await this.tmux.hasSession(session)) throw conflict();
        throw error;
      }
      try {
        return this.state.db.transaction(() => {
          this.state.db.query("DELETE FROM terminals WHERE workspace = ? AND name = ?")
            .run(workspace.slug, request.name);
          this.state.insertTerminal({
            id, workspace: workspace.slug, name: request.name,
            command, session, alwaysOn: request.alwaysOn ?? false,
            runtime, status: null, statusChangedAt: null,
            state: "running", restarts: 0, pid, createdAt,
          });
          // All transitions, including the initial starting status, emit events.
          // Hooks share this lifecycle lock so SessionStart cannot race the row.
          return runtime ? this.state.updateTerminalStatus(id, "starting")! : this.state.getTerminal(id)!;
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
