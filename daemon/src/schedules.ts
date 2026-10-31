import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Run, Schedule, Workspace } from "@outscaled/protocol";
import type { State } from "./state";
import { intervalMs, promptFile, readWorkspaceConfig } from "./workspace-config";

export interface SchedulesOptions {
  now?: () => number;
  tickMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

type Child = Bun.Subprocess<number, number, number>;
interface ActiveRun { child: Child; done: Promise<void>; }

export class Schedules {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly active = new Map<string, ActiveRun>();
  private warnings = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(private readonly state: State, private readonly stateDir: string, options: SchedulesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 2000;
    this.env = options.env ?? process.env;
    this.log = options.log ?? (message => console.error(message));
    if (!Number.isFinite(this.tickMs) || this.tickMs <= 0) throw new Error("Invalid schedule tick interval");
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.state.interruptRuns(this.time());
    await this.tick();
    this.scheduleTick();
  }

  /** Serialized, public tick for deterministic clock-driven tests. Never waits for a run to exit. */
  tick(): Promise<void> {
    this.pending = this.pending.then(() => this.poll()).catch(error => {
      this.log(`wsd: schedule poll failed: ${String(error).replace(/[\r\n]+/g, " ")}`);
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    const runs = [...this.active.values()];
    for (const run of runs) this.signal(run.child, "SIGTERM");
    const timer = setTimeout(() => { for (const run of runs) this.signal(run.child, "SIGKILL"); }, 1000);
    try { await Promise.all(runs.map(run => run.done)); }
    finally { clearTimeout(timer); }
  }

  private signal(child: Child, signal: NodeJS.Signals): void {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  }

  private scheduleTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().finally(() => this.scheduleTick()); }, this.tickMs);
  }

  private time(ms = this.now()): string { return new Date(ms).toISOString(); }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const warnings = new Set<string>();
    for (const workspace of this.state.listWorkspaces()) {
      if (this.stopped) break;
      try {
        const { agents, errors } = await readWorkspaceConfig(workspace.path);
        if (this.stopped) return;
        for (const error of errors) {
          const message = `wsd: ${workspace.slug}: ${error.replace(/[\r\n]+/g, " ")}; skipping`;
          warnings.add(message);
          if (!this.warnings.has(message)) this.log(message);
        }
        const previous = new Map(this.state.listSchedules(workspace.slug).map(s => [s.agent, s]));
        const now = this.now();
        for (const config of agents) {
          if (this.stopped) return;
          const old = previous.get(config.name);
          const schedule: Schedule = old ? { ...old, config } : {
            workspace: workspace.slug, agent: config.name, config,
            firstSeenAt: this.time(now), lastStartedAt: null, nextDueAt: this.time(now + intervalMs(config.every)),
          };
          if (old && old.config.every !== config.every) {
            schedule.nextDueAt = this.time(Date.parse(old.lastStartedAt ?? old.firstSeenAt) + intervalMs(config.every));
          }
          this.state.saveSchedule(schedule);
          previous.delete(config.name);
          if (now < Date.parse(schedule.nextDueAt)) continue;
          const key = `${workspace.slug}/${config.name}`;
          if (this.active.has(key)) {
            this.state.saveSchedule({ ...schedule, nextDueAt: this.time(now + intervalMs(config.every)) });
            this.log(`wsd: ${key}: previous run still running; skipping due run`);
          } else await this.launch(workspace, schedule, key);
        }
        if (this.stopped) return;
        for (const removed of previous.keys()) this.state.deleteSchedule(workspace.slug, removed);
      } catch (error) {
        const message = `wsd: ${workspace.slug}: cannot schedule: ${String(error).replace(/[\r\n]+/g, " ")}`;
        warnings.add(message);
        if (!this.warnings.has(message)) this.log(message);
      }
    }
    this.warnings = warnings;
  }

  private async launch(workspace: Workspace, schedule: Schedule, key: string): Promise<void> {
    const config = schedule.config;
    let prompt: string | undefined;
    let preparationError: unknown;
    try {
      if (config.runtime !== "script") prompt = await readFile(await promptFile(workspace.path, config.prompt), "utf8");
    } catch (error) { preparationError = error; }
    if (this.stopped) return;
    const now = this.now();
    const id = crypto.randomUUID();
    const run: Run = {
      id, workspace: workspace.slug, agent: config.name, startedAt: this.time(now), endedAt: null,
      exitCode: null, status: "running", logPath: join(this.stateDir, "logs", workspace.slug, config.name, `${id}.log`),
    };
    // Consume a due time even if log creation or spawning fails, avoiding a hot retry loop.
    this.state.db.transaction(() => {
      this.state.saveSchedule({ ...schedule, lastStartedAt: run.startedAt, nextDueAt: this.time(now + intervalMs(config.every)) });
      this.state.startRun(run);
    })();
    let output: number | undefined;
    let input: number | undefined;
    try {
      mkdirSync(dirname(run.logPath), { recursive: true });
      output = openSync(run.logPath, "a", 0o600);
      input = openSync("/dev/null", "r");
      if (preparationError) throw preparationError;
      const command = config.runtime === "script" ? config.command
        : config.runtime === "claude-code" ? 'exec claude -p "$WSD_RUN_PROMPT"' : 'exec codex exec "$WSD_RUN_PROMPT"';
      const child = Bun.spawn([this.env.SHELL || "/bin/sh", "-l", "-c", command], {
        cwd: workspace.path, env: { ...this.env, WSD_RUN_PROMPT: prompt }, detached: true,
        stdin: input, stdout: output, stderr: output,
      });
      const done = child.exited.then(code => {
        this.state.finishRun(id, this.time(), code, this.stopped ? "interrupted" : code === 0 ? "succeeded" : "failed");
      }).finally(() => {
        // Scripts may have spawned children. Do not leave their process group
        // behind after its leader exits, including during shutdown.
        this.signal(child, "SIGKILL");
        this.active.delete(key);
      });
      this.active.set(key, { child, done });
    } catch (error) {
      const message = `wsd: ${key}: run could not start: ${String(error).replace(/[\r\n]+/g, " ")}\n`;
      try { appendFileSync(run.logPath, message); } catch { this.log(message.trimEnd()); }
      this.state.finishRun(id, this.time(), null, "failed");
    } finally {
      if (output !== undefined) closeSync(output);
      if (input !== undefined) closeSync(input);
    }
  }
}
