import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { State } from "../src/state";
import { fixture, workspace } from "./helpers";

test("version-1 state upgrades with derived runtimes, unknown statuses and preserved data", () => {
  const f = fixture();
  const path = `${f.root}/v1.db`;
  const old = new Database(path);
  // Frozen version-1 schema: do not create this fixture through today's migrate.
  old.exec(`CREATE TABLE workspaces (
    slug TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, repo TEXT,
    inPlace INTEGER NOT NULL CHECK (inPlace IN (0, 1)), createdAt TEXT NOT NULL
  );
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(slug),
    name TEXT NOT NULL, command TEXT NOT NULL, session TEXT NOT NULL UNIQUE,
    alwaysOn INTEGER NOT NULL CHECK (alwaysOn IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('running', 'restarting', 'exited', 'crashed')),
    restarts INTEGER NOT NULL CHECK (restarts >= 0), pid INTEGER, createdAt TEXT NOT NULL,
    UNIQUE (workspace, name)
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, workspace TEXT, terminal TEXT,
    payload TEXT NOT NULL CHECK (json_valid(payload)), time TEXT NOT NULL,
    acked INTEGER NOT NULL CHECK (acked IN (0, 1))
  );
  CREATE INDEX events_time ON events(time);
  CREATE INDEX events_workspace ON events(workspace);
  PRAGMA user_version = 1;`);
  old.query("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)").run(workspace.slug, workspace.path, null, 0, workspace.createdAt);
  for (const [name, command] of [["c1", "claude --resume"], ["c2", "'/opt/agent bin/claude'"], ["x1", "/opt/bin/codex exec hello"], ["shell", "/bin/sh"], ["other", "env claude"]]) {
    old.query("INSERT INTO terminals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(name!, workspace.slug, name!, command!, `ws-demo-${name}`, 1, "running", 3, 123, workspace.createdAt);
  }
  old.query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)").run("event-1", "agent.crashed", "demo", "c1", "{}", workspace.createdAt, 0);
  old.close();
  let state: State | undefined;
  try {
    state = new State(path);
    expect(state.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(state.getWorkspace("demo")).toEqual(workspace);
    for (const [id, runtime] of [["c1", "claude-code"], ["c2", "claude-code"], ["x1", "codex"], ["shell", null], ["other", null]]) {
      expect(state.getTerminal(id!)!).toMatchObject({ runtime, status: null, statusChangedAt: null, state: "running", pid: 123, restarts: 3 });
    }
    expect(state.listEvents()).toHaveLength(1);
    state.close();
    state = new State(path);
    expect(state.listTerminals()).toHaveLength(5);
    expect(state.listEvents()[0]?.id).toBe("event-1");
  } finally {
    state?.close();
    f.cleanup();
  }
});
