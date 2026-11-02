import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceChanges, type StreamMessage, type Terminal } from "@outscaled/protocol";
import { Changes, parseStatus } from "../src/changes";
import { createChangesRoute } from "../src/routes/changes";
import { createHooksRoute } from "../src/routes/hooks";
import { State } from "../src/state";
import { Terminals, writeClaudeSettings } from "../src/terminals";
import { Tmux } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";
import { localRepository } from "./workspace-helpers";

let f: ReturnType<typeof fixture>;
let state: State;
let changes: Changes;
let root: string;
let messages: StreamMessage[];
let agent: Terminal;

beforeEach(() => {
  f = fixture();
  root = fileURLToPath(localRepository(f.root));
  messages = [];
  state = new State(f.config.statePath, message => messages.push(message));
  state.insertWorkspace({ ...workspace, path: root });
  agent = state.insertTerminal({ ...terminal, name: "claude-1", session: "ws-demo-claude-1", runtime: "claude-code" });
  changes = new Changes(state);
});
afterEach(() => { state.close(); f.cleanup(); });

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
const write = (path: string, text = "changed") => writeFileSync(join(root, path), text);
const list = () => changes.list(state.getWorkspace("demo")!);
function codex() {
  return state.insertTerminal({ ...terminal, id: "codex-id", name: "codex-1", session: "ws-demo-codex-1", runtime: "codex" });
}

for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
  test(`${tool} hook records relative and absolute paths with the launch-only edit matcher`, async () => {
    const file = `${tool}.txt`;
    write(file);
    const terminals = new Terminals(state, new Tmux(f.config.tmuxSocket));
    const route = createHooksRoute({ config: f.config, state, terminals });
    const payload = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: {
      [tool === "NotebookEdit" ? "notebook_path" : "file_path"]: tool === "Edit" ? join(root, file) : `./${file}`,
    } };
    const response = await route(new Request("http://localhost/v1/hooks/claude-code", {
      method: "POST", body: JSON.stringify({ terminal: agent.id, payload }),
    }), "127.0.0.1");
    expect(response?.status).toBe(204);
    expect((await list()).files).toEqual([{ path: file, originalPath: null, status: "untracked", agents: [
      { terminal: "claude-1", runtime: "claude-code", time: expect.any(String), inferred: false },
    ] }]);
    const settings = await Bun.file(writeClaudeSettings(f.config.stateDir)).json();
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(messages.some(message => message.type === "workspace.changes")).toBe(true);
  });
}

test("hooks ignore missing/malformed paths, other tools, pre-tool calls and outside symlinks", async () => {
  write("local");
  const outside = join(f.root, "outside");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "outside-link"));
  symlinkSync(f.root, join(root, "outside-dir"));
  for (const input of [undefined, null, [], {}, { file_path: 1 }, { file_path: "" }, { file_path: "x\0y" },
    { file_path: "../outside" }, { file_path: outside }, { file_path: "outside-link" }, { file_path: "outside-dir/missing" }]) {
    await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input });
  }
  await changes.claudeEdit(agent, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "local" } });
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { file_path: "local" } });
  expect([...state.changeAttributions("demo")]).toEqual([]);
});

