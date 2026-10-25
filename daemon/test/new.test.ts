import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "@outscaled/protocol";
import { createClient } from "../src/cli/client";
import { startServer } from "../src/server";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
beforeEach(async () => { f = fixture(); app = await startServer(f.config); });
afterEach(async () => { await app.stop(); f.cleanup(); });

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "new", ...args], {
    cwd: f.root,
    env: { ...f.env, WSD_PORT: String(app.server.port), HOME: f.root, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

test("ws new clones demo, registers mine unchanged and GET lists both", async () => {
  const repo = localRepository(f.root);
  const demo = await cli(["demo", "--repo", repo, "--on", "local"]);
  const target = join(f.config.workspacesDir, "demo");
  expect(demo).toEqual({ code: 0, stdout: `${target}\n`, stderr: "" });
  expect(readFileSync(join(target, "README.md"), "utf8")).toBe("workspace fixture\n");
  const path = join(f.root, "existing folder");
  mkdirSync(path);
  writeFileSync(join(path, "keep"), "unchanged");
  const before = statSync(path);
  const mine = await cli(["mine", "--path", path, "--json"]);
  expect(mine.code).toBe(0);
  expect(mine.stderr).toBe("");
  const workspace = Workspace.parse(JSON.parse(mine.stdout));
  expect(workspace).toMatchObject({ slug: "mine", path, inPlace: true, repo: null });
  expect(readdirSync(path)).toEqual(["keep"]);
  expect(readFileSync(join(path, "keep"), "utf8")).toBe("unchanged");
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  const listed = await (await fetch(`http://127.0.0.1:${app.server.port}/v1/workspaces`)).json();
  expect(listed).toEqual([app.state.getWorkspace("demo"), workspace]);
});

test("ws new creates empty workspaces and resolves relative and tilde paths", async () => {
  expect(await cli(["empty"])).toEqual({ code: 0, stdout: `${join(f.config.workspacesDir, "empty")}\n`, stderr: "" });
  for (const [slug, argument, expected] of [
    ["relative", "./relative folder", join(realpathSync(f.root), "relative folder")],
    ["tilde", "~/tilde folder", join(f.root, "tilde folder")],
    ["home", "~", f.root],
  ]) {
    mkdirSync(expected!, { recursive: true });
    const result = await cli([slug!, "--path", argument!]);
    expect(result).toEqual({ code: 0, stdout: `${expected}\n`, stderr: "" });
    expect(app.state.getWorkspace(slug!)?.path).toBe(expected!);
  }
});

test("CLI errors print one line, no stdout, and exit 1", async () => {
  expect((await cli(["taken"])).code).toBe(0);
  for (const args of [[], ["one", "two"], ["Upper"], ["../escape"], ["bad", "--path", ""],
    ["both", "--repo", "repo", "--path", f.root], ["missing", "--path", "missing"],
    ["taken"], ["failed", "--repo", "file:///nonexistent-workspace-test-repository"]]) {
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toStartWith("ws: ");
  }
  expect(app.state.listWorkspaces()).toHaveLength(1);
}, 15000);

test("ws new allows responses beyond the default three-second client timeout", async () => {
  const workspace: Workspace = { slug: "slow", path: join(f.root, "slow"), repo: null, inPlace: false, createdAt: new Date().toISOString() };
  const slow = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      await Bun.sleep(3200);
      return Response.json(workspace, { status: 201 });
    },
  });
  try {
    expect(await cli(["slow"], { WSD_PORT: String(slow.port) }))
      .toEqual({ code: 0, stdout: `${workspace.path}\n`, stderr: "" });
  } finally {
    await slow.stop(true);
  }
}, 10000);

test("the client accepts a per-request timeout", async () => {
  const slow = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() { await Bun.sleep(100); return Response.json({ ok: true }); },
  });
  try {
    const client = createClient("local", { WSD_PORT: String(slow.port) });
    await expect(client.request("GET", "/", undefined, 10)).rejects.toThrow("wsd isn't reachable");
    expect(await client.request("GET", "/", undefined, 1000)).toEqual({ ok: true });
  } finally {
    await slow.stop(true);
  }
});
