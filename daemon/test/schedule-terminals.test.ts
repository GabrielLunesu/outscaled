import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CreateScheduleRequest, Run, ScheduleSummary, UpdateScheduleRequest } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { Tmux } from "../src/tmux";
import { fixture, workspace } from "./helpers";
import { eventually } from "./terminal-io-helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let tmux: Tmux;
let folder: string;
let base: string;
let now: number;
let saved: NodeJS.ProcessEnv;
const options = () => ({ now: () => now, tickMs: 60_000 });
const input = (name = "agent", runtime = "claude-code", prompt = "hello") => ({ name, runtime, every: "1m", prompt });
async function request(method = "GET", path = "", body?: unknown) {
  return fetch(base + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(body = input()) {
  const response = await request("POST", "", body);
  expect(response.status).toBe(201);
  return ScheduleSummary.parse(await response.json());
}
async function run(name = "agent") {
  const response = await request("POST", `/${name}/run`);
  expect(response.status).toBe(201);
  const run = Run.parse(await response.json());
  if (run.status === "failed") throw new Error(readFileSync(run.logPath, "utf8"));
  return run;
}
async function done(id: string) { await eventually(() => app.state.getRun(id)?.status !== "running"); return app.state.getRun(id)!; }
async function rows() { return ScheduleSummary.array().parse(await (await request()).json()); }
async function output(name = "agent") { return tmux.captureOutput(`=ws-demo-${name}:`, Infinity); }
async function hook(id: string, event: string, runtime = "claude-code") {
  return fetch(`http://127.0.0.1:${app.server.port}/v1/hooks/${runtime}`, {
    method: "POST", body: JSON.stringify({ terminal: id, payload: runtime === "codex" ? { type: event } : { hook_event_name: event } }),
  });
}
async function restart() {
  await app.stop();
  app = await startServer(f.config, undefined, options());
  base = `http://127.0.0.1:${app.server.port}/v1/workspaces/demo/schedules`;
}

beforeEach(async () => {
  f = fixture();
  saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: process.env.PATH };
  process.env.HOME = f.root;
  process.env.SHELL = "/bin/bash";
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  // Login bash reads only this fixture's profile. No real CLI or home config.
  writeFileSync(join(f.root, ".bash_profile"), `export PATH='${bin}':"$PATH"\n`);
  for (const runtime of ["claude", "codex"]) writeFileSync(join(bin, runtime), `#!${process.execPath}
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
process.stdin.setRawMode(true);
process.stdin.resume();
async function hook(event) {
  if (${JSON.stringify(runtime)} === "claude") {
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
    const command = settings.hooks[event][0].hooks[0].command;
    const child = Bun.spawn(["/bin/sh", "-c", command], {stdin: new Blob([JSON.stringify({hook_event_name:event})]), stdout:"ignore", stderr:"inherit"});
    if (await child.exited !== 0) throw new Error("hook failed");
  } else if (event === "Stop") {
    const notify = JSON.parse(args[args.indexOf("-c") + 1].slice("notify=".length));
    const child = Bun.spawn([...notify, JSON.stringify({type:"agent-turn-complete"})], {stdout:"ignore", stderr:"inherit"});
    if (await child.exited !== 0) throw new Error("notify failed");
  }
}
console.log("SESSION " + process.env.WSD_TERMINAL);
console.log("PROMPT " + JSON.stringify(prompt));
await hook("SessionStart");
await hook("UserPromptSubmit");
if (prompt.includes("LONG")) for (let i = 0; i < (prompt.includes("BIG") ? 6100 : 700); i++) console.log("history-" + i);
console.log("RESULT " + prompt);
if (prompt.includes("DIE")) { await Bun.sleep(80); process.exit(7); }
if (prompt.includes("NEEDS_INPUT")) await hook("PermissionRequest");
if (!prompt.includes("WAIT") && !prompt.includes("NEEDS_INPUT")) {
  await Bun.sleep(60); await hook("Stop"); console.log("READY>");
}
process.stdin.on("data", async chunk => {
  if (chunk.toString().includes("f")) { console.log("ANSWERED"); await Bun.sleep(30); await hook("Stop"); console.log("READY>"); }
});
`, { mode: 0o755 });
  folder = join(f.root, "workspace");
  mkdirSync(join(folder, ".ws"), { recursive: true });
  now = Date.parse("2026-01-01T00:00:00Z");
  app = await startServer(f.config, undefined, options());
  app.state.insertWorkspace({ ...workspace, path: folder });
  tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
  base = `http://127.0.0.1:${app.server.port}/v1/workspaces/demo/schedules`;
});
afterEach(async () => {
  await app?.stop();
  Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]);
  for (const key of ["HOME", "SHELL", "PATH"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  f.cleanup();
});

for (const runtime of ["claude-code", "codex"]) test(`${runtime}: interactive hooks finish runs, retain results, capture history and clear the next session`, async () => {
  const prompt = 'LONG quotes: "hello" \' $(touch pwned) `touch pwned`\nsecond line 🚀';
  const created = await create(input("agent", runtime, prompt));
  expect(created).toMatchObject({ source: "app", readOnly: false, prompt, paused: false, lastRun: null,
    nextRunAt: new Date(now + 60_000).toISOString() });
  const first = await run();
  expect(first.status).toBe("running");
  expect((await done(first.id)).status).toBe("succeeded");
  const terminal = app.state.listTerminals("demo")[0]!;
  expect(terminal).toMatchObject({ name: "agent", runtime, status: "idle", state: "running", alwaysOn: false });
  expect(terminal.command).not.toContain(" exec ");
  const log = readFileSync(first.logPath, "utf8");
  expect(log).toContain("PROMPT " + JSON.stringify(prompt));
  expect(log).toContain("history-0");
  expect(log).toContain("history-699");
  expect(log).toContain('$(touch pwned) `touch pwned`');
  expect(log).toContain("second line 🚀");
  expect(existsSync(join(folder, "pwned"))).toBe(false);
  await eventually(async () => (await output()).includes("READY>"));
  expect((await rows())[0]!.lastRun).toMatchObject({ id: first.id, status: "succeeded", result: `SESSION ${terminal.id}` });
  expect((await request("PATCH", "/agent", { prompt: "SECOND" })).status).toBe(200);
  const second = await run();
  await done(second.id);
  expect((await output())).toContain("SECOND");
  expect((await output())).not.toContain("history-0");
  expect((await output())).not.toContain(terminal.id);
  expect(readFileSync(first.logPath, "utf8")).toBe(log);
  expect(app.state.listTerminals()).toHaveLength(1);
  expect(app.state.listTerminals()[0]!.id).not.toBe(terminal.id);
  expect((await hook(terminal.id, runtime === "codex" ? "agent-turn-complete" : "Stop", runtime)).status).toBe(404);
  expect(app.state.listEvents().filter(e => e.type === "run.started")).toHaveLength(2);
  expect(app.state.listEvents().filter(e => e.type === "run.finished")).toHaveLength(2);
  const focus = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "show-options", "-s", "focus-events"]);
  expect(focus.stdout.toString()).toBe("focus-events on\n");
  expect(readdirSync(folder)).toEqual([".ws"]);
});