test("Codex diffs new, modified, deleted, staged renamed and untracked paths, including already dirty content", async () => {
  for (const name of ["delete", "rename", "modify"]) write(name, "tracked");
  git("add", "."); git("commit", "-m", "Seed");
  write("README.md", "dirty before"); write("unchanged-dirty", "keep");
  const x = codex();
  await changes.startTurn(x);
  write("README.md", "dirty again"); write("modify", "new contents");
  rmSync(join(root, "delete"));
  renameSync(join(root, "rename"), join(root, "renamed\nfile")); git("add", "rename", "renamed\nfile");
  write("added", "new staged"); git("add", "added");
  mkdirSync(join(root, "nested")); write("nested/untracked", "new untracked");
  await changes.endTurn(x);
  const response = WorkspaceChanges.parse(await list());
  expect(response.attributionAvailable).toBe(true);
  const files = new Map(response.files.map(file => [file.path, file]));
  for (const [name, status] of [["README.md", "modified"], ["modify", "modified"], ["delete", "deleted"], ["renamed\nfile", "renamed"], ["added", "added"], ["nested/untracked", "untracked"]]) {
    expect(files.get(name!)).toMatchObject({ status, agents: [{ terminal: "codex-1", runtime: "codex", inferred: true }] });
  }
  expect(files.get("renamed\nfile")?.originalPath).toBe("rename");
  expect(files.get("unchanged-dirty")?.agents).toEqual([]);
  await changes.endTurn(x); // Duplicate notify cannot attribute unrelated later edits.
  expect(state.changeAttributions("demo").size).toBe(6);
});

test("content hashing detects a second edit with unchanged size and mtime", async () => {
  write("README.md", "before");
  const time = statSync(join(root, "README.md")).mtime;
  const x = codex(); await changes.startTurn(x);
  write("README.md", "after!"); utimesSync(join(root, "README.md"), time, time);
  await changes.endTurn(x);
  expect((await list()).files[0]?.agents[0]?.terminal).toBe("codex-1");
});

test("large files use size/mtime while small files use hashes; snapshots cap paths and log", async () => {
  changes = new Changes(state, { paths: 2, fileSize: 8 });
  write("a", "large contents"); write("b", "small"); write("c", "omitted");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = (await changes.snapshot(state.getWorkspace("demo")!))!;
    expect(before.fingerprints.size).toBe(2);
    expect(before.capped).toBe(true);
    expect(before.fingerprints.get("a")).toContain("metadata:");
    expect(before.fingerprints.get("b")).toContain("sha256:");
    const x = codex(); await changes.startTurn(x);
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, "a"), future, future);
    utimesSync(join(root, "b"), future, future);
    await changes.endTurn(x);
    expect([...state.changeAttributions("demo").keys()]).toEqual(["a"]);
    // Move a formerly omitted path into the cap. It must not look newly dirty.
    await changes.startTurn(x); rmSync(join(root, "a")); write("b", "edited"); write("c", "edited too");
    await changes.endTurn(x);
    expect([...state.changeAttributions("demo").keys()]).toEqual(["b"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("path cap hit (2 of 3)"));
  } finally { log.mockRestore(); }
});

test("all agents are retained newest first, repeated edits coalesce, records survive reopen and prune on commit/revert", async () => {
  write("README.md", "first");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "README.md" } });
  await Bun.sleep(2);
  const x = codex(); await changes.startTurn(x); write("README.md", "second"); await changes.endTurn(x);
  expect((await list()).files[0]?.agents.map(a => a.terminal)).toEqual(["codex-1", "claude-1"]);
  await Bun.sleep(2);
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "README.md" } });
  expect((await list()).files[0]?.agents.map(a => a.terminal)).toEqual(["claude-1", "codex-1"]);
  state.close(); state = new State(f.config.statePath); changes = new Changes(state);
  expect((await list()).files[0]?.agents).toHaveLength(2);
  git("add", "."); git("commit", "-m", "Commit changes");
  expect((await list()).files).toEqual([]);
  expect(state.changeAttributions("demo").size).toBe(0);
  write("README.md", "third");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "README.md" } });
  git("restore", "README.md"); await list();
  expect(state.changeAttributions("demo").size).toBe(0);
});

