import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Terminal } from "@outscaled/protocol";
import { createHooksRoute } from "../src/routes/hooks";
import { startServer } from "../src/server";
import { shellQuote, wsCliArgv } from "../src/terminals";
import { fixture, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let address: string;
let originalShell: string | undefined;
let originalHome: string | undefined;
let bin: string;

beforeEach(async () => {
  f = fixture();
  originalShell = process.env.SHELL;
  originalHome = process.env.HOME;
  process.env.SHELL = "/bin/bash";
  process.env.HOME = f.root;
  bin = join(f.root, "agent bin 'quoted'; $literal");
  mkdirSync(bin);
  writeFileSync(join(f.root, ".bash_profile"), `export PATH=${shellQuote(bin)}:"$PATH"\n`);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const notify = Bun.TOML.parse(args[1]).notify;
const id = process.env.WSD_TERMINAL;
// Isolate agent output from the test driver's input echo.
Bun.spawnSync(["/bin/stty", "-echo"], {stdin: "inherit"});
await Bun.write(id + ".launch.json", JSON.stringify({args, notify, terminal: id, port: process.env.WSD_PORT}));
console.log("startup");
if (args.includes("--exit")) process.exit(23);
if (args.includes("--slow-start")) { await Bun.sleep(800); console.log("startup settled"); }
for await (const line of createInterface({input: process.stdin})) {
  if (line === "work") console.log("working output");
  if (line === "done") {
    const payload = {type: "agent-turn-complete", "thread-id": "test-thread", "turn-id": "test-turn", cwd: process.cwd(), "input-messages": ["hi"], "last-assistant-message": "hi"};
    const child = Bun.spawn([...notify, JSON.stringify(payload)], {
      env: {...process.env, PATH: "/usr/bin:/bin"}, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Bun.write(id + ".hook.json", JSON.stringify({code, stdout, stderr}));
    await Bun.sleep(100);
    console.log("post-notify redraw");
  }
}
`, { mode: 0o755 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nprintf 'claude startup\\n'\nexec sleep 600\n", { mode: 0o755 });
  // Keep restarting observable for a full poll, rather than racing respawn.
  app = await startServer(f.config, { backoffMs: [100] });
  address = `http://127.0.0.1:${app.server.port}`;
  app.state.insertWorkspace({ ...workspace, path: f.root });
});

afterEach(async () => {
  await app?.stop();
  if (f) {
    Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]);
    f.cleanup();
  }
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function eventually(check: () => boolean | Promise<boolean>, timeout = 4500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for Codex status");
}

async function open(command = "codex", alwaysOn = false, name = "x1") {
  const response = await fetch(`${address}/v1/workspaces/demo/terminals`, {
    method: "POST", body: JSON.stringify({ name, command, alwaysOn }),
  });
  expect(response.status).toBe(201);
  return Terminal.parse(await response.json());
}

function row(terminal: Terminal) { return app.state.getTerminal(terminal.id)!; }

function send(terminal: Terminal, line: string) {
  const result = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "send-keys", "-t", `=${terminal.session}:`, line, "Enter"]);
  expect(result.exitCode).toBe(0);
}

async function post(terminal: Terminal, payload: unknown, runtime = "codex") {
  return fetch(`${address}/v1/hooks/${runtime}`, {
    method: "POST", body: JSON.stringify({ terminal: terminal.id, payload }),
  });
}

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "hook", "codex", ...args], {
    env: { ...f.env, WSD_PORT: String(app.server.port), ...env },
    // Intentionally keep stdin open: Codex notifications are argv, not stdin.
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { child.stdin.end(); }
}

test("Codex launch, startup settle, output, notify and redraw use the absolute hook argv", async () => {
  const command = `${shellQuote(join(bin, "codex"))} --model 'test model; $literal' --slow-start`;
  const started = Date.now();
  const terminal = await open(command);
  expect(terminal).toMatchObject({ command, runtime: "codex", status: "starting" });
  await eventually(() => Bun.file(join(f.root, `${terminal.id}.launch.json`)).exists());
  const launch = JSON.parse(readFileSync(join(f.root, `${terminal.id}.launch.json`), "utf8"));
  const expectedNotify = [...wsCliArgv(), "hook", "codex"];
  expect(launch).toEqual({
    args: ["-c", `notify=${JSON.stringify(expectedNotify)}`, "--model", "test model; $literal", "--slow-start"],
    notify: expectedNotify, terminal: terminal.id, port: String(app.server.port),
  });
  expect(isAbsolute(launch.notify[0])).toBe(true);
  expect(isAbsolute(launch.notify[1])).toBe(true);
  await Bun.sleep(2000);
  expect(row(terminal).status).toBe("starting");
  await eventually(() => row(terminal).status === "idle");
  expect(Date.now() - started).toBeGreaterThanOrEqual(2800);
  send(terminal, "work");
  await eventually(() => row(terminal).status === "working", 1100);
  send(terminal, "done");
  await eventually(() => row(terminal).status === "idle", 1100);
  await Bun.sleep(1500);
  expect(row(terminal).status).toBe("idle");
  expect(JSON.parse(readFileSync(join(f.root, `${terminal.id}.hook.json`), "utf8"))).toEqual({ code: 0, stdout: "", stderr: "" });
  // Duplicate notify while already idle must also protect the final redraw.
  send(terminal, "done");
  await Bun.sleep(1500);
  expect(row(terminal).status).toBe("idle");
  send(terminal, "work");
  await eventually(() => row(terminal).status === "working", 1100);
  const beforeExit = row(terminal);
  process.kill(beforeExit.pid!, "SIGKILL");
  await eventually(() => row(terminal).state === "exited");
  expect(row(terminal)).toMatchObject({ status: "working", statusChangedAt: beforeExit.statusChangedAt, pid: null });
  expect((await post(terminal, { type: "agent-turn-complete" })).status).toBe(204);
  expect(row(terminal).status).toBe("working");
  expect(app.state.listEvents().filter(e => e.type === "terminal.status").map(e => (e.payload as {newStatus: string}).newStatus))
    .toEqual(["starting", "idle", "working", "idle", "working"]);
}, 12000);

