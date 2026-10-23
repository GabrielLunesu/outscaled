import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Health, Terminal } from "@outscaled/protocol";
import { State } from "../src/state";
import { Tmux } from "../src/tmux";
import { fixture, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let tmux: Tmux;
let address: string;
let env: NodeJS.ProcessEnv;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let stdout: Promise<string>;
let stderr: Promise<string>;

beforeEach(async () => {
  f = fixture();
  mkdirSync(f.config.workspacesDir);
  const state = new State(f.config.statePath);
  try {
    state.insertWorkspace({ ...workspace, path: f.config.workspacesDir });
  } finally {
    state.close();
  }
  tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  address = `http://127.0.0.1:${port}/v1`;
  env = { ...f.env, WSD_PORT: String(port), SHELL: "/bin/bash", HOME: f.root };
});

afterEach(async () => {
  try {
    if (daemon) {
      daemon.kill("SIGKILL");
      await daemon.exited;
      daemon = undefined;
    }
  } finally {
    // Always specify the private socket, including when startup or assertions fail.
    Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { env });
    f.cleanup();
  }
});

async function start(): Promise<Health> {
  daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/wsd.ts")], {
    env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  stdout = new Response(daemon.stdout).text();
  stderr = new Response(daemon.stderr).text();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${await stderr}`);
    try {
      const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return Health.parse(await response.json());
    } catch { /* Wait for startup to finish and bind. */ }
    await Bun.sleep(25);
  }
  throw new Error("Timed out starting wsd");
}

async function stop(signal: "SIGKILL" | "SIGTERM" | "SIGINT") {
  const child = daemon!;
  if (signal === "SIGINT") {
    // A negative pid targets the isolated daemon's entire foreground group,
    // just as Ctrl-C would. It must never target the test runner's group.
    const group = Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "pgid="]);
    expect(Number(group.stdout.toString())).toBe(child.pid);
    process.kill(-child.pid, signal);
  } else {
    child.kill(signal);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 3000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
  daemon = undefined;
  expect(timedOut).toBe(false);
  expect(await stderr).toBe("");
  return stdout;
}

async function open() {
  const response = await fetch(`${address}/workspaces/demo/terminals`, {
    method: "POST", body: JSON.stringify({ name: "a1", command: "sleep 600" }),
  });
  expect(response.status).toBe(201);
  return Terminal.parse(await response.json());
}

async function list() {
  const response = await fetch(`${address}/workspaces/demo/terminals`);
  expect(response.status).toBe(200);
  return Terminal.array().parse(await response.json());
}

for (const signal of ["SIGKILL", "SIGTERM", "SIGINT"] as const) {
  test(`terminals survive ${signal}${signal === "SIGINT" ? " to wsd's process group" : ""} and are re-adopted`, async () => {
    await start();
    const terminal = await open();
    expect(terminal.pid).toBeGreaterThan(0);
    await stop(signal);
    expect(await tmux.hasSession(terminal.session)).toBe(true);
    expect(await tmux.listSessions()).toEqual([{ name: terminal.session, pid: terminal.pid! }]);
    // Health is the first request after restart: reconciliation cannot rely on listing.
    expect((await start()).terminals).toEqual({ total: 1, running: 1 });
    expect(await list()).toEqual([terminal]);
    expect((await fetch(`${address}/workspaces/demo/terminals`, {
      method: "POST", body: JSON.stringify({ name: "a1", command: "sleep 600" }),
    })).status).toBe(409);
  }, 15000);
}

test("a session killed while wsd is down is exited before health is served", async () => {
  await start();
  const terminal = await open();
  await stop("SIGKILL");
  await tmux.killSession(terminal.session);
  expect((await start()).terminals).toEqual({ total: 1, running: 0 });
  expect(await list()).toEqual([{ ...terminal, state: "exited", pid: null }]);
}, 15000);

test("startup restores a stale row and refreshes its current pane pid", async () => {
  await start();
  const terminal = await open();
  await stop("SIGKILL");
  const respawn = Bun.spawnSync([
    "tmux", "-S", f.env.WSD_TMUX_SOCKET, "respawn-pane", "-k", "-t", `=${terminal.session}:`, "sleep 600",
  ], { env });
  expect(respawn.exitCode).toBe(0);
  const [session] = await tmux.listSessions();
  expect(session!.pid).not.toBe(terminal.pid!);
  const state = new State(f.config.statePath);
  try {
    state.updateTerminalState(terminal.id, { state: "crashed", pid: null, restarts: 2 });
  } finally {
    state.close();
  }
  expect((await start()).terminals).toEqual({ total: 1, running: 1 });
  expect(await list()).toEqual([{ ...terminal, pid: session!.pid, restarts: 2 }]);
}, 15000);

test("unknown ws sessions are logged once and left untouched", async () => {
  const pid = await tmux.createSession("ws-unknown-a1", f.root, "/bin/bash", "sleep 600");
  const otherPid = await tmux.createSession("unrelated", f.root, "/bin/bash", "sleep 600");
  expect((await start()).terminals).toEqual({ total: 0, running: 0 });
  expect(await list()).toEqual([]);
  const output = await stop("SIGTERM");
  expect(output.split("\n").filter(line => line.includes("ws-unknown-a1")))
    .toEqual(["wsd: leaving untracked tmux session ws-unknown-a1 alone"]);
  expect(output).not.toContain("unrelated");
  expect(await tmux.listSessions()).toEqual([
    { name: "unrelated", pid: otherPid }, { name: "ws-unknown-a1", pid },
  ]);
}, 15000);