test("non-git workspaces report unavailable; route validates workspace and returns the protocol response", async () => {
  const plain = join(f.root, "plain"); mkdirSync(plain);
  state.insertWorkspace({ ...workspace, slug: "plain", path: plain });
  const terminals = new Terminals(state, new Tmux(f.config.tmuxSocket));
  const route = createChangesRoute({ config: f.config, state, terminals });
  for (const [slug, status] of [["plain", 200], ["missing", 404], ["INVALID", 400]] as const) {
    const response = (await route(new Request(`http://localhost/v1/workspaces/${slug}/changes`)))!;
    expect(response.status).toBe(status);
    if (status === 200) expect(WorkspaceChanges.parse(await response.json())).toEqual({ attributionAvailable: false, files: [] });
  }
  const x = { ...codex(), workspace: "plain" };
  await changes.startTurn(x); await changes.endTurn(x);
  await changes.claudeEdit({ ...agent, workspace: "plain" }, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "new" } });
  expect(state.changeAttributions("plain").size).toBe(0);
  write("a");
  expect(WorkspaceChanges.parse(await (await route(new Request("http://localhost/v1/workspaces/demo/changes")))!.json()).files[0]?.path).toBe("a");
});

test("nested workspaces scope git root paths and keep unusual rename names intact", async () => {
  mkdirSync(join(root, "nested"));
  write("nested/a", "one"); write("outside", "one"); git("add", "."); git("commit", "-m", "Seed");
  write("outside", "two"); write("nested/a", "two");
  state.updateWorkspace("demo", { path: join(root, "nested") });
  expect((await list()).files.map(f => f.path)).toEqual(["a"]);
  expect(parseStatus("R  new\nname\0old\tname\0?? dir/file\0")).toMatchObject([
    { path: "new\nname", originalPath: "old\tname", status: "renamed" }, { path: "dir/file", status: "untracked" },
  ]);
});

test("workspace changes events coalesce bursts with a trailing refetch independently per workspace", async () => {
  await Bun.sleep(0); messages.length = 0;
  state.notifyChanges("demo"); state.notifyChanges("demo"); state.notifyChanges("demo");
  state.notifyChanges("other");
  expect(messages).toEqual([{ type: "workspace.changes", workspace: "demo" }, { type: "workspace.changes", workspace: "other" }]);
  await Bun.sleep(500); state.notifyChanges("demo");
  expect(messages).toHaveLength(2);
  await Bun.sleep(550);
  expect(messages.filter(m => m.type === "workspace.changes" && m.workspace === "demo")).toHaveLength(2);
  expect(state.listEvents()).toEqual([]);
});


test("rename carries earlier agents forward while pruning the old path", async () => {
  write("README.md", "workspace fixture\nfirst edit\n");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "README.md" } });
  const x = codex(); await changes.startTurn(x);
  git("mv", "README.md", "renamed"); git("add", "renamed");
  await changes.endTurn(x);
  const file = (await list()).files[0]!;
  expect(file).toMatchObject({ path: "renamed", originalPath: "README.md", status: "renamed" });
  expect(file.agents.map(a => a.terminal)).toEqual(["codex-1", "claude-1"]);
  expect(state.changeAttributions("demo").has("README.md")).toBe(false);
});


test("Claude accepts physical absolute paths in a workspace registered through a symlink", async () => {
  const alias = join(f.root, "alias"); symlinkSync(root, alias);
  state.updateWorkspace("demo", { path: alias });
  write("README.md", "edit");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "README.md") } });
  expect((await list()).files[0]?.agents[0]?.terminal).toBe("claude-1");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(alias, "README.md") } });
  expect((await list()).files[0]?.agents).toHaveLength(1);
});

test("a Claude edit restoring a clean path prunes records and still signals a refetch", async () => {
  write("README.md", "edit");
  const payload = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "README.md" } };
  await changes.claudeEdit(agent, payload);
  git("restore", "README.md");
  const notify = spyOn(state, "notifyChanges");
  await changes.claudeEdit(agent, payload);
  expect(notify).toHaveBeenCalledWith("demo");
  expect(state.changeAttributions("demo").size).toBe(0);
});


test("Claude edits through contained symlinks attribute the dirty target", async () => {
  symlinkSync("README.md", join(root, "alias-file"));
  write("README.md", "edited target");
  await changes.claudeEdit(agent, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "alias-file" } });
  expect((await list()).files.find(file => file.path === "README.md")?.agents[0]?.terminal).toBe("claude-1");
});
