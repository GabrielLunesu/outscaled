import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Run } from "@outscaled/protocol";
import { Schedules } from "../src/schedules";
import { startServer } from "../src/server";
import { State } from "../src/state";
import { parseWorkspaceConfig, readWorkspaceConfig } from "../src/workspace-config";
import { fakeSsh } from "./ssh-helpers";
import { fixture, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let state: State;
let schedules: Schedules | undefined;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let now: number;
let folder: string;
let env: NodeJS.ProcessEnv;
let messages: string[];
const prompt = 'Reply "hi"\n$(touch escaped) `touch escaped` $HOME \' & ; 🚀';

function config(runtime = "script", every = "10m", name = "check"): string {
  return `[[agent]]\nname = "${name}"\nruntime = "${runtime}"\nmode = "scheduled"\nevery = "${every}"\n`
    + (runtime === "script" ? 'command = "fake-script"\n' : 'prompt = "prompt.md"\n');
}
function writeConfig(text = config()): void { writeFileSync(join(folder, ".ws/workspace.toml"), text); }
function options() { return { now: () => now, tickMs: 60_000, env, log: (message: string) => messages.push(message) }; }
async function start() { schedules = new Schedules(state, f.config.stateDir, options()); await schedules.start(); }
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}
async function finished(count = 1) {
  await eventually(() => state.listRuns().length === count && state.listRuns().every(run => run.status !== "running"));
}

beforeEach(() => {
  f = fixture();
  now = Date.parse("2026-01-01T00:00:00.000Z");
  messages = [];
  folder = join(f.root, "workspace with spaces");
  mkdirSync(join(folder, ".ws"), { recursive: true });
  writeFileSync(join(folder, ".ws/prompt.md"), prompt);
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  // A fake login shell records its flags and preserves the fixture's PATH,
  // independently of the user's real login files.
  const shell = join(bin, "login-shell");
  writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' "$@" > "$SHELL_ARGS"\nexec /bin/sh -c "$3"\n`, { mode: 0o755 });
  for (const name of ["claude", "codex", "fake-script"]) {
    writeFileSync(join(bin, name), `#!${process.execPath}
import {existsSync} from "node:fs";
const stdin = await Bun.stdin.text();
console.log(JSON.stringify({args: process.argv.slice(2), stdin, cwd: process.cwd()}));
console.error("stderr output");
if (process.env.NOISY) console.log("x".repeat(2 * 1024 * 1024));
while (process.env.BLOCK && !existsSync(process.env.BLOCK)) await Bun.sleep(10);
process.exit(Number(process.env.CODE || 0));
`, { mode: 0o755 });
  }
  env = { ...f.env, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, SHELL_ARGS: join(f.root, "shell-args") };
  state = new State(f.config.statePath);
  state.insertWorkspace({ ...workspace, path: folder, inPlace: true });
});
afterEach(async () => {
  await schedules?.stop(); schedules = undefined;
  if (app) { await app.stop(); app = undefined; }
  else state.close();
  f.cleanup();
});

test("TOML validates scheduled entries and ignores other modes and unknown keys", () => {
  const parsed = parseWorkspaceConfig(config("claude-code") + 'browser = "ads"\n' + config("codex", "1h", "other")
    + config("script", "2d", "script") + '\n[[agent]]\nname = "builder"\nmode = "always-on"\nruntime = "anything"\n'
    + '\n[[agent]]\nmode = "one-off"\n');
  expect(parsed.errors).toEqual([]);
  expect(parsed.agents.map(a => a.runtime)).toEqual(["claude-code", "codex", "script"]);
  expect(parsed.agents[0]).not.toHaveProperty("browser");
  expect(parseWorkspaceConfig(config().replace("fake-script", " fake-script ")).agents[0]).toMatchObject({ command: " fake-script " });
  for (const every of ["0m", "-1s", "1.5m", "10", "10ms", "1w", "999999999999999999d"]) {
    expect(parseWorkspaceConfig(config("script", every)).agents).toEqual([]);
  }
  for (const path of ["../outside", "prompts/../../outside", "/absolute", "."]) {
    expect(parseWorkspaceConfig(config("claude-code").replace("prompt.md", path)).agents).toEqual([]);
  }
  expect(parseWorkspaceConfig(config() + config()).agents).toEqual([]);
  expect(parseWorkspaceConfig(config() + config()).errors).toHaveLength(2);
  expect(parseWorkspaceConfig(config("invalid")).agents).toEqual([]);
  expect(parseWorkspaceConfig(config().replace('name = "check"', 'name = "Bad"')).agents).toEqual([]);
  expect(parseWorkspaceConfig("agent = 42").errors).toHaveLength(1);
  expect(parseWorkspaceConfig("agent = ???").errors).toHaveLength(1);
});

