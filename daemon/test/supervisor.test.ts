import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@outscaled/protocol";
import { startServer } from "../src/server";
import type { SupervisorOptions } from "../src/supervisor";
import { Tmux } from "../src/tmux";
import { fixture, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let tmux: Tmux;
let folder: string;
let originalShell: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  f = fixture();
  originalShell = process.env.SHELL;
  originalHome = process.env.HOME;
  process.env.SHELL = "/bin/bash";
  process.env.HOME = f.root;
  folder = join(realpathSync(f.root), "workspace with 'quotes'");
  mkdirSync(folder);
  tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  if (f) {
    Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { env: f.env });
    f.cleanup();
  }
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function start(options?: SupervisorOptions) {
  app = await startServer(f.config, options);
  if (!app.state.getWorkspace("demo")) app.state.insertWorkspace({ ...workspace, path: folder });
}

async function stop() {
  await app!.stop();
  app = undefined;
}

async function open(command = "sleep 600", alwaysOn = true, name = "a1") {
  const response = await fetch(`http://127.0.0.1:${app!.server.port}/v1/workspaces/demo/terminals`, {
    method: "POST", body: JSON.stringify({ name, command, alwaysOn }),
  });
  expect(response.status).toBe(201);
  return Terminal.parse(await response.json());
}

async function list() {
  const response = await fetch(`http://127.0.0.1:${app!.server.port}/v1/workspaces/demo/terminals`);
  expect(response.status).toBe(200);
  return Terminal.array().parse(await response.json());
}

async function eventually(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for supervisor");
}

async function restarted(terminal: Terminal, restarts: number, timeout = 5000) {
  await eventually(() => {
    const row = app!.state.getTerminal(terminal.id)!;
    return row.state === "running" && row.restarts === restarts && row.pid !== terminal.pid;
  }, timeout);
  return app!.state.getTerminal(terminal.id)!;
}

test("SIGKILL restarts within five seconds in the same pane, folder and attached session", async () => {
  await start();
  const terminal = await open();
  const [before] = await tmux.listPanes();
  // A control-mode client exercises attachment without depending on a real TTY.
  const client = Bun.spawn(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "-C", "attach-session", "-t", `=${terminal.session}`], {
    env: f.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(client.stdout).text();
  const errors = new Response(client.stderr).text();
  try {
    await eventually(async () => {
      const result = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "list-clients", "-F", "#{session_name}"], { env: f.env });
      return result.stdout.toString().trim() === terminal.session;
    });
    const killedAt = Date.now();
    process.kill(terminal.pid!, "SIGKILL");
    await eventually(() => app!.state.getTerminal(terminal.id)!.state === "restarting");
    expect((await list())[0]!.state).toBe("restarting");
    const next = await restarted(terminal, 1, 5000 - (Date.now() - killedAt));
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - killedAt).toBeLessThan(5000);
    expect((await list())[0]).toEqual(next);
    const [after] = await tmux.listPanes();
    expect(after).toMatchObject({ pane: before!.pane, name: before!.name, pid: next.pid, dead: false });
    const cwd = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "display-message", "-p", "-t", after!.pane, "#{pane_current_path}"], { env: f.env });
    expect(cwd.stdout.toString().trim()).toBe(folder);
    expect(client.exitCode).toBeNull();
  } finally {
    client.stdin.write("detach-client\n");
    client.stdin.end();
    await client.exited;
    await output;
    expect(await errors).toBe("");
  }
}, 10000);

test("one-off terminals are not retained or restarted", async () => {
  await start({ backoffMs: [0] });
  await open("sleep 600", true, "keeper");
  const terminal = await open("sleep 600", false);
  process.kill(terminal.pid!, "SIGKILL");
  await eventually(async () => !(await tmux.hasSession(terminal.session)));
  await Bun.sleep(1200);
  expect((await list()).find(t => t.id === terminal.id)).toMatchObject({ state: "exited", pid: null, restarts: 0 });
  expect(app!.state.listEvents()).toEqual([]);
});