test("needs_input waits, duplicate/manual and due overlaps are refused/skipped, answering completes once", async () => {
  await create(input("agent", "claude-code", "NEEDS_INPUT"));
  const first = await run();
  await eventually(() => app.state.listTerminals()[0]?.status === "needs_input");
  expect(app.state.getRun(first.id)?.status).toBe("running");
  expect((await request("POST", "/agent/run")).status).toBe(409);
  now += 60_000;
  await app.schedules.tick();
  await app.schedules.tick();
  expect(app.state.listRuns()).toHaveLength(1);
  expect((await rows())[0]!.nextRunAt).toBe(new Date(now + 60_000).toISOString());
  await tmux.sendKeys("=ws-demo-agent:", ["f"]);
  expect((await done(first.id)).status).toBe("succeeded");
  expect(readFileSync(first.logPath, "utf8")).toContain("ANSWERED");
  await hook(app.state.listTerminals()[0]!.id, "Stop");
  expect(app.state.listEvents().filter(e => e.type === "run.finished")).toHaveLength(1);
});

test("a process dying during a run fails it and captures output in its retained dead pane", async () => {
  await create(input("agent", "codex", "DIE"));
  const first = await run();
  await eventually(async () => (await tmux.listPanes())[0]?.dead === true);
  await app.schedules.tick();
  expect(app.state.getRun(first.id)).toMatchObject({ status: "failed", exitCode: 7 });
  expect(readFileSync(first.logPath, "utf8")).toContain("RESULT DIE");
  expect((await request("PATCH", "/agent", { prompt: "recovered" })).status).toBe(200);
  expect((await done((await run()).id)).status).toBe("succeeded");
});

