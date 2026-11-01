import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@outscaled/protocol";
import { createHooksRoute } from "../src/routes/hooks";
import { startServer } from "../src/server";
import { shellQuote, terminalRuntime } from "../src/terminals";
import { Tmux } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let address: string;
let originalShell: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  f = fixture();
  // Exercise both settings-file quoting and PATH resolution by a login shell.
  f.config.stateDir = join(f.root, "state 'quoted'; $literal");
  f.config.statePath = join(f.config.stateDir, "state.db");
  originalShell = process.env.SHELL;
  originalHome = process.env.HOME;
  process.env.SHELL = "/bin/bash";
  process.env.HOME = f.root;
  mkdirSync(join(f.root, "bin"));
  writeFileSync(join(f.root, ".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
  app = await startServer(f.config);
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

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for hook");
}

async function cli(args: string[], env: NodeJS.ProcessEnv = {}, stdin = "{}") {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), ...args], {
    env: { ...f.env, WSD_PORT: String(app.server.port), ...env },
    stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("runtime detection uses only the first word's basename, including quoted paths", () => {
  for (const command of ["claude", " claude -p 'hello'", "/opt/bin/claude --resume", "'/opt/agent bin/claude' -p hello", '"/opt/agent bin/claude"', "/opt/agent\\ bin/claude"]) {
    expect(terminalRuntime(command)).toBe("claude-code");
  }
  expect(terminalRuntime("codex exec hello")).toBe("codex");
  expect(terminalRuntime("/opt/bin/codex")).toBe("codex");
  for (const command of ["/bin/bash", "env claude", "echo claude", "claude-other", "sleep 600", ""]) {
    expect(terminalRuntime(command)).toBeNull();
  }
});

test("fake claude records original arguments and session environment and executes the generated hook without PATH", async () => {
  const fake = join(f.root, "bin/claude");
  writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
await Bun.write("launch.json", JSON.stringify({args, terminal: process.env.WSD_TERMINAL, port: process.env.WSD_PORT}));
const settings = JSON.parse(await Bun.file(args[1]).text());
const command = settings.hooks.SessionStart[0].hooks[0].command;
const child = Bun.spawn(["/bin/sh", "-c", command], {
  env: {...process.env, PATH: "/usr/bin:/bin"}, stdin: new Blob([JSON.stringify({hook_event_name: "SessionStart"})]), stdout: "pipe", stderr: "pipe"
});
await Bun.write("hook-result.json", JSON.stringify({code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text()}));
await Bun.sleep(600000);
`, { mode: 0o755 });
  const command = "claude --model 'test model; $literal'";
  const opened = await fetch(`${address}/v1/workspaces/demo/terminals`, {
    method: "POST", body: JSON.stringify({ name: "c1", command, alwaysOn: true }),
  });
  expect(opened.status).toBe(201);
  const row = Terminal.parse(await opened.json());
  expect(row).toMatchObject({ command, runtime: "claude-code", status: "starting" });
  expect(row.statusChangedAt).toBeString();
  await eventually(() => Bun.file(join(f.root, "hook-result.json")).exists());
  const launch = JSON.parse(readFileSync(join(f.root, "launch.json"), "utf8"));
  expect(launch).toEqual({
    args: ["--settings", join(f.config.stateDir, "claude-settings.json"), "--model", "test model; $literal"],
    terminal: row.id, port: String(app.server.port),
  });
  expect(JSON.parse(readFileSync(join(f.root, "hook-result.json"), "utf8"))).toEqual({ code: 0, stdout: "", stderr: "" });
  const settings = JSON.parse(readFileSync(launch.args[1], "utf8"));
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Notification"]) {
    expect(settings.hooks[event][0].hooks[0].command).toContain(`${shellQuote("hook")} ${shellQuote("claude-code")}`);
  }
  expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt");
  expect(app.state.getTerminal(row.id)?.status).toBe("idle");
  expect(app.state.listEvents().filter(event => event.type === "terminal.status")).toHaveLength(2);
  const environment = Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "show-environment", "-t", row.session]).stdout.toString();
  expect(environment).toContain(`WSD_TERMINAL=${row.id}`);
  expect(environment).toContain(`WSD_PORT=${app.server.port}`);
  expect(readdirSync(f.root)).not.toContain(".claude");
  const listed = await cli(["term", "ls", "demo"]);
  expect(listed.stdout).toContain("c1\trunning\tidle\t");
  const json = await cli(["term", "ls", "demo", "--json"]);
  expect(Terminal.array().parse(JSON.parse(json.stdout))[0]).toMatchObject({ runtime: "claude-code", status: "idle" });
});

test("each hook changes status and time once, stores events atomically and ignores idle reminders", async () => {
  // Keep the fixture alive while CLI hooks run, even across supervisor polls.
  const pid = await new Tmux(f.config.tmuxSocket).createSession(terminal.session, f.root, "/bin/sh", "sleep 600");
  app.state.insertTerminal({ ...terminal, pid, runtime: "claude-code" });
  let previous: string | null = null;
  let changes = 0;
  let needsInput = 0;
  for (const [hook_event_name, notification_type, expected] of [
    ["SessionStart", undefined, "idle"],
    ["UserPromptSubmit", undefined, "working"],
    ["PreToolUse", undefined, "working"],
    ["PostToolUse", undefined, "working"],
    ["PermissionRequest", undefined, "needs_input"],
    ["Notification", "permission_prompt", "needs_input"],
    ["Notification", "idle_prompt", "needs_input"],
    ["Notification", "auth_success", "needs_input"],
    ["UnknownFutureEvent", undefined, "needs_input"],
    ["PostToolUse", undefined, "working"],
    ["Notification", "permission_prompt", "needs_input"],
    ["Stop", undefined, "idle"],
    ["Stop", undefined, "idle"],
    ["PreToolUse", undefined, "working"],
    ["Stop", undefined, "idle"],
  ] as const) {
    const before = app.state.getTerminal(terminal.id)!;
    const result = await cli(["hook", "claude-code"], { WSD_TERMINAL: terminal.id }, JSON.stringify({ hook_event_name, notification_type, extra: { raw: true } }));
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const current = app.state.getTerminal(terminal.id)!;
    expect(current.status).toBe(expected);
    if (expected !== previous) {
      changes++;
      if (expected === "needs_input") needsInput++;
      const events = app.state.listEvents().filter(event => event.type === "terminal.status");
      expect(events.some(event => JSON.stringify(event.payload) === JSON.stringify({ terminal: terminal.id, oldStatus: previous, newStatus: expected }) && event.time === current.statusChangedAt)).toBe(true);
    } else expect(current.statusChangedAt).toBe(before.statusChangedAt);
    expect(app.state.listEvents().filter(event => event.type === "terminal.status")).toHaveLength(changes);
    expect(app.state.listEvents().filter(event => event.type === "agent.needs_input")).toHaveLength(needsInput);
    previous = expected;
  }
  // If event persistence fails, the status update rolls back too.
  const before = app.state.getTerminal(terminal.id);
  app.state.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  expect(() => app.state.updateTerminalStatus(terminal.id, "working")).toThrow("test failure");
  expect(app.state.getTerminal(terminal.id)).toEqual(before);
});

test("hook API validates bodies, terminal ids and runtime and trusts only the socket peer", async () => {
  app.state.insertTerminal(terminal);
  const body = { terminal: terminal.id, payload: { hook_event_name: "Stop" } };
  for (const [runtime, value, expected] of [
    ["codex", body, 400], ["claude-code", body, 409],
    ["claude-code", { ...body, terminal: "unknown" }, 404],
    ["claude-code", {}, 400], ["claude-code", { ...body, terminal: 1 }, 400],
    ["claude-code", { ...body, payload: [] }, 400],
    ["claude-code", { ...body, payload: { hook_event_name: 1 } }, 400],
    ["claude-code", { ...body, payload: { hook_event_name: "Notification", notification_type: 1 } }, 400],
  ] as const) {
    expect((await fetch(`${address}/v1/hooks/${runtime}`, { method: "POST", body: JSON.stringify(value) })).status).toBe(expected);
  }
  expect((await fetch(`${address}/v1/hooks/claude-code`, { method: "POST", body: "{broken" })).status).toBe(400);
  const route = createHooksRoute({ config: f.config, state: app.state, terminals: null! });
  for (const peer of [undefined, "192.0.2.1", "::ffff:192.0.2.1"]) {
    const response = await route(new Request(`${address}/v1/hooks/claude-code`, {
      method: "POST", headers: { "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify(body),
    }), peer);
    expect(response?.status).toBe(403);
  }
  expect(app.state.listEvents()).toEqual([]);
});

test("hook CLI is silent and exits zero for missing env, bad input, unsupported runtime, and an unavailable or stalled daemon", async () => {
  const silent = { code: 0, stdout: "", stderr: "" };
  expect(await cli(["hook", "claude-code"], { WSD_TERMINAL: "" }, "not JSON")).toEqual(silent);
  for (const stdin of ["not JSON", "null", "{}", '{"hook_event_name":1}']) {
    expect(await cli(["hook", "claude-code"], { WSD_TERMINAL: "unknown" }, stdin)).toEqual(silent);
  }
  expect(await cli(["hook", "other-runtime"], { WSD_TERMINAL: "unknown" })).toEqual(silent);
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit" });
  try {
    const started = Date.now();
    expect(await cli(["hook", "claude-code"], { WSD_TERMINAL: "unknown", WSD_PORT: String(stalled.port) }, payload)).toEqual(silent);
    expect(Date.now() - started).toBeLessThan(1300);
  } finally { await stalled.stop(true); }
  const port = String(stalled.port);
  const started = Date.now();
  expect(await cli(["hook", "claude-code"], { WSD_TERMINAL: "unknown", WSD_PORT: port }, payload)).toEqual(silent);
  expect(Date.now() - started).toBeLessThan(1300);
});
