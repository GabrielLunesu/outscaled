import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Event } from "@outscaled/protocol";
import { State } from "../src/state";
import { migrate } from "../src/migrations";
import { fixture, terminal, workspace } from "./helpers";

let state: State | undefined;
let f: ReturnType<typeof fixture> | undefined;
afterEach(() => { state?.close(); state = undefined; f?.cleanup(); });

test("migration creates full schema once and preserves data across reopen", () => {
  f = fixture();
  state = new State(f.config.statePath);
  expect(state.db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  state.insertWorkspace(workspace);
  state.insertTerminal(terminal);
  const event: Event = { id: "event-1", type: "terminal.status", workspace: workspace.slug, terminal: terminal.id,
    payload: { state: "running", nested: [null, true, 1] }, time: workspace.createdAt, acked: false };
  state.insertEvent(event);
  state.close();
  state = new State(f.config.statePath);
  expect(state.getWorkspace(workspace.slug)).toEqual(workspace);
  expect(state.getTerminal(terminal.id)).toEqual(terminal);
  expect(state.getEvent(event.id)).toEqual(event);
  expect(state.listWorkspaces()).toEqual([workspace]);
  expect(state.listTerminals("demo")).toEqual([terminal]);
  expect(state.listTerminals("missing")).toEqual([]);
  expect(state.listEvents("demo")).toEqual([event]);
  expect(state.listEvents("missing")).toEqual([]);
  expect(state.updateWorkspace("demo", { inPlace: true, repo: "example-repo" })).toMatchObject({ inPlace: true, repo: "example-repo" });
  expect(state.updateTerminalState(terminal.id, { state: "restarting", restarts: 1, pid: 123 })).toMatchObject({ state: "restarting", restarts: 1, pid: 123 });
  expect(state.terminalCounts()).toEqual({ total: 1, running: 0 });
  expect(state.acknowledgeEvent(event.id)?.acked).toBe(true);
  expect(state.listEvents()[0]?.acked).toBe(true);
  expect(state.listTerminals()[0]?.restarts).toBe(1);
  expect(state.getWorkspace("missing")).toBeNull();
  expect(state.getTerminal("missing")).toBeNull();
  expect(state.getEvent("missing")).toBeNull();
  expect(state.updateWorkspace("missing", {})).toBeNull();
  expect(state.updateTerminalState("missing", { state: "exited" })).toBeNull();
  expect(state.acknowledgeEvent("missing")).toBeNull();
});

test("rejects future schema versions without changing the database", () => {
  f = fixture();
  const path = join(f.root, "future.db");
  const db = new Database(path);
  db.exec("PRAGMA user_version = 99");
  expect(() => new State(path)).toThrow("newer than this wsd supports");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
  db.close();
});

test("enforces workspace references and unique terminal names and validates writes", () => {
  state = new State(":memory:");
  expect(state.terminalCounts()).toEqual({ total: 0, running: 0 });
  expect(() => state!.insertTerminal(terminal)).toThrow();
  state.insertWorkspace(workspace);
  state.insertTerminal(terminal);
  expect(() => state!.insertTerminal({ ...terminal, id: "another" })).toThrow();
  expect(() => state!.insertTerminal({ ...terminal, session: "wrong" })).toThrow();
  expect(() => state!.updateTerminalState(terminal.id, { state: "crashed", restarts: -1 })).toThrow();
});

test("a failed migration rolls back tables and user_version together", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE terminals (existing TEXT)");
    expect(() => migrate(db)).toThrow();
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "terminals" }]);
  } finally {
    db.close();
  }
});

test("upgrade clears only screen-derived agent lines and preserves agent text and shells", () => {
  f = fixture();
  state = new State(f.config.statePath);
  state.insertWorkspace(workspace);
  for (const [index, runtime, fromAgent] of [
    [0, "claude-code", false], [1, "codex", false],
    [2, "claude-code", true], [3, "codex", true], [4, null, false],
  ] as const) {
    const id = `line-${index}`;
    state.insertTerminal({ ...terminal, id, name: id, session: `ws-demo-${id}`, runtime });
    // Seed the v6 representation, before screen writes to agents were forbidden.
    state.db.query("UPDATE terminals SET latestLine = ?, latestLineFromAgent = ? WHERE id = ?")
      .run(`stored ${index}`, Number(fromAgent), id);
  }
  state.db.exec("PRAGMA user_version = 6");
  state.close();
  state = new State(f.config.statePath);
  expect(state.listTerminals().map(row => row.latestLine)).toEqual([null, null, "stored 2", "stored 3", "stored 4"]);
  state.close();
  state = new State(f.config.statePath);
  expect(state.listTerminals().map(row => row.latestLine)).toEqual([null, null, "stored 2", "stored 3", "stored 4"]);
});
