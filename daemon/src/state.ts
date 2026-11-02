import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Event, LatestLine, Run, Schedule, Terminal, TerminalStatus, TerminalRequest, Workspace, type ChangeAttribution, type StreamMessage } from "@outscaled/protocol";
import { migrate } from "./migrations";

type WorkspaceRow = Omit<Workspace, "inPlace"> & { inPlace: number };
type TerminalRow = Omit<Terminal, "alwaysOn" | "request"> & { alwaysOn: number; request: string | null; requestScreenHash: string | null; latestLineFromAgent: number };
type EventRow = Omit<Event, "payload" | "acked"> & { payload: string; acked: number };
const workspaceFromRow = (row: WorkspaceRow): Workspace => ({ ...row, inPlace: Boolean(row.inPlace) });
const terminalFromRow = ({ requestScreenHash, latestLineFromAgent, ...row }: TerminalRow): Terminal =>
  ({ ...row, alwaysOn: Boolean(row.alwaysOn), request: row.request === null ? null : JSON.parse(row.request) });
const eventFromRow = (row: EventRow): Event => ({ ...row, payload: JSON.parse(row.payload), acked: Boolean(row.acked) });

export class State {
  readonly db: Database;
  private closed = false;
  private readonly latestNotifications = new Map<string, { at: number; line: string | null; timer?: ReturnType<typeof setTimeout> }>();

