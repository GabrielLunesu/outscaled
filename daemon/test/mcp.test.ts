import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ioFixture } from "./terminal-io-helpers";
import { fakeSsh } from "./ssh-helpers";

let f: Awaited<ReturnType<typeof ioFixture>>;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let reading: Promise<void>;
let stderr: Promise<string>;
let messages: any[];
let pending: Map<number, (message: any) => void>;
let id: number;

beforeEach(async () => {
  f = await ioFixture();
  startMcp();
});

function startMcp(on = "local", env: NodeJS.ProcessEnv = {}) {
  messages = []; pending = new Map(); id = 0;
  child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "mcp", "--on", on], {
    env: { ...f.env, WSD_PORT: String(f.app.server.port), ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  stderr = new Response(child.stderr).text();
  reading = (async () => {
    // Every stdout line must parse as a JSON-RPC protocol message.
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child!.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        expect(message.jsonrpc).toBe("2.0");
        messages.push(message);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
    expect(buffer).toBe("");
  })();
}

afterEach(async () => {
  try {
    child?.stdin.end();
    const exited = await Promise.race([child?.exited, Bun.sleep(2000).then(() => "timeout")]);
    if (exited === "timeout") child?.kill();
    await child?.exited;
    await reading;
    expect(await stderr).toBe("");
  } finally {
    await f?.cleanup();
    child = undefined;
  }
});

async function request(method: string, params: unknown = {}) {
  const requestId = ++id;
  const response = new Promise<any>(resolve => pending.set(requestId, resolve));
  child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  const timer = setTimeout(() => pending.get(requestId)?.({ timeout: true }), 8000);
  try {
    const message = await response;
    expect(message.timeout).toBeUndefined();
    expect(message.error).toBeUndefined();
    return message.result;
  } finally { clearTimeout(timer); }
}
async function initialize() {
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {name: "test", version: "1"} });
  expect(initialized.serverInfo.name).toBe("ws");
  child!.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
}
const call = (name: string, args: object) => request("tools/call", {name, arguments: args});
const data = (result: any) => { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text); };

test("stdio initializes, lists tools, opens a fake agent, submits, waits and reads its reply", async () => {
  await initialize();
  const listed = await request("tools/list");
  expect(listed.tools.map((tool: any) => tool.name).sort()).toEqual(["list_terminals", "open_terminal", "read_output", "send_input", "wait_for_status"]);
  data(await call("open_terminal", {workspace: "demo", name: "agent", command: f.command}));
  await f.ready();
  expect(data(await call("list_terminals", {}))[0]).toMatchObject({name: "agent", state: "running", status: "idle", command: f.command});
  expect(data(await call("list_terminals", {workspace: "demo"}))).toHaveLength(1);
  expect(data(await call("send_input", {workspace: "demo", name: "agent", text: "hello $world 'café'"})).status).toBe("working");
  expect(data(await call("wait_for_status", {workspace: "demo", name: "agent"})).status).toBe("idle");
  expect(data(await call("read_output", {workspace: "demo", name: "agent"})).text).toContain("FAKE REPLY: hello $world 'café'");
  expect(messages.length).toBe(8);
}, 15000);

test("tool errors cover invalid input, missing terminals, timeouts and stopped agents", async () => {
  await initialize();
  for (const [name, args] of [
    ["send_input", {workspace: "demo", name: "agent", keys: ["Enter;kill-server"]}],
    ["read_output", {workspace: "demo", name: "agent", lines: 5001}],
    ["wait_for_status", {workspace: "demo", name: "agent", timeoutSeconds: 3601}],
  ] as const) expect((await call(name, args)).isError).toBe(true);
  expect((await call("wait_for_status", {workspace: "demo", name: "missing"})).content[0].text).toContain("not found");
  data(await call("open_terminal", {workspace: "demo", name: "agent", command: f.command}));
  await f.ready();
  const timedOut = await call("wait_for_status", {workspace: "demo", name: "agent", status: "needs_input", timeoutSeconds: 0.05});
  expect(timedOut.isError).toBe(true);
  expect(timedOut.content[0].text).toContain("Timed out");
  // A pending wait must not block other MCP calls.
  const wait = call("wait_for_status", {workspace: "demo", name: "agent", status: "working", timeoutSeconds: 3});
  expect(data(await call("read_output", {workspace: "demo", name: "agent"})).text).toContain("FAKE READY");
  Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-session", "-t", "=ws-demo-agent"]);
  const stopped = await wait;
  expect(stopped.isError).toBe(true);
  expect(stopped.content[0].text).toContain("no longer running");
}, 15000);

test("--on uses the existing SSH tunnel and keeps its diagnostics off stdout", async () => {
  child!.stdin.end();
  expect(await child!.exited).toBe(0);
  await reading;
  expect(await stderr).toBe("");
  const ssh = fakeSsh(f.root);
  startMcp("example-alias", ssh.env);
  await initialize();
  expect(data(await call("list_terminals", {}))).toEqual([]);
  const invocations = ssh.invocations();
  expect(invocations).toHaveLength(1);
  expect(invocations[0]!.argv.at(-1)).toBe("example-alias");
  expect(invocations[0]!.argv).toContain(`${invocations[0]!.unix}:127.0.0.1:${f.app.server.port}`);
  for (const invocation of invocations) ssh.assertClean(invocation);
});

test("closing stdin stops a pending long status wait", async () => {
  await initialize();
  data(await call("open_terminal", {workspace: "demo", name: "agent", command: f.command}));
  await f.ready();
  child!.stdin.write(JSON.stringify({jsonrpc: "2.0", id: ++id, method: "tools/call", params: {
    name: "wait_for_status", arguments: {workspace: "demo", name: "agent", status: "needs_input", timeoutSeconds: 3600},
  }}) + "\n");
  await Bun.sleep(100);
  child!.stdin.end();
  expect(await Promise.race([child!.exited, Bun.sleep(1000).then(() => "timeout")])).toBe(0);
});
