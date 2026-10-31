import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Event, Terminal, TerminalStatus, Workspace } from "@outscaled/protocol";
import { migrate } from "./migrations";

type WorkspaceRow = Omit<Workspace, "inPlace"> & { inPlace: number };
type TerminalRow = Omit<Terminal, "alwaysOn"> & { alwaysOn: number };
type EventRow = Omit<Event, "payload" | "acked"> & { payload: string; acked: number };
const workspaceFromRow = (row: WorkspaceRow): Workspace => ({ ...row, inPlace: Boolean(row.inPlace) });
const terminalFromRow = (row: TerminalRow): Terminal => ({ ...row, alwaysOn: Boolean(row.alwaysOn) });
const eventFromRow = (row: EventRow): Event => ({ ...row, payload: JSON.parse(row.payload), acked: Boolean(row.acked) });

export class State {
  readonly db: Database;

  constructor(path: string) {
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

  close(): void { this.db.close(); }

  insertWorkspace(value: Workspace): Workspace {
    const ws = Workspace.parse(value);
    this.db.query("INSERT INTO workspaces (slug, path, repo, inPlace, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(ws.slug, ws.path, ws.repo, Number(ws.inPlace), ws.createdAt);
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
      (id, workspace, name, command, session, alwaysOn, state, restarts, pid, createdAt, runtime, status, statusChangedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.workspace, t.name, t.command, t.session, Number(t.alwaysOn), t.state, t.restarts, t.pid, t.createdAt,
      t.runtime, t.status, t.statusChangedAt,
    );
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
    return next;
  }

  terminalCounts(): { total: number; running: number } {
    return this.db.query<{ total: number; running: number }, []>(
      "SELECT count(*) AS total, coalesce(sum(state = 'running'), 0) AS running FROM terminals",
    ).get()!;
  }

  updateTerminalStatus(id: string, status: TerminalStatus): Terminal | null {
    TerminalStatus.parse(status);
    return this.db.transaction(() => {
      const current = this.getTerminal(id);
      if (!current || !current.runtime || current.status === status) return current;
      const time = new Date().toISOString();
      this.db.query("UPDATE terminals SET status = ?, statusChangedAt = ? WHERE id = ?").run(status, time, id);
      const event = {
        id: crypto.randomUUID(), type: "terminal.status", workspace: current.workspace,
        terminal: id, payload: { terminal: id, oldStatus: current.status, newStatus: status }, time, acked: false,
      };
      this.insertEvent(event);
      if (status === "needs_input") {
        this.insertEvent({ ...event, id: crypto.randomUUID(), type: "agent.needs_input" });
      }
      return this.getTerminal(id);
    })();
  }

  insertEvent(value: Event): Event {
    const event = Event.parse(value);
    this.db.query("INSERT INTO events (id, type, workspace, terminal, payload, time, acked) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.workspace, event.terminal, JSON.stringify(event.payload), event.time, Number(event.acked));
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
}
