import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { Tmux } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";
import { fakeSsh } from "./ssh-helpers";

let f: ReturnType<typeof fixture>;
let ssh: ReturnType<typeof fakeSsh>;
let env: NodeJS.ProcessEnv;
let daemons: { f: ReturnType<typeof fixture>; app: Awaited<ReturnType<typeof startServer>> }[];
let mocks: ReturnType<typeof Bun.serve>[];

beforeEach(() => {
  f = fixture();
  ssh = fakeSsh(f.root);
  env = { ...f.env, ...ssh.env, OUTSCALED_CONFIG_DIR: f.env.WSD_CONFIG_DIR };
  daemons = [];
  mocks = [];
});

afterEach(async () => {
  for (const server of mocks) await server.stop(true);
  for (const { f, app } of daemons) {
    await app.stop();
    Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { env: f.env });
    f.cleanup();
  }
  try { for (const call of ssh.invocations()) ssh.assertClean(call); }
  finally { f.cleanup(); }
});

function servers(...hosts: string[]) {
  writeFileSync(join(env.OUTSCALED_CONFIG_DIR!, "servers.toml"), hosts.map(host => `[[server]]\nhost = ${JSON.stringify(host)}\n`).join(""));
}

async function daemon() {
  const f = fixture();
  const app = await startServer(f.config);
  const result = { f, app };
  daemons.push(result);
  return result;
}

async function open(app: Awaited<ReturnType<typeof startServer>>, slug: string, name: string) {
  if (!app.state.getWorkspace(slug)) {
    const path = join(daemons.find(daemon => daemon.app === app)!.f.root, slug);
    mkdirSync(path, { recursive: true });
    app.state.insertWorkspace({ ...workspace, slug, path });
  }
  const response = await fetch(`http://127.0.0.1:${app.server.port}/v1/workspaces/${slug}/terminals`, {
    method: "POST", body: JSON.stringify({ name, command: "sleep 600" }),
  });
  expect(response.status).toBe(201);
  return Terminal.parse(await response.json());
}

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, "src/ws.ts", "status", ...args], {
    cwd: join(import.meta.dir, ".."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test("all-terminals route sorts two workspaces and names, refreshes killed sessions and preserves crashed", async () => {
  const { f, app } = await daemon();
  const killed = await open(app, "zebra", "z");
  const crashed = await open(app, "zebra", "a");
  await open(app, "alpha", "z");
  await open(app, "alpha", "a");
  const tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
  await tmux.killSession(killed.session);
  await tmux.killSession(crashed.session);
  app.state.updateTerminalState(crashed.id, { state: "crashed", pid: null });
  const address = `http://127.0.0.1:${app.server.port}/v1/terminals`;
  const response = await fetch(address);
  expect(response.status).toBe(200);
  const rows = Terminal.array().parse(await response.json());
  expect(rows.map(row => [row.workspace, row.name, row.state])).toEqual([
    ["alpha", "a", "running"], ["alpha", "z", "running"],
    ["zebra", "a", "crashed"], ["zebra", "z", "exited"],
  ]);
  expect(rows.find(row => row.id === killed.id)?.pid).toBeNull();
  expect(app.state.getTerminal(killed.id)?.state).toBe("exited");
  expect((await fetch(address, { method: "POST" })).status).toBe(404);
});

test("status lists local plus two distinct remote daemons in aligned text and JSON, and keeps successes on failure", async () => {
  const local = await daemon();
  const first = await daemon();
  const second = await daemon();
  const localRow = await open(local.app, "local-work", "shell");
  const firstRow = await open(first.app, "remote-work", "agent");
  const secondRow = await open(second.app, "other", "worker");
  first.app.state.db.query("UPDATE terminals SET runtime = 'codex' WHERE id = ?").run(firstRow.id);
  first.app.state.updateTerminalStatus(firstRow.id, "needs_input");
  servers("example-b", "example-a");
  env.WSD_PORT = String(local.app.server.port);
  const hosts = { "example-b": { port: first.app.server.port }, "example-a": { port: second.app.server.port } };
  env.WS_TEST_SSH_HOSTS = JSON.stringify(hosts);
  const result = await cli();
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.map(line => line.trim().split(/\s+/))).toEqual([
    ["local", "local-work", "shell", "running", "-"],
    ["example-b", "remote-work", "agent", "running", "needs_input"],
    ["example-a", "other", "worker", "running", "-"],
  ]);
  const columns = [...lines[0]!.matchAll(/\S+/g)].map(match => match.index);
  for (const line of lines) expect([...line.matchAll(/\S+/g)].map(match => match.index)).toEqual(columns);
  const json = await cli("--json");
  expect(json.code).toBe(0);
  expect(json.stderr).toBe("");
  expect(JSON.parse(json.stdout)).toEqual([
    { server: "local", terminals: [localRow] },
    { server: "example-b", terminals: [first.app.state.getTerminal(firstRow.id)] },
    { server: "example-a", terminals: [secondRow] },
  ]);

  env.WS_TEST_SSH_HOSTS = JSON.stringify({ ...hosts, "example-b": { mode: "auth" } });
  const partial = await cli();
  expect(partial.code).toBe(1);
  expect(partial.stdout.trim().split("\n").map(line => line.trim().split(/\s+/)[0])).toEqual(["local", "example-a"]);
  expect(partial.stderr.trim().split("\n")).toHaveLength(1);
  expect(partial.stderr).toContain("example-b: SSH tunnel failed");
  expect(partial.stderr).toContain("Permission denied");
  const partialJson = await cli("--json");
  expect(partialJson.code).toBe(1);
  expect(partialJson.stderr).toBe("");
  expect(JSON.parse(partialJson.stdout)).toEqual([
    { server: "local", terminals: [localRow] },
    { server: "example-b", error: expect.stringContaining("Permission denied") },
    { server: "example-a", terminals: [secondRow] },
  ]);
}, 15000);

test("missing servers.toml means local only; an empty server prints no text", async () => {
  const { app } = await daemon();
  env.WSD_PORT = String(app.server.port);
  expect(await cli()).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await cli("--json")).toEqual({ code: 0, stdout: '[{"server":"local","terminals":[]}]\n', stderr: "" });
  expect(ssh.invocations()).toEqual([]);
});

test("invalid server lists and --on are rejected before querying", async () => {
  servers("-invalid");
  const invalid = await cli();
  expect(invalid.code).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("servers.toml:");
  for (const args of [["--on", "local"], ["--on=example"], ["extra"], ["--unknown"]]) {
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    if (args[0]!.startsWith("--on")) expect(result.stderr).toContain("--on is not accepted because status covers every server");
  }
  expect(ssh.invocations()).toEqual([]);
});

test("server queries run in parallel and a stalled HTTP body times out without hiding other servers", async () => {
  let release!: () => void;
  const remoteReached = new Promise<void>(resolve => { release = resolve; });
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    // A sequential implementation never reaches the remote that releases this.
    await remoteReached;
    return Response.json([terminal]);
  } });
  const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/v1/health") return Response.json({});
    release();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("[")); } }));
  } });
  const fast = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json([]); } });
  mocks.push(local, slow, fast);
  env.WSD_PORT = String(local.port);
  env.WS_TEST_SSH_HOSTS = JSON.stringify({ "example-slow": { port: slow.port }, "example-fast": { port: fast.port } });
  servers("example-slow", "example-fast");
  try {
    const result = await cli("--json");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      { server: "local", terminals: [terminal] },
      { server: "example-slow", error: expect.stringContaining("request failed or timed out") },
      { server: "example-fast", terminals: [] },
    ]);
  } finally { release(); }
}, 10000);