for (const runtime of ["codex", "claude-code"] as const) {
  test(`${runtime} respawn returns to starting and exit keeps status; shells stay statusless`, async () => {
    const terminal = await open(runtime === "codex" ? "codex" : "claude", true);
    if (runtime === "codex") await eventually(() => row(terminal).status === "idle");
    else {
      await Bun.sleep(2600);
      expect(row(terminal).status).toBe("starting");
    }
    const payload = runtime === "codex" ? { type: "agent-turn-complete" } : { hook_event_name: "Stop" };
    expect((await post(terminal, payload, runtime)).status).toBe(204);
    const idle = row(terminal);
    process.kill(idle.pid!, "SIGKILL");
    await eventually(() => row(terminal).state === "restarting");
    expect(row(terminal)).toMatchObject({ status: "idle", statusChangedAt: idle.statusChangedAt });
    await eventually(() => row(terminal).restarts === 1);
    expect(row(terminal)).toMatchObject({ state: "running", status: "starting" });
    expect(app.state.listEvents().filter(e => e.type === "terminal.status").at(-1)?.payload)
      .toEqual({ terminal: terminal.id, oldStatus: "idle", newStatus: "starting" });
    const shell = await open("sleep 600", true, "shell");
    process.kill(shell.pid!, "SIGKILL");
    await eventually(() => row(shell).restarts === 1);
    expect(row(shell)).toMatchObject({ runtime: null, status: null, statusChangedAt: null });
  }, 10000);
}

test("a crashed Codex retains its last status across daemon restart", async () => {
  const terminal = await open("codex --exit", true);
  await eventually(() => row(terminal).state === "crashed", 8000);
  expect(row(terminal)).toMatchObject({ status: "starting", restarts: 5, pid: null });
  const before = row(terminal);
  await app.stop();
  app = await startServer(f.config, { backoffMs: [0] });
  expect(row(terminal)).toEqual(before);
}, 10000);

test("Codex API validates runtime, payload and loopback; unknown notifications are ignored", async () => {
  const terminal = await open();
  for (const payload of [{}, [], null, { type: 1 }]) {
    expect((await post(terminal, payload)).status).toBe(400);
  }
  expect((await post(terminal, { type: "future-event", extra: true })).status).toBe(204);
  expect(row(terminal).status).toBe("starting");
  expect((await post(terminal, { hook_event_name: "Stop" }, "claude-code")).status).toBe(409);
  const shell = await open("sleep 600", false, "shell");
  expect((await post(shell, { type: "agent-turn-complete" })).status).toBe(409);
  const route = createHooksRoute({ config: f.config, state: app.state, terminals: null! });
  for (const peer of [undefined, "192.0.2.1", "::ffff:192.0.2.1"]) {
    expect((await route(new Request(`${address}/v1/hooks/codex`, {
      method: "POST", headers: { "X-Forwarded-For": "127.0.0.1" },
      body: JSON.stringify({ terminal: terminal.id, payload: { type: "agent-turn-complete" } }),
    }), peer))?.status).toBe(403);
  }
  const payload = JSON.stringify({ type: "agent-turn-complete", extra: { raw: true } });
  expect(await cli([payload], { WSD_TERMINAL: terminal.id })).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(row(terminal).status).toBe("idle");
});

test("Codex hook is silent, always exits zero, never reads stdin and gives up within a second", async () => {
  const silent = { code: 0, stdout: "", stderr: "" };
  const payload = JSON.stringify({ type: "agent-turn-complete" });
  expect(await cli([payload], { WSD_TERMINAL: "" })).toEqual(silent);
  for (const args of [[], ["not JSON"], ["{}"], ["null"], [payload, payload]]) {
    expect(await cli(args, { WSD_TERMINAL: "unknown" })).toEqual(silent);
  }
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const port = String(stalled.port);
  try {
    const started = Date.now();
    expect(await cli([payload], { WSD_TERMINAL: "unknown", WSD_PORT: port })).toEqual(silent);
    expect(Date.now() - started).toBeLessThan(1300);
  } finally { await stalled.stop(true); }
  const started = Date.now();
  expect(await cli([payload], { WSD_TERMINAL: "unknown", WSD_PORT: port })).toEqual(silent);
  expect(Date.now() - started).toBeLessThan(1300);
});
