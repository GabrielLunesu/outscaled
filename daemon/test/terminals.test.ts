import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, Terminal } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { Tmux } from "../src/tmux";
import { fixture, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let tmux: Tmux;
let base: string;
let folder: string;
let originalShell: string | undefined;
let originalHome: string | undefined;

function rawTmux(...args: string[]) {
  // Never let a test fall back to the user's tmux server.
  return Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, ...args], { env: f.env });
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for terminal process");
}

beforeEach(async () => {
  f = fixture();
  originalShell = process.env.SHELL;
  originalHome = process.env.HOME;
  process.env.SHELL = "/bin/bash";
  process.env.HOME = f.root;
  folder = join(realpathSync(f.root), "workspace with 'quotes'");
  mkdirSync(folder);
  app = await startServer(f.config);
  app.state.insertWorkspace({ ...workspace, path: folder });
  tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
  base = `http://127.0.0.1:${app.server.port}/v1/workspaces`;
});

afterEach(async () => {
  await app?.stop();
  if (f) {
    rawTmux("kill-server");
    f.cleanup();
  }
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function open(body: unknown, slug = "demo") {
  return fetch(`${base}/${slug}/terminals`, { method: "POST", body: JSON.stringify(body) });
}

async function list(slug = "demo") {
  const response = await fetch(`${base}/${slug}/terminals`);
  expect(response.status).toBe(200);
  return Terminal.array().parse(await response.json());
}

test("open creates the named session in the workspace with the command's pid", async () => {
  const response = await open({ name: "a1", command: "sleep 600", alwaysOn: true });
  expect(response.status).toBe(201);
  const terminal = Terminal.parse(await response.json());
  expect(terminal).toMatchObject({ name: "a1", workspace: "demo", session: "ws-demo-a1", command: "sleep 600", state: "running", alwaysOn: true });
  expect(rawTmux("display-message", "-p", "-t", "=ws-demo-a1:", "#{pane_current_path}").stdout.toString().trim()).toBe(folder);
  expect(Number(rawTmux("display-message", "-p", "-t", "=ws-demo-a1:", "#{pane_pid}").stdout.toString())).toBe(terminal.pid!);
  await eventually(async () => Bun.spawnSync(["ps", "-p", String(terminal.pid), "-o", "comm="]).stdout.toString().trim().endsWith("sleep"));
  expect(await tmux.listSessions()).toEqual([{ name: terminal.session, pid: terminal.pid! }]);
  expect(await list()).toEqual([terminal]);
});

test("an omitted command opens and stores the login shell", async () => {
  const response = await open({ name: "shell" });
  expect(response.status).toBe(201);
  const terminal = Terminal.parse(await response.json());
  expect(terminal.command).toBe("/bin/bash");
  expect(terminal.alwaysOn).toBe(false);
  expect(await tmux.hasSession(terminal.session)).toBe(true);
  await eventually(async () => Bun.spawnSync(["ps", "-p", String(terminal.pid), "-o", "args="]).stdout.toString().includes("/bin/bash -l"));
});

test("commands resolve PATH from the login shell and preserve quoting", async () => {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "terminal-test-command"), "#!/bin/sh\nprintf '%s' \"$1\" > result.txt\nexec sleep 600\n", { mode: 0o755 });
  writeFileSync(join(f.root, ".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
  const command = "terminal-test-command 'a quoted value; $literal'";
  const response = await open({ name: "path", command });
  expect(response.status).toBe(201);
  const terminal = Terminal.parse(await response.json());
  expect(terminal.command).toBe(command);
  await eventually(() => Bun.file(join(folder, "result.txt")).exists());
  expect(await Bun.file(join(folder, "result.txt")).text()).toBe("a quoted value; $literal");
  await eventually(async () => Bun.spawnSync(["ps", "-p", String(terminal.pid), "-o", "comm="]).stdout.toString().trim().endsWith("sleep"));
});

test("live names conflict, including simultaneous opens and exact session matching", async () => {
  expect((await open({ name: "a10", command: "sleep 600" })).status).toBe(201);
  const responses = await Promise.all([open({ name: "a1", command: "sleep 600" }), open({ name: "a1", command: "sleep 600" })]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  const conflict = responses.find(response => response.status === 409)!;
  expect(ApiError.parse(await conflict.json()).error.code).toBe("conflict");
  expect(await list()).toHaveLength(2);
});

test("unknown workspaces return 404 without starting tmux", async () => {
  expect((await open({ name: "a1" }, "missing")).status).toBe(404);
  expect((await fetch(`${base}/missing/terminals`)).status).toBe(404);
  expect(await tmux.listSessions()).toEqual([]);
});

test("exited commands are reconciled and a stored name can be replaced", async () => {
  // Keep the server alive while the short-lived command exits.
  await open({ name: "keeper", command: "sleep 600" });
  const response = await open({ name: "short", command: "true" });
  expect(response.status).toBe(201);
  const previous = Terminal.parse(await response.json());
  await eventually(async () => !(await tmux.hasSession(previous.session)));
  expect((await list()).find(terminal => terminal.name === "short")).toMatchObject({ state: "exited", pid: null });
  expect(app.state.getTerminal(previous.id)?.state).toBe("exited");
  const replacement = await open({ name: "short", command: "sleep 600" });
  expect(replacement.status).toBe(201);
  const next = Terminal.parse(await replacement.json());
  expect(next.id).not.toBe(previous.id);
  expect(next.state).toBe("running");
  expect(app.state.getTerminal(previous.id)).toBeNull();
  expect(await list()).toHaveLength(2);
});

test("a dead session can be replaced without listing first, and the final server exit is handled", async () => {
  const previous = Terminal.parse(await (await open({ name: "a1", command: "sleep 600" })).json());
  await tmux.killSession(previous.session);
  await eventually(async () => !(await tmux.hasSession(previous.session)));
  const response = await open({ name: "a1", command: "sleep 600" });
  expect(response.status).toBe(201);
  await tmux.killSession(previous.session);
  expect((await list())[0]).toMatchObject({ state: "exited", pid: null });
});

test("listing only reconciles terminals in the requested workspace", async () => {
  const other = join(f.root, "other");
  mkdirSync(other);
  app.state.insertWorkspace({ ...workspace, slug: "other", path: other });
  const response = await open({ name: "a1", command: "sleep 600" }, "other");
  const terminal = Terminal.parse(await response.json());
  await tmux.killSession(terminal.session);
  expect(await list()).toEqual([]);
  expect(app.state.getTerminal(terminal.id)?.state).toBe("running");
  expect((await list("other"))[0]?.state).toBe("exited");
});

test("CLI opens and lists terminals against the running daemon", async () => {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/ws.ts", "term", ...args], {
      cwd: join(import.meta.dir, ".."), env: { ...f.env, WSD_PORT: String(app.server.port) }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  expect(await cli("open", "demo", "--name", "a1", "--cmd", "sleep 600", "--always-on", "--on", "local"))
    .toEqual({ code: 0, stdout: "ws-demo-a1\nAttach: tmux attach -t ws-demo-a1\n", stderr: "" });
  expect(await tmux.hasSession("ws-demo-a1")).toBe(true);
  expect(await cli("ls", "demo", "--on", "local"))
    .toEqual({ code: 0, stdout: "a1\trunning\tws-demo-a1\tsleep 600\n", stderr: "" });
  const listed = await cli("ls", "demo", "--json");
  expect(listed.code).toBe(0);
  expect(Terminal.array().parse(JSON.parse(listed.stdout))[0]).toMatchObject({ name: "a1", alwaysOn: true });
  const opened = await cli("open", "demo", "--name", "a2", "--json");
  expect(opened.code).toBe(0);
  expect(Terminal.parse(JSON.parse(opened.stdout))).toMatchObject({ name: "a2", command: "/bin/bash" });
  expect((await cli("open", "demo", "--name", "a1")).code).toBe(1);
  expect((await cli("ls", "missing")).stderr).toContain("Workspace not found");
  for (const args of [["open", "demo"], ["ls"], ["ls", "demo", "extra"], ["open", "../bad", "--name", "a"], ["ls", "demo", "--cmd", "sleep 600"]]) {
    expect((await cli(...args)).code).toBe(1);
  }
});