test("prompt symlinks cannot escape .ws and configuration is read only", async () => {
  writeFileSync(join(f.root, "outside.md"), "outside");
  symlinkSync(join(f.root, "outside.md"), join(folder, ".ws/escape.md"));
  writeConfig(config("claude-code").replace("prompt.md", "escape.md"));
  const before = readdirSync(join(folder, ".ws"));
  expect((await readWorkspaceConfig(folder)).agents).toEqual([]);
  expect((await readWorkspaceConfig(folder)).errors).toHaveLength(1);
  expect(readdirSync(join(folder, ".ws"))).toEqual(before);
});

test("10m first due is first-seen + interval; subsequent clocks start at each actual start with no backlog", async () => {
  writeConfig();
  await start();
  const firstSeen = now;
  now += 599_999;
  await schedules!.tick();
  expect(state.listRuns()).toEqual([]);
  now++;
  await schedules!.tick();
  await finished();
  expect(state.listRuns()[0]!.startedAt).toBe(new Date(firstSeen + 600_000).toISOString());
  now += 600_000 - 1;
  await schedules!.tick();
  expect(state.listRuns()).toHaveLength(1);
  now++;
  await schedules!.tick();
  await finished(2);
  now += 3_600_000;
  await schedules!.tick();
  await finished(3);
  await schedules!.tick();
  expect(state.listRuns()).toHaveLength(3);
  expect(state.listSchedules("demo")[0]!.nextDueAt).toBe(new Date(now + 600_000).toISOString());
});

test("overlapping runs skip once per due time and resume one interval later", async () => {
  env.BLOCK = join(f.root, "release");
  writeConfig();
  await start();
  now += 600_000;
  await schedules!.tick();
  expect(state.listRuns()[0]!.status).toBe("running");
  now += 600_000;
  await schedules!.tick();
  await schedules!.tick();
  expect(messages.filter(m => m.includes("skipping due run"))).toHaveLength(1);
  expect(state.listRuns()).toHaveLength(1);
  writeFileSync(env.BLOCK, "");
  await finished();
  now += 600_000;
  await schedules!.tick();
  await finished(2);
});

test("restart preserves first-seen and last-start clocks, runs overdue only once", async () => {
  writeConfig();
  await start();
  now += 300_000;
  await schedules!.stop(); state.close();
  state = new State(f.config.statePath);
  await start();
  now += 300_000;
  await schedules!.tick();
  await finished();
  const first = state.listRuns()[0]!;
  await schedules!.stop(); state.close();
  now += 600_000 * 10;
  state = new State(f.config.statePath);
  await start();
  await finished(2);
  await schedules!.tick();
  expect(state.listRuns()).toHaveLength(2);
  expect(state.listRuns()[1]!.id).toBe(first.id);
  expect(state.listSchedules("demo")[0]!.firstSeenAt).toBe(workspace.createdAt);
});

