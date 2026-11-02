import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CreateScheduleRequest, Run, Schedule, ScheduleSummary, UpdateScheduleRequest, Workspace } from "@outscaled/protocol";
import type { State } from "./state";
import { shellQuote, type Terminals } from "./terminals";
import type { Tmux } from "./tmux";
import { intervalMs, promptFile, readWorkspaceConfig } from "./workspace-config";

export interface SchedulesOptions {
  now?: () => number;
  tickMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export class ScheduleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Child = Bun.Subprocess<number, number, number>;
type ActiveRun = { run: Run } & ({ child: Child; done: Promise<void> } | { terminal: string; session: string });

export class Schedules {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly active = new Map<string, ActiveRun>();
  private warnings = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(private readonly state: State, private readonly stateDir: string, options: SchedulesOptions = {},
    private readonly backend?: { terminals: Terminals; tmux: Tmux }) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 2000;
    this.env = options.env ?? process.env;
    this.log = options.log ?? (message => console.error(message));
    if (!Number.isFinite(this.tickMs) || this.tickMs <= 0) throw new Error("Invalid schedule tick interval");
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.state.interruptRuns(this.time());
    await this.tick();
    this.scheduleTick();
  }

  /** Never waits for an agent to finish its turn or a script to exit. */
  tick(): Promise<void> {
    return this.serial(() => this.poll()).catch(error => {
      this.log(`wsd: schedule poll failed: ${String(error).replace(/[\r\n]+/g, " ")}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    const scripts = [...this.active.values()].filter(run => "child" in run);
    for (const run of scripts) this.signal(run.child, "SIGTERM");
    const timer = setTimeout(() => { for (const run of scripts) this.signal(run.child, "SIGKILL"); }, 1000);
    try {
      await Promise.all(scripts.map(run => run.done));
      // Interactive terminals belong to tmux and survive wsd, like other panes.
      if (this.backend) await this.backend.terminals.serial(async () => {
        for (const [key, active] of this.active) if ("terminal" in active) {
          await this.finishTerminal(key, active, "interrupted", null);
        }
      });
    } finally { clearTimeout(timer); }
  }

  private signal(child: Child, signal: NodeJS.Signals): void {
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
  }
  private scheduleTick(): void {
    if (!this.stopped) this.timer = setTimeout(() => { void this.tick().finally(() => this.scheduleTick()); }, this.tickMs);
  }
  private time(ms = this.now()): string { return new Date(ms).toISOString(); }
  private key(workspace: string, name: string): string { return `${workspace}/${name}`; }
  private find(workspace: string, name: string): Schedule {
    const schedule = this.state.listSchedules(workspace).find(s => s.agent === name);
    if (!schedule) throw new ScheduleError(404, "Schedule not found");
    return schedule;
  }

  private async refresh(workspace: Workspace, warnings: Set<string>): Promise<string[]> {
    const { agents, errors, names } = await readWorkspaceConfig(workspace.path);
    if (this.stopped) return names;
    const warn = (error: string) => {
      const message = `wsd: ${workspace.slug}: ${error.replace(/[\r\n]+/g, " ")}; skipping`;
      if (!this.warnings.has(message)) this.log(message);
      warnings.add(message);
    };
    for (const error of errors) warn(error);
    const previous = new Map(this.state.listSchedules(workspace.slug).filter(s => s.source === "workspace").map(s => [s.agent, s]));
    for (const config of agents) {
      const stored = this.state.listSchedules(workspace.slug).find(s => s.agent === config.name);
      // A live edit to workspace.toml must never overwrite an app schedule.
      if (stored?.source === "app") { warn(`${config.name}: name belongs to an app schedule`); continue; }
      const old = previous.get(config.name);
      const schedule: Schedule = old ? { ...old, config } : {
        workspace: workspace.slug, agent: config.name, config, source: "workspace", paused: false,
        firstSeenAt: this.time(), lastStartedAt: null, nextDueAt: this.time(this.now() + intervalMs(config.every)),
      };
      if (old && old.config.every !== config.every) {
        schedule.nextDueAt = this.time(Date.parse(old.lastStartedAt ?? old.firstSeenAt) + intervalMs(config.every));
      }
      this.state.saveSchedule(schedule);
      previous.delete(config.name);
    }
    for (const removed of previous.keys()) this.state.deleteSchedule(workspace.slug, removed);
    return names;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.backend) await this.backend.terminals.serial(async () => {
      const panes = new Map((await this.backend!.tmux.listPanes()).map(p => [p.name, p]));
      for (const [key, active] of this.active) if ("terminal" in active) {
        const pane = panes.get(active.session);
        if (!pane || pane.dead) await this.finishTerminal(key, active, "failed", pane?.exitStatus ?? null);
      }
    });
    const warnings = new Set<string>();
    for (const workspace of this.state.listWorkspaces()) {
      if (this.stopped) break;
      try {
        await this.refresh(workspace, warnings);
        for (const schedule of this.state.listSchedules(workspace.slug)) {
          if (this.stopped) return;
          if (schedule.paused || this.now() < Date.parse(schedule.nextDueAt)) continue;
          const key = this.key(workspace.slug, schedule.agent);
          if (this.active.has(key)) {
            this.state.saveSchedule({ ...schedule, nextDueAt: this.time(this.now() + intervalMs(schedule.config.every)) });
            this.log(`wsd: ${key}: previous run still running; skipping due run`);
          } else await this.launch(workspace, schedule, key);
        }
      } catch (error) {
        const message = `wsd: ${workspace.slug}: cannot schedule: ${String(error).replace(/[\r\n]+/g, " ")}`;
        warnings.add(message);
        if (!this.warnings.has(message)) this.log(message);
      }
    }
    this.warnings = warnings;
  }

  /** Called under the terminal lifecycle lock, only for Stop / turn-complete. */
  async terminalIdle(id: string): Promise<void> {
    for (const [key, active] of this.active) if ("terminal" in active && active.terminal === id) {
      await this.finishTerminal(key, active, "succeeded", 0);
    }
  }
  runningTerminal(id: string): boolean {
    return [...this.active.values()].some(active => "terminal" in active && active.terminal === id);
  }
  private async finishTerminal(key: string, active: ActiveRun & { terminal: string; session: string },
    status: "succeeded" | "failed" | "interrupted", code: number | null): Promise<void> {
    // captureOutput reads the entire tmux history before applying its limit.
    // Retained dead panes still have output; a killed session may have none.
    try {
      const output = await this.backend!.tmux.captureOutput(`=${active.session}:`, Infinity);
      writeFileSync(active.run.logPath, output + (output ? "\n" : ""), { mode: 0o600 });
    } catch (error) {
      const message = `wsd: terminal output unavailable: ${String(error)}\n`;
      try { appendFileSync(active.run.logPath, message); } catch { this.log(message.trimEnd()); }
      status = "failed";
      code = null;
    }
    this.state.finishRun(active.run.id, this.time(), code, status);
    this.active.delete(key);
  }

  private async prompt(workspace: Workspace, schedule: Schedule): Promise<string | null> {
    if (schedule.config.runtime === "script") return null;
    return schedule.source === "app" ? schedule.config.prompt
      : readFile(await promptFile(workspace.path, schedule.config.prompt), "utf8");
  }

  private async launch(workspace: Workspace, schedule: Schedule, key: string): Promise<Run> {
    const config = schedule.config;
    let prompt: string | null = null;
    let preparationError: unknown;
    try { prompt = await this.prompt(workspace, schedule); }
    catch (error) { preparationError = error; }
    if (this.stopped) throw new ScheduleError(409, "Scheduler is stopping");
    const now = this.now();
    const id = crypto.randomUUID();
    const run: Run = {
      id, workspace: workspace.slug, agent: config.name, startedAt: this.time(now), endedAt: null,
      exitCode: null, status: "running", logPath: join(this.stateDir, "logs", workspace.slug, config.name, `${id}.log`),
    };
    this.state.db.transaction(() => {
      this.state.saveSchedule({ ...schedule, lastStartedAt: run.startedAt, nextDueAt: this.time(now + intervalMs(config.every)) });
      this.state.startRun(run);
    })();
    let output: number | undefined;
    let input: number | undefined;
    try {
      mkdirSync(dirname(run.logPath), { recursive: true });
      output = openSync(run.logPath, "a", 0o600);
      if (preparationError) throw preparationError;
      if (config.runtime !== "script") {
        if (!this.backend) throw new Error("Scheduled agent terminals are not configured");
        const command = `${config.runtime === "claude-code" ? "claude" : "codex"} -- ${shellQuote(prompt!)}`;
        await this.backend.terminals.open(workspace, { name: config.name, command }, true, terminal => {
          this.active.set(key, { run, terminal: terminal.id, session: terminal.session });
        });
      } else {
        input = openSync("/dev/null", "r");
        const child = Bun.spawn([this.env.SHELL || "/bin/sh", "-l", "-c", config.command], {
          cwd: workspace.path, env: this.env, detached: true, stdin: input, stdout: output, stderr: output,
        });
        const done = child.exited.then(code => {
          this.state.finishRun(id, this.time(), code, this.stopped ? "interrupted" : code === 0 ? "succeeded" : "failed");
        }).finally(() => { this.signal(child, "SIGKILL"); this.active.delete(key); });
        this.active.set(key, { run, child, done });
      }
    } catch (error) {
      const message = `wsd: ${key}: run could not start: ${String(error).replace(/[\r\n]+/g, " ")}\n`;
      try { appendFileSync(run.logPath, message); } catch { this.log(message.trimEnd()); }
      this.state.finishRun(id, this.time(), null, "failed");
    } finally {
      if (output !== undefined) closeSync(output);
      if (input !== undefined) closeSync(input);
    }
    return this.state.getRun(id)!;
  }

  // HTTP mutations and ticks share the scheduler queue. Terminal hooks only
  // take the terminal lock, so a queued run never deadlocks its own hooks.
  private operate<T>(workspace: Workspace, action: (names: string[]) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      if (this.stopped) throw new ScheduleError(409, "Scheduler is stopping");
      const names = await this.refresh(workspace, this.warnings);
      if (this.stopped) throw new ScheduleError(409, "Scheduler is stopping");
      return action(names);
    });
  }
  list(workspace: Workspace): Promise<ScheduleSummary[]> {
    return this.operate(workspace, async () => Promise.all(this.state.listSchedules(workspace.slug).map(s => this.summary(workspace, s))));
  }
  create(workspace: Workspace, input: CreateScheduleRequest): Promise<ScheduleSummary> {
    return this.operate(workspace, async names => {
      const create = async () => {
        if (names.includes(input.name) || this.state.listSchedules(workspace.slug).some(s => s.agent === input.name) ||
            this.state.listTerminals(workspace.slug).some(t => t.name === input.name)) {
          throw new ScheduleError(409, "Agent name is already taken");
        }
        const schedule = this.state.saveSchedule({
          workspace: workspace.slug, agent: input.name, source: "app", paused: false,
          config: { ...input, mode: "scheduled" }, firstSeenAt: this.time(), lastStartedAt: null,
          nextDueAt: this.time(this.now() + intervalMs(input.every)),
        });
        return this.summary(workspace, schedule);
      };
      return this.backend ? this.backend.terminals.serial(create) : create();
    });
  }

  update(workspace: Workspace, name: string, input: UpdateScheduleRequest): Promise<ScheduleSummary> {
    return this.operate(workspace, async () => {
      const old = this.find(workspace.slug, name);
      if (old.source !== "app") throw new ScheduleError(409, "Workspace schedules are read-only");
      const schedule = this.state.saveSchedule({ ...old, config: { ...old.config, ...input },
        nextDueAt: input.every === undefined ? old.nextDueAt
          : this.time(Date.parse(old.lastStartedAt ?? old.firstSeenAt) + intervalMs(input.every)),
      });
      return this.summary(workspace, schedule);
    });
  }
  delete(workspace: Workspace, name: string): Promise<void> {
    return this.operate(workspace, async () => {
      if (this.find(workspace.slug, name).source !== "app") throw new ScheduleError(409, "Workspace schedules are read-only");
      this.state.deleteSchedule(workspace.slug, name);
    });
  }
  pause(workspace: Workspace, name: string, paused: boolean): Promise<ScheduleSummary> {
    return this.operate(workspace, async () => {
      const old = this.find(workspace.slug, name);
      // Resuming starts a new interval; paused time never creates a catch-up run.
      const schedule = this.state.saveSchedule({ ...old, paused,
        nextDueAt: !paused && old.paused ? this.time(this.now() + intervalMs(old.config.every)) : old.nextDueAt,
      });
      return this.summary(workspace, schedule);
    });
  }
  run(workspace: Workspace, name: string): Promise<Run> {
    return this.operate(workspace, async () => {
      const schedule = this.find(workspace.slug, name);
      const key = this.key(workspace.slug, name);
      if (this.active.has(key)) throw new ScheduleError(409, "A run is already active");
      return this.launch(workspace, schedule, key);
    });
  }
  private async summary(workspace: Workspace, schedule: Schedule): Promise<ScheduleSummary> {
    const last = this.state.listRuns(workspace.slug).find(r => r.agent === schedule.agent);
    let result = "";
    if (last) {
      try { result = (await readFile(last.logPath, "utf8")).split(/\r?\n/)[0] ?? ""; }
      catch { /* A running or historical run may have no log yet. */ }
    }
    let prompt: string | null = null;
    try { prompt = await this.prompt(workspace, schedule); } catch { /* Config may change between discovery and reading. */ }
    return {
      workspace: workspace.slug, name: schedule.agent, source: schedule.source, readOnly: schedule.source === "workspace",
      runtime: schedule.config.runtime, every: schedule.config.every, prompt,
      command: schedule.config.runtime === "script" ? schedule.config.command : null, paused: schedule.paused,
      lastRun: last ? { id: last.id, startedAt: last.startedAt, endedAt: last.endedAt, status: last.status, result } : null,
      nextRunAt: schedule.paused ? null : schedule.nextDueAt,
    };
  }
}
