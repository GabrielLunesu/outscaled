import type { Database } from "bun:sqlite";
import { terminalRuntime } from "./terminals";

const migrations = [
  `CREATE TABLE workspaces (
    slug TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    repo TEXT,
    inPlace INTEGER NOT NULL CHECK (inPlace IN (0, 1)),
    createdAt TEXT NOT NULL
  );
  CREATE TABLE terminals (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(slug),
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    session TEXT NOT NULL UNIQUE,
    alwaysOn INTEGER NOT NULL CHECK (alwaysOn IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('running', 'restarting', 'exited', 'crashed')),
    restarts INTEGER NOT NULL CHECK (restarts >= 0),
    pid INTEGER,
    createdAt TEXT NOT NULL,
    UNIQUE (workspace, name)
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    workspace TEXT,
    terminal TEXT,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    time TEXT NOT NULL,
    acked INTEGER NOT NULL CHECK (acked IN (0, 1))
  );
  CREATE INDEX events_time ON events(time);
  CREATE INDEX events_workspace ON events(workspace);`,
  `ALTER TABLE terminals ADD COLUMN runtime TEXT CHECK (runtime IN ('claude-code', 'codex'));
  ALTER TABLE terminals ADD COLUMN status TEXT CHECK (status IN ('starting', 'working', 'needs_input', 'idle'));
  ALTER TABLE terminals ADD COLUMN statusChangedAt TEXT;`,
];

export function migrate(db: Database): void {
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > migrations.length) throw new Error(`State database version ${version} is newer than this wsd supports`);
    for (let index = version; index < migrations.length; index++) {
      db.exec(migrations[index]!);
      if (index === 1) {
        for (const row of db.query<{ id: string; command: string }, []>("SELECT id, command FROM terminals").all()) {
          db.query("UPDATE terminals SET runtime = ? WHERE id = ?").run(terminalRuntime(row.command), row.id);
        }
      }
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
  }).immediate();
}