test("startup marks unfinished runs interrupted and records a finished event", async () => {
  state.startRun({ id: "unfinished", workspace: "demo", agent: "check", startedAt: workspace.createdAt,
    endedAt: null, exitCode: null, status: "running", logPath: join(f.root, "old.log") });
  now += 5000;
  await start();
  expect(state.getRun("unfinished")).toMatchObject({ status: "interrupted", exitCode: null, endedAt: new Date(now).toISOString() });
  expect(state.listEvents().find(e => e.type === "run.finished")!.payload).toMatchObject({ status: "interrupted", error: true });
});

for (const runtime of ["claude-code", "codex", "script"]) {
  test(`${runtime} uses login shell, argv data, /dev/null stdin, state log and run events`, async () => {
    writeConfig(config(runtime));
    if (runtime === "script") { env.CODE = "7"; env.NOISY = "1"; }
    await start();
    now += 600_000;
    await schedules!.tick();
    await finished();
    const row = Run.parse(state.listRuns()[0]);
    const code = runtime === "script" ? 7 : 0;
    expect(row).toMatchObject({ workspace: "demo", agent: "check", startedAt: new Date(now).toISOString(),
      endedAt: new Date(now).toISOString(), exitCode: code, status: code ? "failed" : "succeeded" });
    expect(row.logPath).toBe(join(f.config.stateDir, "logs/demo/check", `${row.id}.log`));
    const log = readFileSync(row.logPath, "utf8");
    const result = JSON.parse(log.split("\n")[0]!);
    expect(result).toEqual({ args: runtime === "script" ? [] : [runtime === "codex" ? "exec" : "-p", prompt], stdin: "", cwd: realpathSync(folder) });
    expect(log).toContain("stderr output");
    if (runtime === "script") expect(log.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(readFileSync(env.SHELL_ARGS!, "utf8").split("\n").slice(0, 2)).toEqual(["-l", "-c"]);
    expect(existsSync(join(folder, "escaped"))).toBe(false);
    expect(readdirSync(folder)).toEqual([".ws"]);
    const events = state.listEvents();
    expect(events.map(e => e.type).sort()).toEqual(["run.finished", "run.started"]);
    expect(events.find(e => e.type === "run.finished")!.payload).toMatchObject({ run: row.id, agent: "check", exitCode: code, error: code !== 0 });
  });
}

test("bad entries log once, do not block valid schedules or other workspaces, and can be fixed live", async () => {
  writeConfig(config("script", "bad", "bad") + config());
  const other = join(f.root, "other");
  mkdirSync(join(other, ".ws"), { recursive: true });
  writeFileSync(join(other, ".ws/workspace.toml"), "agent = ???");
  state.insertWorkspace({ ...workspace, slug: "other", path: other });
  await start();
  await schedules!.tick();
  expect(messages).toHaveLength(2);
  now += 600_000;
  await schedules!.tick(); await finished();
  expect(messages).toHaveLength(2);
  writeFileSync(join(other, ".ws/workspace.toml"), config("script", "1s", "fixed"));
  await schedules!.tick();
  now += 1000;
  await schedules!.tick(); await finished(2);
  expect(state.listRuns("other")[0]!.agent).toBe("fixed");
});

test("editing, adding and removing schedules take effect on ticks without restarting", async () => {
  await start();
  writeConfig();
  await schedules!.tick();
  now += 300_000;
  writeConfig(config("script", "5m").replace('command = "fake-script"', 'command = "fake-script changed"'));
  await schedules!.tick(); await finished();
  expect(JSON.parse(readFileSync(state.listRuns()[0]!.logPath, "utf8").split("\n")[0]!).args).toEqual(["changed"]);
  writeConfig("");
  await schedules!.tick();
  now += 3_600_000;
  await schedules!.tick();
  expect(state.listSchedules("demo")).toEqual([]);
  expect(state.listRuns()).toHaveLength(1);
  writeConfig();
  await schedules!.tick();
  expect(state.listSchedules("demo")[0]!.nextDueAt).toBe(new Date(now + 600_000).toISOString());
  rmSync(join(folder, ".ws/workspace.toml"));
  await schedules!.tick();
  expect(state.listSchedules("demo")).toEqual([]);
});

test("automatic polling discovers edits with an injected clock and tick interval; stop interrupts active runs", async () => {
  env.BLOCK = join(f.root, "never-release");
  schedules = new Schedules(state, f.config.stateDir, { ...options(), tickMs: 10 });
  await schedules.start();
  writeConfig(config("script", "1s"));
  await eventually(() => state.listSchedules("demo").length === 1);
  now += 1000;
  await eventually(() => state.listRuns().length === 1);
  await schedules.stop();
  expect(state.listRuns()[0]!.status).toBe("interrupted");
  now += 1000;
  await schedules.tick();
  expect(state.listRuns()).toHaveLength(1);
});

test("spawn failure is a failed run with a log and consumes its due time", async () => {
  env.SHELL = join(f.root, "missing-shell");
  writeConfig();
  await start();
  now += 600_000;
  await schedules!.tick();
  expect(state.listRuns()[0]!.status).toBe("failed");
  expect(readFileSync(state.listRuns()[0]!.logPath, "utf8")).toContain("run could not start");
  await schedules!.tick();
  expect(state.listRuns()).toHaveLength(1);
});

test("shutdown during a config read preserves all persisted schedule clocks", async () => {
  writeConfig(config() + config("script", "10m", "other"));
  await start();
  const before = state.listSchedules("demo");
  const reading = schedules!.tick();
  // Start the asynchronous file read, then stop while it is in flight.
  await Promise.resolve();
  await schedules!.stop();
  await reading;
  expect(state.listSchedules("demo")).toEqual(before);
});

test("run endpoints and CLI list/log work locally and through SSH", async () => {
  writeConfig();
  state.close();
  app = await startServer(f.config, undefined, options());
  state = app.state;
  now += 600_000;
  await app.schedules.tick(); await finished();
  now += 600_000;
  await app.schedules.tick(); await finished(2);
  const base = `http://127.0.0.1:${app.server.port}`;
  const rows = Run.array().parse(await (await fetch(`${base}/v1/workspaces/demo/runs`)).json());
  expect(rows[0]!.startedAt > rows[1]!.startedAt).toBe(true);
  const row = rows[0]!;
  const log = await fetch(`${base}/v1/runs/${row.id}/log`);
  expect(log.headers.get("content-type")).toContain("text/plain");
  const content = readFileSync(row.logPath, "utf8");
  expect(await log.text()).toBe(content);
  for (const path of ["/v1/workspaces/missing/runs", "/v1/runs/missing/log"]) {
    expect((await fetch(base + path)).status).toBe(404);
  }
  expect((await fetch(`${base}/v1/workspaces/Bad/runs`)).status).toBe(400);
  const ssh = fakeSsh(f.root);
  async function cli(args: string[], remote = false) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "run", ...args, ...(remote ? ["--on", "example-alias"] : [])], {
      env: { ...f.env, ...ssh.env, WSD_PORT: String(app!.server.port) }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }
  for (const remote of [false, true]) {
    expect(await cli(["ls", "demo", "--json"], remote)).toEqual({ code: 0, stdout: JSON.stringify(rows) + "\n", stderr: "" });
    const listed = await cli(["ls", "demo"], remote);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n")[0]).toBe([row.agent, row.status, row.startedAt, row.exitCode, row.id].join("\t"));
    expect(await cli(["log", row.id], remote)).toEqual({ code: 0, stdout: content, stderr: "" });
  }
  for (const args of [[], ["ls"], ["ls", "Bad"], ["log", "../bad"], ["log", row.id, "--json"], ["ls", "demo", "--unknown"]]) {
    expect((await cli(args)).code).toBe(1);
  }
  expect((await cli(["log", "missing"])).stderr).toContain("Run not found");
  rmSync(row.logPath);
  expect((await fetch(`${base}/v1/runs/${row.id}/log`)).status).toBe(404);
  for (const invocation of ssh.invocations()) ssh.assertClean(invocation);
}, 15000);
