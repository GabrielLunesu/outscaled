import type { Terminal } from "@outscaled/protocol";
import type { State } from "./state";
import type { Terminals } from "./terminals";
import type { Tmux, TmuxPane } from "./tmux";

export interface SupervisorOptions {
  backoffMs?: readonly number[];
  healthyUptimeMs?: number;
}

interface Watch {
  pid: number;
  startedAt: number;
  restart: boolean;
  failures: number;
  retryAt: number | null;
}

interface OutputWatch {
  pid: number;
  generation: number;
  lastOutputAt: number;
}

export class Supervisor {
  private readonly backoff: readonly number[];
  private readonly healthyUptime: number;
  private readonly watches = new Map<string, Watch>();
  private readonly outputWatches = new Map<string, OutputWatch>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly state: State,
    private readonly tmux: Tmux,
    private readonly terminals: Terminals,
    options: SupervisorOptions = {},
  ) {
    this.backoff = options.backoffMs ?? [1000, 5000, 30_000, 300_000];
    this.healthyUptime = options.healthyUptimeMs ?? 60_000;
    if (!this.backoff.length || this.backoff.some(ms => !Number.isFinite(ms) || ms < 0) ||
        !Number.isFinite(this.healthyUptime) || this.healthyUptime <= 0) {
      throw new Error("Invalid supervisor timing options");
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    // Let an in-flight tmux operation finish before SQLite is closed.
    await this.pending;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pending = this.terminals.serial(() => this.poll()).catch(error => {
        console.error("wsd: terminal supervision failed", error);
      }).finally(() => this.schedule());
    }, 500);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const terminals = this.state.listTerminals().filter(t => (t.alwaysOn || t.runtime) && t.state !== "crashed");
    const ids = new Set(terminals.map(t => t.id));
    for (const id of this.watches.keys()) if (!ids.has(id)) this.watches.delete(id);
    for (const id of this.outputWatches.keys()) if (!ids.has(id)) this.outputWatches.delete(id);
    if (!terminals.length) return;
    const panes = new Map((await this.tmux.listPanes()).map(pane => [pane.name, pane]));
    for (const terminal of terminals) {
      if (this.stopped) return;
      const pane = panes.get(terminal.session);
      if (!pane) {
        this.watches.delete(terminal.id);
        this.outputWatches.delete(terminal.id);
        if (terminal.state !== "exited" || terminal.pid !== null) {
          this.state.updateTerminalState(terminal.id, { state: "exited", pid: null });
        }
        continue;
      }
      try {
        if (terminal.alwaysOn) await this.inspect(terminal, pane);
        else if (pane.dead) this.state.updateTerminalState(terminal.id, { state: "exited", pid: null });
        if (terminal.runtime === "codex" && !pane.dead) this.inspectOutput(this.state.getTerminal(terminal.id)!, pane);
        else this.outputWatches.delete(terminal.id);
      } catch (error) {
        console.error(`wsd: supervising ${terminal.session} failed`, error);
      }
    }
  }

  private inspectOutput(terminal: Terminal, pane: TmuxPane): void {
    const now = Date.now();
    let watch = this.outputWatches.get(terminal.id);
    if (!watch || watch.pid !== pane.pid) {
      watch = { pid: pane.pid, generation: pane.outputGeneration, lastOutputAt: now };
      this.outputWatches.set(terminal.id, watch);
    }
    const output = watch.generation !== pane.outputGeneration;
    if (output) {
      watch.generation = pane.outputGeneration;
      watch.lastOutputAt = now;
    }
    if (terminal.status === "starting") {
      if (now - watch.lastOutputAt >= 2000) this.state.updateTerminalStatus(terminal.id, "idle");
    } else if (terminal.status === "idle" && output && !this.terminals.codexInNotifyGrace(terminal, now)) {
      this.state.updateTerminalStatus(terminal.id, "working");
    }
  }

  private async inspect(terminal: Terminal, pane: TmuxPane): Promise<void> {
    const now = Date.now();
    let watch = this.watches.get(terminal.id);
    if (!watch || (!pane.dead && watch.pid !== pane.pid)) {
      // Start a fresh observation window on adoption. The persisted total
      // restart count says nothing about this process's recent failures.
      // Dead panes still belong to the current watch; tmux may report pid 0.
      watch = { pid: pane.pid, startedAt: now, restart: false, failures: 0, retryAt: null };
      this.watches.set(terminal.id, watch);
    }
    // Use tmux's exit time for dead panes: a delayed poll must not turn a
    // short-lived restart into a healthy one. tmux reports whole seconds.
    const uptime = (pane.dead ? pane.diedAt ?? now : now) - watch.startedAt;
    if (uptime >= this.healthyUptime) {
      watch.failures = 0;
      watch.restart = false;
    }
    if (!pane.dead) {
      watch.retryAt = null;
      if (terminal.state !== "running" || terminal.pid !== pane.pid) {
        this.state.updateTerminalState(terminal.id, { state: "running", pid: pane.pid });
        if (terminal.runtime && terminal.pid !== pane.pid) this.state.updateTerminalStatus(terminal.id, "starting");
      }
      return;
    }
    if (watch.retryAt === null) {
      if (watch.restart) watch.failures++;
      if (watch.failures >= 5) {
        this.state.db.transaction(() => {
          this.state.updateTerminalState(terminal.id, { state: "crashed", pid: null });
          this.state.insertEvent({
            id: crypto.randomUUID(), type: "agent.crashed", workspace: terminal.workspace,
            terminal: terminal.id, payload: { exitStatus: pane.exitStatus, exitSignal: pane.exitSignal },
            time: new Date(now).toISOString(), acked: false,
          });
        })();
        this.watches.delete(terminal.id);
        return;
      }
      watch.retryAt = now + this.backoff[Math.min(watch.failures, this.backoff.length - 1)]!;
      this.state.updateTerminalState(terminal.id, { state: "restarting", pid: null });
    }
    if (now < watch.retryAt || this.stopped) return;
    const workspace = this.state.getWorkspace(terminal.workspace)!;
    const pid = await this.tmux.respawnPane(pane.pane, workspace.path);
    watch.pid = pid;
    watch.startedAt = now;
    watch.restart = true;
    watch.retryAt = null;
    this.state.updateTerminalState(terminal.id, { state: "running", pid, restarts: terminal.restarts + 1 });
    if (terminal.runtime) this.state.updateTerminalStatus(terminal.id, "starting");
    this.outputWatches.delete(terminal.id);
  }
}