test("all schedule routes validate names/bodies, distinguish 404 and 409, and serialize duplicate creates", async () => {
  for (const body of [input("Bad"), input("a", "script"), { ...input(), every: "0m" }, { ...input(), every: "999999999999999d" },
    { ...input(), prompt: "" }, { ...input(), prompt: "nul\0" }, { ...input(), extra: 1 }]) {
    expect((await request("POST", "", body)).status).toBe(400);
    expect(CreateScheduleRequest.safeParse(body).success).toBe(false);
  }
  const simultaneous = await Promise.all([request("POST", "", input()), request("POST", "", input())]);
  expect(simultaneous.map(r => r.status).sort()).toEqual([201, 409]);
  for (const body of [{}, { every: "1.5m" }, { prompt: "\0" }, { name: "other" }, { runtime: "codex" }]) {
    expect((await request("PATCH", "/agent", body)).status).toBe(400);
    expect(UpdateScheduleRequest.safeParse(body).success).toBe(false);
  }
  const patched = await request("PATCH", "/agent", { every: "2m", prompt: "updated" });
  expect(patched.status).toBe(200);
  expect(ScheduleSummary.parse(await patched.json())).toMatchObject({ every: "2m", prompt: "updated" });
  for (const [method, suffix, body] of [["GET", "", undefined], ["POST", "", input()], ["PATCH", "/agent", { prompt: "x" }],
    ["DELETE", "/agent", undefined], ["POST", "/agent/run", undefined], ["POST", "/agent/pause", undefined], ["POST", "/agent/resume", undefined]] as const) {
    const url = base.replace("/demo/", "/missing/") + suffix;
    expect((await fetch(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).status).toBe(404);
    expect((await fetch(url.replace("/missing/", "/Bad/"), { method, ...(body ? { body: JSON.stringify(body) } : {}) })).status).toBe(400);
  }
  for (const [method, suffix, body] of [["PATCH", "", { prompt: "x" }], ["DELETE", "", undefined],
    ["POST", "/run", undefined], ["POST", "/pause", undefined], ["POST", "/resume", undefined]] as const) {
    expect((await request(method, `/missing${suffix}`, body)).status).toBe(404);
    expect((await request(method, `/Bad${suffix}`, body)).status).toBe(400);
  }
  expect((await request("DELETE", "/agent")).status).toBe(204);
  expect(await rows()).toEqual([]);
});

test("workspace schedules list prompt contents, remain read-only, reserve other-mode names, and pause persists for both sources", async () => {
  const toml = '[[agent]]\nname="from-file"\nruntime="claude-code"\nmode="scheduled"\nevery="1m"\nprompt="prompt.md"\n'
    + '[[agent]]\nname="always"\nmode="always-on"\n';
  writeFileSync(join(folder, ".ws/workspace.toml"), toml);
  writeFileSync(join(folder, ".ws/prompt.md"), "file prompt");
  expect((await rows())[0]).toMatchObject({ name: "from-file", source: "workspace", readOnly: true, prompt: "file prompt" });
  expect((await request("PATCH", "/from-file", { every: "2m" })).status).toBe(409);
  expect((await request("DELETE", "/from-file")).status).toBe(409);
  for (const name of ["from-file", "always"]) expect((await request("POST", "", input(name))).status).toBe(409);
  await create();
  for (const name of ["from-file", "agent"]) {
    expect((await request("POST", `/${name}/pause`)).status).toBe(200);
    expect((await rows()).find(s => s.name === name)).toMatchObject({ paused: true, nextRunAt: null });
  }
  now += 3_600_000;
  await restart();
  await app.schedules.tick();
  expect((await rows()).every(s => s.paused)).toBe(true);
  expect(app.state.listRuns()).toEqual([]);
  // Run Now is allowed while paused and preserves that setting.
  expect((await done((await run("from-file")).id)).status).toBe("succeeded");
  expect((await rows()).find(s => s.name === "from-file")!.paused).toBe(true);
  for (const name of ["from-file", "agent"]) {
    const resumed = await request("POST", `/${name}/resume`);
    expect(resumed.status).toBe(200);
    expect(ScheduleSummary.parse(await resumed.json())).toMatchObject({ paused: false, nextRunAt: new Date(now + 60_000).toISOString() });
  }
  now += 60_000;
  await app.schedules.tick();
  await eventually(() => app.state.listRuns().length === 3 && app.state.listRuns().every(r => r.status === "succeeded"));
  expect(readFileSync(join(folder, ".ws/workspace.toml"), "utf8")).toBe(toml);
});

test("deleting an active schedule leaves its terminal/run alive and retains its log and history", async () => {
  await create(input("agent", "claude-code", "WAIT"));
  const first = await run();
  await eventually(async () => (await output()).includes("RESULT WAIT"));
  expect((await request("DELETE", "/agent")).status).toBe(204);
  now += 60_000;
  await app.schedules.tick();
  expect(app.state.getRun(first.id)?.status).toBe("running");
  await tmux.sendKeys("=ws-demo-agent:", ["f"]);
  expect((await done(first.id)).status).toBe("succeeded");
  expect(readFileSync(first.logPath, "utf8")).toContain("ANSWERED");
  expect(await rows()).toEqual([]);
  expect(app.state.listTerminals()[0]?.state).toBe("running");
});

test("schedule and terminal names cannot take over each other's panes", async () => {
  const terminals = base.replace("schedules", "terminals");
  expect((await fetch(terminals, { method: "POST", body: JSON.stringify({ name: "shell" }) })).status).toBe(201);
  expect((await request("POST", "", input("shell"))).status).toBe(409);
  await create();
  expect((await fetch(terminals, { method: "POST", body: JSON.stringify({ name: "agent" }) })).status).toBe(409);
  const concurrent = await Promise.all([
    fetch(terminals, { method: "POST", body: JSON.stringify({ name: "racing" }) }),
    request("POST", "", input("racing")),
  ]);
  expect(concurrent.map(response => response.status).sort()).toEqual([201, 409]);
});


test("run logs include scrollback beyond the terminal API's 5000-line limit", async () => {
  await tmux.createSession("history-keeper", folder, "/bin/sh", "sleep 600");
  const configure = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "set-option", "-g", "history-limit", "7000"]);
  expect(configure.exitCode).toBe(0);
  await create(input("agent", "codex", "BIG LONG"));
  const first = await run();
  await done(first.id);
  const log = readFileSync(first.logPath, "utf8");
  expect(log).toContain("history-0\n");
  expect(log).toContain("history-6099");
  const limited = await fetch(base.replace("schedules", "terminals/agent/output?lines=5000"));
  expect(limited.status).toBe(200);
  expect((await limited.json() as { text: string }).text).not.toContain("history-0\n");
});

test("shutdown saves active terminal output as interrupted and a restart reuses the pane for a fresh run", async () => {
  await create(input("agent", "claude-code", "WAIT"));
  const first = await run();
  await eventually(async () => (await output()).includes("RESULT WAIT"));
  const pane = (await tmux.listPanes())[0]!;
  await restart();
  expect(app.state.getRun(first.id)?.status).toBe("interrupted");
  expect(readFileSync(first.logPath, "utf8")).toContain("RESULT WAIT");
  expect((await tmux.listPanes())[0]).toMatchObject({ pane: pane.pane, pid: pane.pid, dead: false });
  expect((await request("PATCH", "/agent", { prompt: "fresh after restart" })).status).toBe(200);
  const second = await run();
  expect((await done(second.id)).status).toBe("succeeded");
  expect((await tmux.listPanes())[0]?.pane).toBe(pane.pane);
  expect(await output()).not.toContain("RESULT WAIT");
});