test("five failed restarts crash exactly once, even after re-adoption", async () => {
  const delays = [0, 500, 1000, 1500];
  await start({ backoffMs: delays, healthyUptimeMs: 10_000 });
  const terminal = await open("/bin/sh -c 'exit 23'");
  const attempts: number[] = [];
  await eventually(() => {
    const row = app!.state.getTerminal(terminal.id)!;
    if (row.restarts > attempts.length) attempts.push(Date.now());
    return row.state === "crashed";
  }, 11000);
  expect(attempts).toHaveLength(5);
  for (let i = 1; i < attempts.length; i++) {
    // Allow for observation jitter while verifying escalation and the cap.
    const delay = delays[Math.min(i, delays.length - 1)]!;
    expect(attempts[i]! - attempts[i - 1]!).toBeGreaterThanOrEqual(delay);
    expect(attempts[i]! - attempts[i - 1]!).toBeLessThan(delay + 1300);
  }
  expect(app!.state.getTerminal(terminal.id)).toMatchObject({ state: "crashed", restarts: 5, pid: null });
  const events = app!.state.listEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "agent.crashed", terminal: terminal.id, workspace: "demo", payload: { exitStatus: 23, exitSignal: null } });
  await stop();
  await start({ backoffMs: [0] });
  await Bun.sleep(1200);
  expect((await list())[0]).toMatchObject({ state: "crashed", restarts: 5, pid: null });
  expect(app!.state.listEvents()).toEqual(events);
  expect((await tmux.listPanes())[0]!.dead).toBe(true);
}, 15000);

test("healthy uptime resets both backoff and the consecutive failure count", async () => {
  const options = { backoffMs: [0, 1500, 2000, 2500], healthyUptimeMs: 1500 };
  await start(options);
  // The same command can be made short-lived after a healthy restart.
  writeFileSync(join(folder, "worker.sh"), "#!/bin/sh\nif [ -f fail ]; then exit 17; fi\nexec sleep 600\n");
  let terminal = await open("/bin/sh ./worker.sh");
  process.kill(terminal.pid!, "SIGKILL");
  terminal = await restarted(terminal, 1);
  process.kill(terminal.pid!, "SIGKILL");
  await eventually(() => app!.state.getTerminal(terminal.id)!.state === "restarting");
  const waitingAt = Date.now();
  terminal = await restarted(terminal, 2);
  expect(Date.now() - waitingAt).toBeGreaterThanOrEqual(1400);
  await Bun.sleep(2100);
  writeFileSync(join(folder, "fail"), "");
  const killedAt = Date.now();
  process.kill(terminal.pid!, "SIGKILL");
  await eventually(() => app!.state.getTerminal(terminal.id)!.restarts === 3, 1400);
  expect(Date.now() - killedAt).toBeLessThan(1400);
  // There was one failure before the healthy run; it must no longer count.
  await eventually(() => app!.state.getTerminal(terminal.id)!.state === "crashed", 16000);
  expect(app!.state.getTerminal(terminal.id)!.restarts).toBe(7);
  expect(app!.state.listEvents()).toHaveLength(1);
}, 25000);

for (const dieWhileDown of [false, true]) {
  test(`re-adopted always-on terminals are supervised (${dieWhileDown ? "dead" : "live"} pane)`, async () => {
    await start();
    let terminal = await open();
    if (!dieWhileDown) {
      process.kill(terminal.pid!, "SIGKILL");
      terminal = await restarted(terminal, 1);
    }
    const [pane] = await tmux.listPanes();
    await stop();
    if (dieWhileDown) {
      process.kill(terminal.pid!, "SIGKILL");
      await eventually(async () => (await tmux.listPanes())[0]!.dead);
    }
    await start();
    if (!dieWhileDown) process.kill(terminal.pid!, "SIGKILL");
    const next = await restarted(terminal, terminal.restarts + 1);
    expect((await tmux.listPanes())[0]).toMatchObject({ pane: pane!.pane, pid: next.pid, dead: false });
  }, 10000);
}

test("shutdown cancels a pending restart and leaves the retained session alone", async () => {
  await start({ backoffMs: [1000] });
  const terminal = await open();
  const [before] = await tmux.listPanes();
  process.kill(terminal.pid!, "SIGKILL");
  await eventually(() => app!.state.getTerminal(terminal.id)!.state === "restarting");
  expect(app!.state.getTerminal(terminal.id)!.restarts).toBe(0);
  await stop();
  await Bun.sleep(1600);
  expect(await tmux.hasSession(terminal.session)).toBe(true);
  expect(await tmux.listPanes()).toEqual([
    expect.objectContaining({ name: terminal.session, pane: before!.pane, dead: true }),
  ]);
});
