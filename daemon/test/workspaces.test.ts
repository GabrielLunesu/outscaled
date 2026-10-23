import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError, Workspace } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let url: string;
beforeEach(async () => {
  f = fixture();
  app = await startServer(f.config);
  url = `http://127.0.0.1:${app.server.port}/v1/workspaces`;
});
afterEach(async () => { await app.stop(); f.cleanup(); });

const create = (body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) });
async function error(response: Response, status: number) {
  expect(response.status).toBe(status);
  return ApiError.parse(await response.json()).error;
}

test("creates an empty folder and missing workspaces root; listing survives restart", async () => {
  expect(await (await fetch(url)).json()).toEqual([]);
  expect(existsSync(f.config.workspacesDir)).toBe(false);
  const response = await create({ slug: "empty" });
  expect(response.status).toBe(201);
  const ws = Workspace.parse(await response.json());
  expect(ws).toMatchObject({ slug: "empty", path: join(f.config.workspacesDir, "empty"), repo: null, inPlace: false });
  expect(readdirSync(ws.path)).toEqual([]);
  expect(app.state.getWorkspace("empty")).toEqual(ws);
  await app.stop();
  app = await startServer(f.config);
  url = `http://127.0.0.1:${app.server.port}/v1/workspaces`;
  expect(await (await fetch(url)).json()).toEqual([ws]);
});

test("clones a local file URL and checks out its committed contents", async () => {
  const repo = localRepository(f.root);
  const response = await create({ slug: "demo", repo });
  expect(response.status).toBe(201);
  const ws = Workspace.parse(await response.json());
  expect(ws).toMatchObject({ slug: "demo", path: join(f.config.workspacesDir, "demo"), repo, inPlace: false });
  expect(readFileSync(join(ws.path, "README.md"), "utf8")).toBe("workspace fixture\n");
  expect(existsSync(join(ws.path, ".git"))).toBe(true);
  expect(existsSync(join(ws.path, ".ws"))).toBe(false);
});

test("a failed clone reports git's final error line, removes its folder and leaves no row", async () => {
  const repo = pathToFileURL(join(f.root, "missing-repository")).href;
  const failure = await error(await create({ slug: "failed", repo }), 500);
  expect(failure.code).toBe("clone_failed");
  expect(failure.message).toContain("Git clone failed:");
  expect(failure.message).toContain("and the repository exists.");
  expect(existsSync(join(f.config.workspacesDir, "failed"))).toBe(false);
  expect(app.state.listWorkspaces()).toEqual([]);
  expect((await create({ slug: "failed" })).status).toBe(201);
});

test("registers an existing directory without changing contents or metadata", async () => {
  const path = join(f.root, "existing");
  mkdirSync(path);
  const file = join(path, "keep.txt");
  writeFileSync(file, "unchanged\0contents");
  const directoryBefore = statSync(path);
  const fileBefore = statSync(file);
  const response = await create({ slug: "mine", path });
  expect(response.status).toBe(201);
  const ws = Workspace.parse(await response.json());
  expect(ws).toMatchObject({ slug: "mine", path, repo: null, inPlace: true });
  expect(readdirSync(path)).toEqual(["keep.txt"]);
  expect(readFileSync(file, "utf8")).toBe("unchanged\0contents");
  for (const key of ["ino", "mode", "mtimeMs", "ctimeMs"] as const) {
    expect(statSync(path)[key]).toBe(directoryBefore[key]);
    expect(statSync(file)[key]).toBe(fileBefore[key]);
  }
  expect(existsSync(f.config.workspacesDir)).toBe(false);
});

test("rejects a taken slug without creating or changing another folder", async () => {
  expect((await create({ slug: "taken" })).status).toBe(201);
  const existing = join(f.root, "existing");
  mkdirSync(existing);
  for (const options of [{}, { repo: "unused" }, { path: existing }]) {
    expect((await error(await create({ slug: "taken", ...options }), 409)).code).toBe("conflict");
  }
  expect(app.state.listWorkspaces()).toHaveLength(1);
  expect(readdirSync(existing)).toEqual([]);
});

test("existing targets block both empty creation and cloning, including files and dangling links", async () => {
  mkdirSync(f.config.workspacesDir);
  for (const kind of ["empty", "populated", "file", "link"]) {
    const target = join(f.config.workspacesDir, kind);
    if (kind === "file") writeFileSync(target, "keep");
    else if (kind === "link") symlinkSync(join(f.root, "missing"), target);
    else {
      mkdirSync(target);
      if (kind === "populated") writeFileSync(join(target, "keep"), "keep");
    }
    for (const options of [{}, { repo: "unused" }]) {
      await error(await create({ slug: kind, ...options }), 409);
    }
  }
  expect(readFileSync(join(f.config.workspacesDir, "populated", "keep"), "utf8")).toBe("keep");
  expect(readFileSync(join(f.config.workspacesDir, "file"), "utf8")).toBe("keep");
  expect(app.state.listWorkspaces()).toEqual([]);
});

test("rejects another registration of a path, including normalized paths and symlinks", async () => {
  const path = join(f.root, "existing");
  mkdirSync(path);
  const alias = join(f.root, "alias");
  symlinkSync(path, alias);
  expect((await create({ slug: "first", path })).status).toBe(201);
  for (const duplicate of [path, `${path}/../existing/`, alias]) {
    await error(await create({ slug: "second", path: duplicate }), 409);
  }
  expect((await create({ slug: "managed" })).status).toBe(201);
  await error(await create({ slug: "alias-managed", path: join(f.config.workspacesDir, "managed") }), 409);
  expect(app.state.listWorkspaces()).toHaveLength(2);
});

test("a registered path still blocks managed creation if its folder was removed", async () => {
  const path = join(f.config.workspacesDir, "reserved");
  mkdirSync(path, { recursive: true });
  expect((await create({ slug: "existing", path })).status).toBe(201);
  rmdirSync(path);
  await error(await create({ slug: "reserved" }), 409);
  expect(existsSync(path)).toBe(false);
  expect(app.state.listWorkspaces()).toHaveLength(1);
});

test("concurrent clones with the same slug have one winner and leave it intact", async () => {
  const repo = localRepository(f.root);
  const responses = await Promise.all([create({ slug: "race", repo }), create({ slug: "race", repo })]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  expect(app.state.listWorkspaces()).toHaveLength(1);
  expect(readFileSync(join(f.config.workspacesDir, "race", "README.md"), "utf8")).toBe("workspace fixture\n");
});

test("invalid bodies, slugs, repository values and non-directory paths return 400", async () => {
  const file = join(f.root, "file");
  writeFileSync(file, "keep");
  for (const body of [null, [], {}, { slug: "Upper" }, { slug: "../escape" }, { slug: "a".repeat(41) },
    { slug: "a", repo: "repo", path: f.root }, { slug: "a", repo: null }, { slug: "a", repo: "" },
    { slug: "a", repo: "   " }, { slug: "a", repo: "bad\0repo" }, { slug: "a", path: "" },
    { slug: "a", path: "relative" }, { slug: "a", path: "~/project" }, { slug: "a", path: file },
    { slug: "a", path: join(f.root, "missing") }, { slug: "a", path: `${file}/child` },
    { slug: "a", path: `${f.root}/bad\0path` }]) {
    expect((await error(await create(body), 400)).code).toBe("invalid_request");
  }
  for (const body of ["{broken", ""]) await error(await fetch(url, { method: "POST", body }), 400);
  expect(app.state.listWorkspaces()).toEqual([]);
  expect(existsSync(f.config.workspacesDir)).toBe(false);
});
