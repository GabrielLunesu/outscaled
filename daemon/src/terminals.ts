import { userInfo } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { OpenTerminalRequest, Terminal, TerminalInputRequest, TerminalAnswerRequest, TerminalAnswer, TerminalRuntime, Workspace } from "@outscaled/protocol";
import type { State } from "./state";
import { latestLine, permissionPrompt } from "./attention";
import { Tmux, type TmuxPane } from "./tmux";

export class TerminalConflict extends Error {}
export class TerminalNotFound extends Error {}

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

export function wsCliArgv(): string[] {
  // A copied compiled binary need not have a sibling ws symlink. The explicit
  // dispatch flag works regardless of the executable's installed name.
  return import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, "--ws-cli"]
    : [process.execPath, join(import.meta.dir, "ws.ts")];
}

export function writeClaudeSettings(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const command = [...wsCliArgv(), "hook", "claude-code"].map(shellQuote).join(" ");
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
  private readonly screenWatches = new Map<string, { generation: number | null; activity: number; pid: number; readAt: number; dirty: boolean }>();
  private readonly codexNotifyTimes = new Map<string, number>();

  constructor(
    private readonly state: State,
    private readonly tmux: Tmux,
    private readonly launch?: { claudeSettings: string; port: number },
  ) {}

  codexTurnComplete(id: string): void {
    // Remember even duplicate idle notifications: updateTerminalStatus preserves
    // the timestamp when the status is unchanged. Called under the lifecycle lock.
    this.codexNotifyTimes.set(id, Date.now());
    this.state.updateTerminalStatus(id, "idle");
  }

  codexInNotifyGrace(terminal: Terminal, now: number, quiet: boolean): boolean {
    const notifiedAt = this.codexNotifyTimes.get(terminal.id);
    if (notifiedAt === undefined) return false;
    // Turn completion can precede several seconds of continuous TUI rendering.
    // Wait for silence after the minimum grace before watching for a new turn.
    // Starting/working belongs to a new process or submission, not this tail.
    if (terminal.status !== "idle" || (now - notifiedAt >= 1000 && quiet)) {
      this.codexNotifyTimes.delete(terminal.id);
      return false;
    }
    return true;
  }

  reconcile(): Promise<void> {
    return this.serial(async () => {
      const sessions = new Map((await this.tmux.listPanes()).map(pane => [pane.name, pane]));
      for (const terminal of this.state.listTerminals()) {
        if (terminal.alwaysOn && sessions.has(terminal.session)) await this.tmux.retainPane(terminal.session);
      }
      this.state.db.transaction(() => {
        for (const terminal of this.state.listTerminals()) {
          // Older databases may have detected runtimes without a status yet.
          if (terminal.runtime && terminal.status === null) this.state.updateTerminalStatus(terminal.id, "starting");
          const pane = sessions.get(terminal.session);
          if (terminal.runtime && pane && !pane.dead && terminal.pid !== pane.pid) {
            this.state.updateTerminalStatus(terminal.id, "starting");
          } else if (terminal.runtime === "codex" && terminal.status === "idle" && terminal.statusChangedAt) {
            this.codexNotifyTimes.set(terminal.id, Date.parse(terminal.statusChangedAt));
          }
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

  open(workspace: Workspace, request: OpenTerminalRequest, scheduled = false, started?: (terminal: Terminal) => void): Promise<Terminal> {
    return this.serial(async () => {
      const session = `ws-${workspace.slug}-${request.name}`;
      const conflict = () => new TerminalConflict(`Terminal session ${session} is already running`);
      const previous = this.state.listTerminals(workspace.slug).find(t => t.name === request.name);
      const owns = previous && this.state.ownsScheduledTerminal(workspace.slug, request.name, previous.id);
      if (scheduled && previous && !owns) throw conflict();
      if (!scheduled && this.state.listSchedules(workspace.slug).some(s => s.agent === request.name)) throw conflict();
      const exists = await this.tmux.hasSession(session);
      if (exists && !(scheduled && owns)) throw conflict();
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
      } else if (runtime === "codex") {
        const { end } = firstWord(command);
        // JSON string arrays are also TOML arrays of basic strings. Quote the
        // whole override once more for the login shell, preserving user args.
        const notify = `notify=${JSON.stringify([...wsCliArgv(), "hook", "codex"])}`;
        launchCommand = `${command.slice(0, end)} -c ${shellQuote(notify)}${command.slice(end)}`;
      }
      let pid: number;
      try {
        const env = { WSD_TERMINAL: id, WSD_PORT: String(this.launch?.port ?? 7770) };
        pid = scheduled && exists
          ? await this.tmux.freshSession(session, workspace.path, shell, launchCommand!, env)
          : await this.tmux.createSession(session, workspace.path, shell, launchCommand, scheduled || request.alwaysOn, env);
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
            runtime, status: null, statusChangedAt: null, request: null, latestLine: null,
            state: "running", restarts: 0, pid, createdAt,
          });
          if (scheduled) this.state.ownScheduledTerminal(workspace.slug, request.name, id);
          // All transitions, including the initial starting status, emit events.
          // Hooks share this lifecycle lock so SessionStart cannot race the row.
          const terminal = runtime ? this.state.updateTerminalStatus(id, scheduled ? "working" : "starting")! : this.state.getTerminal(id)!;
          started?.(terminal);
          return terminal;
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
      const sessions = new Map((await this.tmux.listPanes()).map(pane => [pane.name, pane]));
      return this.state.listTerminals(workspace).map(terminal => {
        const pane = sessions.get(terminal.session);
        if ((!pane || pane.dead) && terminal.state !== "crashed") {
          return this.state.updateTerminalState(terminal.id, { state: pane?.dead && terminal.alwaysOn ? "restarting" : "exited", pid: null })!;
        }
        return terminal;
      });
    });
  }

  private async runningPane(workspace: string, name: string) {
    const terminal = this.state.listTerminals(workspace).find(terminal => terminal.name === name);
    if (!terminal) throw new TerminalNotFound("Terminal not found");
    const pane = (await this.tmux.listPanes()).find(pane => pane.name === terminal.session);
    if (!pane || pane.dead || terminal.state !== "running") {
      if ((!pane || pane.dead) && terminal.state !== "crashed") {
        this.state.updateTerminalState(terminal.id, { state: pane?.dead && terminal.alwaysOn ? "restarting" : "exited", pid: null });
      }
      throw new TerminalConflict("Terminal is not running");
    }
    return { terminal, pane: pane.pane };
  }

  input(workspace: string, name: string, request: TerminalInputRequest): Promise<Terminal> {
    return this.serial(async () => {
      const { terminal, pane } = await this.runningPane(workspace, name);
      if (request.text !== undefined) await this.tmux.pasteText(pane, request.text);
      await this.tmux.sendKeys(pane, request.keys ?? []);
      const submit = request.submit ?? request.text !== undefined;
      if (submit) {
        // TUIs need time to process the bracketed paste before accepting Enter.
        if (request.text !== undefined) await Bun.sleep(100);
        await this.tmux.sendKeys(pane, ["Enter"]);
      }
      if (terminal.runtime && (submit || request.keys?.some(key => /^(Enter|Return|C-m|C-j)$/.test(key)))) {
        this.codexNotifyTimes.delete(terminal.id);
        // Hooks and status reads also use this lock, so no caller can observe
        // the previous idle after a successful submission, even before output.
        return this.state.updateTerminalStatus(terminal.id, "working")!;
      }
      return terminal;
    });
  }

  // Called under the lifecycle lock by hooks and supervision. A later screen
  // may fill a request captured before Claude finished drawing its prompt.
  async captureRequest(id: string, message?: string): Promise<void> {
    const terminal = this.state.getTerminal(id);
    if (!terminal || terminal.runtime !== "claude-code") return;
    let parsed = null;
    try { parsed = permissionPrompt(await this.tmux.captureScreen(`=${terminal.session}:`)); } catch { /* Pane may have exited. */ }
    this.state.updateTerminalStatus(id, "needs_input", {
      message: message ?? terminal.request?.message ?? null,
      permission: terminal.request?.permission ?? parsed?.prompt ?? null,
    }, this.state.requestScreenHash(id) ?? parsed?.fingerprint ?? null);
  }

  async refreshScreen(terminal: Terminal, pane: TmuxPane): Promise<void> {
    const now = Date.now();
    let watch = this.screenWatches.get(terminal.id);
    if (!watch || watch.pid !== pane.pid) {
      watch = { generation: pane.outputGeneration, activity: pane.windowActivity, pid: pane.pid, readAt: -Infinity, dirty: true };
      this.screenWatches.set(terminal.id, watch);
    }
    watch.dirty ||= watch.generation !== pane.outputGeneration || watch.activity !== pane.windowActivity;
    watch.generation = pane.outputGeneration;
    watch.activity = pane.windowActivity;
    if (!watch.dirty || now - watch.readAt < 1000) return;
    watch.readAt = now;
    // On older tmux, output later in the same timestamp bucket is invisible.
    // Take a trailing sample after that bucket expires as well.
    watch.dirty = pane.outputGeneration === null && now < (pane.windowActivity + 1) * 1000;
    const needsPrompt = terminal.status === "needs_input" && !terminal.request?.permission;
    if (this.state.hasAgentLatestLine(terminal.id) && !needsPrompt) return;
    const screen = await this.tmux.captureScreen(pane.pane);
    if (!this.state.hasAgentLatestLine(terminal.id)) this.state.updateLatestLine(terminal.id, latestLine(screen));
    if (needsPrompt) {
      const parsed = permissionPrompt(screen);
      if (parsed) this.state.updateTerminalStatus(terminal.id, "needs_input", {
        message: terminal.request?.message ?? null, permission: parsed.prompt,
      }, parsed.fingerprint);
    }
  }

  forgetScreens(ids: Set<string>): void {
    for (const id of this.screenWatches.keys()) if (!ids.has(id)) this.screenWatches.delete(id);
  }

  answer(workspace: string, name: string, request: TerminalAnswerRequest): Promise<TerminalAnswer> {
    return this.serial(async () => {
      const { terminal, pane } = await this.runningPane(workspace, name);
      if (terminal.runtime !== "claude-code") throw new TerminalConflict("Only Claude Code permission prompts can be answered");
      if (terminal.status !== "needs_input") throw new TerminalConflict("Terminal is not waiting for input");
      let screen: string;
      try { screen = await this.tmux.captureScreen(pane); }
      catch { throw new TerminalConflict("Unable to read the current permission prompt"); }
      const parsed = permissionPrompt(screen);
      if (!parsed) throw new TerminalConflict("Screen does not show a recognised permission prompt");
      if (!terminal.request?.permission || this.state.requestScreenHash(terminal.id) !== parsed.fingerprint ||
          JSON.stringify(terminal.request.permission) !== JSON.stringify(parsed.prompt)) {
        throw new TerminalConflict("Permission prompt changed or was not captured; open the terminal to review it");
      }
      const option = parsed.prompt.options.find(option => option.label === (request.answer === "allow_once" ? "Yes" : "No"))!;
      await this.tmux.sendKeys(pane, [String(option.number)]);
      // Consumes the snapshot, so a double click cannot answer a subsequent prompt.
      this.state.updateTerminalStatus(terminal.id, "working");
      return { question: parsed.prompt.question, option };
    });
  }

  output(workspace: string, name: string, lines: number): Promise<string> {
    return this.serial(async () => {
      const { pane } = await this.runningPane(workspace, name);
      return this.tmux.captureOutput(pane, lines);
    });
  }
}