  private readonly changesNotifications = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout> }>();

  constructor(path: string, private readonly publish?: (message: StreamMessage) => void) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      migrate(this.db);
      this.db.exec("PRAGMA journal_mode = WAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    for (const pending of this.latestNotifications.values()) clearTimeout(pending.timer);
    for (const pending of this.changesNotifications.values()) clearTimeout(pending.timer);
    this.db.close();
  }

  // Callers also use outer SQLite transactions. Defer until their synchronous
  // commit, and discard notifications for writes that rolled back.
  private announce(message: StreamMessage, persisted: () => boolean): void {
    if (!this.publish) return;
    const committed = !this.db.inTransaction;
    queueMicrotask(() => {
      if (!this.closed && (committed || persisted())) this.broadcast(message);
    });
  }

  private broadcast(message: StreamMessage): void {
    if (message.type !== "terminal.latest_line") {
      this.publish?.(message);
      return;
    }
    const id = message.terminal!;
    const previous = this.latestNotifications.get(id);
    const emit = () => {
      const terminal = this.getTerminal(id);
      if (!terminal) return;
      if (previous) { clearTimeout(previous.timer); previous.timer = undefined; }
      if (previous && previous.line === terminal.latestLine) return;
      this.latestNotifications.set(id, { at: Date.now(), line: terminal.latestLine });
      this.publish?.({ type: "terminal.latest_line", workspace: terminal.workspace, terminal: id, payload: { latestLine: terminal.latestLine } });
    };
    if (!previous || Date.now() - previous.at >= 1000) emit();
    else if (!previous.timer) previous.timer = setTimeout(emit, 1000 - (Date.now() - previous.at));
  }

  notifyChanges(workspace: string): void {
    const previous = this.changesNotifications.get(workspace);
    const emit = () => {
      this.changesNotifications.set(workspace, { at: Date.now() });
      this.publish?.({ type: "workspace.changes", workspace });
    };
    if (!previous || Date.now() - previous.at >= 1000) {
      clearTimeout(previous?.timer);
      emit();
    } else if (!previous.timer) previous.timer = setTimeout(emit, 1000 - (Date.now() - previous.at));
  }

  recordChange(workspace: string, path: string, agent: ChangeAttribution): void {
    this.db.query(`INSERT INTO change_attributions (workspace, path, terminal, runtime, time, inferred)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, path, terminal, runtime)
      DO UPDATE SET time = excluded.time, inferred = excluded.inferred`)
      .run(workspace, path, agent.terminal, agent.runtime, agent.time, Number(agent.inferred));
  }

  changeAttributions(workspace: string): Map<string, ChangeAttribution[]> {
    const rows = this.db.query<Omit<ChangeAttribution, "inferred"> & { path: string; inferred: number }, [string]>(
      "SELECT path, terminal, runtime, time, inferred FROM change_attributions WHERE workspace = ? ORDER BY time DESC, rowid DESC",
    ).all(workspace);
    const result = new Map<string, ChangeAttribution[]>();
    for (const { path, ...row } of rows) {
      if (!result.has(path)) result.set(path, []);
      result.get(path)!.push({ ...row, inferred: Boolean(row.inferred) });
    }
    return result;
  }

  pruneChanges(workspace: string, dirty: Set<string>, renames: { path: string; originalPath: string | null }[] = []): void {
    this.db.transaction(() => {
      const attributions = this.changeAttributions(workspace);
      for (const { path, originalPath } of renames) {
        if (!originalPath || dirty.has(originalPath)) continue;
        for (const agent of attributions.get(originalPath) ?? []) {
          const current = attributions.get(path)?.find(a => a.terminal === agent.terminal && a.runtime === agent.runtime);
          if (!current || current.time < agent.time) this.recordChange(workspace, path, agent);
        }
      }
      for (const { path } of this.db.query<{ path: string }, [string]>(
        "SELECT DISTINCT path FROM change_attributions WHERE workspace = ?",
      ).all(workspace)) {
        if (!dirty.has(path)) this.db.query("DELETE FROM change_attributions WHERE workspace = ? AND path = ?").run(workspace, path);
      }
    })();
  }

  insertWorkspace(value: Workspace): Workspace {
    const ws = Workspace.parse(value);
    this.db.query("INSERT INTO workspaces (slug, path, repo, inPlace, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(ws.slug, ws.path, ws.repo, Number(ws.inPlace), ws.createdAt);
    this.announce({ type: "workspace.changed", workspace: ws.slug }, () => this.getWorkspace(ws.slug) !== null);
    return ws;
  }

  getWorkspace(slug: string): Workspace | null {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE slug = ?").get(slug);
    return row ? workspaceFromRow(row) : null;
  }

  listWorkspaces(): Workspace[] {
    return this.db.query<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY createdAt, slug").all().map(workspaceFromRow);
  }

  updateWorkspace(slug: string, changes: Partial<Pick<Workspace, "path" | "repo" | "inPlace">>): Workspace | null {
    const current = this.getWorkspace(slug);
    if (!current) return null;
    const next = Workspace.parse({ ...current, ...changes });
    this.db.query("UPDATE workspaces SET path = ?, repo = ?, inPlace = ? WHERE slug = ?")
      .run(next.path, next.repo, Number(next.inPlace), slug);
    return next;
  }

  insertTerminal(value: Terminal): Terminal {
    const t = Terminal.parse(value);
    this.db.query(`INSERT INTO terminals
      (id, workspace, name, command, session, alwaysOn, state, restarts, pid, createdAt, runtime, status, statusChangedAt, request, latestLine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.workspace, t.name, t.command, t.session, Number(t.alwaysOn), t.state, t.restarts, t.pid, t.createdAt,
      t.runtime, t.status, t.statusChangedAt, t.request === null ? null : JSON.stringify(t.request), t.latestLine,
    );
    this.announce({ type: "workspace.changed", workspace: t.workspace }, () => this.getTerminal(t.id) !== null);
    return t;
  }

  getTerminal(id: string): Terminal | null {
    const row = this.db.query<TerminalRow, [string]>("SELECT * FROM terminals WHERE id = ?").get(id);
    return row ? terminalFromRow(row) : null;
  }

  listTerminals(workspace?: string): Terminal[] {
    const rows = workspace === undefined
      ? this.db.query<TerminalRow, []>("SELECT * FROM terminals ORDER BY createdAt, id").all()
      : this.db.query<TerminalRow, [string]>("SELECT * FROM terminals WHERE workspace = ? ORDER BY createdAt, id").all(workspace);
    return rows.map(terminalFromRow);
  }

  updateTerminalState(id: string, changes: Pick<Terminal, "state"> & Partial<Pick<Terminal, "pid" | "restarts">>): Terminal | null {
    const current = this.getTerminal(id);
    if (!current) return null;
    const next = Terminal.parse({ ...current, ...changes });
    this.db.query("UPDATE terminals SET state = ?, pid = ?, restarts = ? WHERE id = ?")
      .run(next.state, next.pid, next.restarts, id);
    if (current.state !== next.state || current.pid !== next.pid || current.restarts !== next.restarts) {
      this.announce({ type: "workspace.changed", workspace: next.workspace }, () => {
        const stored = this.getTerminal(id);
        return stored?.state === next.state && stored.pid === next.pid && stored.restarts === next.restarts;
      });
    }
    return next;
  }

  terminalCounts(): { total: number; running: number } {
    return this.db.query<{ total: number; running: number }, []>(
      "SELECT count(*) AS total, coalesce(sum(state = 'running'), 0) AS running FROM terminals",
    ).get()!;
  }

  updateTerminalStatus(id: string, status: TerminalStatus, request?: TerminalRequest | null, screenHash?: string | null): Terminal | null {
    TerminalStatus.parse(status);
    return this.db.transaction(() => {
      const current = this.getTerminal(id);
      if (!current || !current.runtime) return current;
      const nextRequest = status === "needs_input" ? (request === undefined ? current.request : request) : null;
      if (current.status === status && JSON.stringify(current.request) === JSON.stringify(nextRequest)) return current;
      const changed = current.status !== status;
      const time = new Date().toISOString();
      this.db.query("UPDATE terminals SET status = ?, statusChangedAt = ?, request = ?, requestScreenHash = ? WHERE id = ?")
        .run(status, changed ? time : current.statusChangedAt, nextRequest === null ? null : JSON.stringify(nextRequest),
          status === "needs_input" ? (screenHash === undefined ? this.requestScreenHash(id) : screenHash) : null, id);
      const event = {
        id: crypto.randomUUID(), type: "terminal.status", workspace: current.workspace,
        terminal: id, payload: { terminal: id, oldStatus: current.status, newStatus: status, request: nextRequest }, time, acked: false,
      };
      this.insertEvent(event);
      if (status === "needs_input" && changed) {
        this.insertEvent({ ...event, id: crypto.randomUUID(), type: "agent.needs_input" });
      }
      return this.getTerminal(id);
    })();
  }

  requestScreenHash(id: string): string | null {
    return this.db.query<{ requestScreenHash: string | null }, [string]>("SELECT requestScreenHash FROM terminals WHERE id = ?").get(id)?.requestScreenHash ?? null;
  }

  hasAgentLatestLine(id: string): boolean {
    return Boolean(this.db.query<{ latestLineFromAgent: number }, [string]>("SELECT latestLineFromAgent FROM terminals WHERE id = ?").get(id)?.latestLineFromAgent);
  }

  updateLatestLine(id: string, line: string | null, fromAgent = false): void {
    LatestLine.parse(line);
    const terminal = this.getTerminal(id);
    if (!terminal || (!fromAgent && this.hasAgentLatestLine(id))) return;
    this.db.query("UPDATE terminals SET latestLine = ?, latestLineFromAgent = ? WHERE id = ?").run(line, Number(fromAgent), id);
    if (line === terminal.latestLine) return;
    this.announce({ type: "terminal.latest_line", workspace: terminal.workspace, terminal: id, payload: { latestLine: line } },
      () => this.getTerminal(id)?.latestLine === line);
  }

  insertEvent(value: Event): Event {
    const event = Event.parse(value);
    this.db.query("INSERT INTO events (id, type, workspace, terminal, payload, time, acked) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.workspace, event.terminal, JSON.stringify(event.payload), event.time, Number(event.acked));
    this.announce(event, () => this.getEvent(event.id) !== null);
    return event;
  }

  getEvent(id: string): Event | null {
    const row = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    return row ? eventFromRow(row) : null;
  }

  listEvents(workspace?: string): Event[] {
    const rows = workspace === undefined
      ? this.db.query<EventRow, []>("SELECT * FROM events ORDER BY time, id").all()
      : this.db.query<EventRow, [string]>("SELECT * FROM events WHERE workspace = ? ORDER BY time, id").all(workspace);
    return rows.map(eventFromRow);
  }

  acknowledgeEvent(id: string, acked = true): Event | null {
    this.db.query("UPDATE events SET acked = ? WHERE id = ?").run(Number(acked), id);
    return this.getEvent(id);
  }

  listSchedules(workspace: string): Schedule[] {
    return this.db.query<Omit<Schedule, "config" | "paused"> & { config: string; paused: number }, [string]>(
      "SELECT * FROM schedules WHERE workspace = ? ORDER BY agent",
    ).all(workspace).map(row => ({ ...row, config: JSON.parse(row.config), paused: Boolean(row.paused) }));
  }

  saveSchedule(value: Schedule): Schedule {
    const s = Schedule.parse(value);
    this.db.query(`INSERT INTO schedules (workspace, agent, config, firstSeenAt, lastStartedAt, nextDueAt, source, paused)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, agent) DO UPDATE SET
      config = excluded.config, lastStartedAt = excluded.lastStartedAt, nextDueAt = excluded.nextDueAt, source = excluded.source, paused = excluded.paused`)
      .run(s.workspace, s.agent, JSON.stringify(s.config), s.firstSeenAt, s.lastStartedAt, s.nextDueAt, s.source, Number(s.paused));
    return s;
  }

  deleteSchedule(workspace: string, agent: string): void {
    this.db.query("DELETE FROM schedules WHERE workspace = ? AND agent = ?").run(workspace, agent);
  }

  ownsScheduledTerminal(workspace: string, agent: string, terminal: string): boolean {
    return this.db.query("SELECT 1 FROM scheduled_terminals WHERE workspace = ? AND agent = ? AND terminal = ?")
      .get(workspace, agent, terminal) !== null;
  }

  ownScheduledTerminal(workspace: string, agent: string, terminal: string): void {
    this.db.query(`INSERT INTO scheduled_terminals VALUES (?, ?, ?) ON CONFLICT(workspace, agent)
      DO UPDATE SET terminal = excluded.terminal`).run(workspace, agent, terminal);
  }

  getRun(id: string): Run | null {
    return this.db.query<Run, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
  }

  listRuns(workspace?: string): Run[] {
    return workspace === undefined
      ? this.db.query<Run, []>("SELECT * FROM runs ORDER BY startedAt DESC, rowid DESC").all()
      : this.db.query<Run, [string]>("SELECT * FROM runs WHERE workspace = ? ORDER BY startedAt DESC, rowid DESC").all(workspace);
  }

  startRun(value: Run): Run {
    const run = Run.parse(value);
    return this.db.transaction(() => {
      this.db.query(`INSERT INTO runs (id, workspace, agent, startedAt, endedAt, exitCode, logPath, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.workspace, run.agent, run.startedAt, run.endedAt, run.exitCode, run.logPath, run.status);
      this.runEvent(run, "run.started", run.startedAt);
      return run;
    })();
  }

  finishRun(id: string, endedAt: string, exitCode: number | null, status: Exclude<Run["status"], "running">): Run {
    return this.db.transaction(() => {
      const current = this.getRun(id);
      if (!current) throw new Error("Run not found");
      if (current.status !== "running") return current;
      this.db.query("UPDATE runs SET endedAt = ?, exitCode = ?, status = ? WHERE id = ? AND status = 'running'")
        .run(endedAt, exitCode, status, id);
      const run = this.getRun(id)!;
      this.runEvent(run, "run.finished", endedAt);
      return run;
    })();
  }

  interruptRuns(time: string): void {
    for (const run of this.listRuns()) if (run.status === "running") this.finishRun(run.id, time, null, "interrupted");
  }

  private runEvent(run: Run, type: string, time: string): void {
    this.insertEvent({
      id: crypto.randomUUID(), type, workspace: run.workspace, terminal: null, time, acked: false,
      payload: { run: run.id, agent: run.agent, status: run.status, exitCode: run.exitCode,
        error: run.status === "failed" || run.status === "interrupted" },
    });
  }
}
