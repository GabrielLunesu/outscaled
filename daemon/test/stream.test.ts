import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { ApiError, Event, Health, StreamMessage, Terminal, Workspace } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { Stream } from "../src/stream";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let base: string;
let now: number;
interface Client { socket: WebSocket; messages: StreamMessage[]; errors: unknown[]; }
let clients: Client[];

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}

async function connect(): Promise<Client> {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/v1/stream");
  const messages: StreamMessage[] = [];
  const errors: unknown[] = [];
  socket.onmessage = event => {
    try { messages.push(StreamMessage.parse(JSON.parse(String(event.data)))); }
    catch (error) { errors.push(error); }
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = reject;
  });
  const client = { socket, messages, errors };
  clients.push(client);
  return client;
}

async function received(client: Awaited<ReturnType<typeof connect>>, type: string, count = 1) {
  await eventually(() => client.errors.length > 0 || client.messages.filter(message => message.type === type).length >= count);
  expect(client.errors).toEqual([]);
  return client.messages.filter(message => message.type === type)[count - 1]!;
}

async function post(path: string, body: unknown) {
  return fetch(base + path, { method: "POST", body: JSON.stringify(body) });
}
async function createWorkspace(slug = "demo") {
  const response = await post("/v1/workspaces", { slug });
  expect(response.status).toBe(201);
  return Workspace.parse(await response.json());
}
async function open(command = "/bin/sleep 600", alwaysOn = false) {
  const response = await post("/v1/workspaces/demo/terminals", { name: "agent", command, alwaysOn });
  expect(response.status).toBe(201);
  return Terminal.parse(await response.json());
}
async function start(healthIntervalMs?: number) {
  app = await startServer(f.config, { backoffMs: [10] }, {
    now: () => now, tickMs: 60_000, env: { ...f.env, SHELL: "/bin/sh" },
  }, { healthIntervalMs });
  base = `http://127.0.0.1:${app.server.port}`;
}

beforeEach(() => {
  f = fixture();
  clients = [];
  now = Date.parse("2026-01-01T00:00:00.000Z");
});
afterEach(async () => {
  for (const client of clients) {
    expect(client.errors).toEqual([]);
    client.socket.close();
  }
  await app?.stop(); app = undefined;
  Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  f.cleanup();
});

test("two clients receive stored hook events in order and disconnecting one leaves the other working", async () => {
  await start();
  await createWorkspace();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec /bin/sleep 600\n", { mode: 0o755 });
  const terminal = await open(claude);
  const first = await connect();
  const second = await connect();
  expect(first.messages).toEqual([]); // No replay of workspace/open/starting.
  expect(second.messages).toEqual([]);
  expect((await post("/v1/hooks/claude-code", {
    terminal: terminal.id, payload: { hook_event_name: "UserPromptSubmit" },
  })).status).toBe(204);
  for (const client of [first, second]) {
    const event = Event.parse(await received(client, "terminal.status"));
    expect(event).toEqual(app!.state.getEvent(event.id)!);
    expect(event.payload).toEqual({ terminal: terminal.id, oldStatus: "starting", newStatus: "working" });
  }
  expect(first.messages).toEqual(second.messages);
  const closed = new Promise<void>(resolve => { first.socket.onclose = () => resolve(); });
  first.socket.close();
  await closed;
  await post("/v1/hooks/claude-code", { terminal: terminal.id, payload: { hook_event_name: "PermissionRequest" } });
  const needsInput = Event.parse(await received(second, "agent.needs_input"));
  expect(needsInput).toEqual(app!.state.getEvent(needsInput.id)!);
  expect(second.messages.map(message => message.type)).toEqual(["terminal.status", "terminal.status", "agent.needs_input"]);
});

test("workspace creation, terminal open and ordinary shell exit invalidate the terminal list without HTTP polling", async () => {
  await start();
  const client = await connect();
  await createWorkspace();
  expect(await received(client, "workspace.changed")).toEqual({ type: "workspace.changed", workspace: "demo" });
  const terminal = await open();
  await received(client, "workspace.changed", 2);
  process.kill(terminal.pid!, "SIGKILL");
  await received(client, "workspace.changed", 3);
  expect(app!.state.getTerminal(terminal.id)!.state).toBe("exited");
  expect(client.messages).toEqual(Array(3).fill({ type: "workspace.changed", workspace: "demo" }));
  expect(app!.state.listEvents()).toEqual([]); // Live-only invalidations.
});

test("supervisor restart transitions and giving up are broadcast", async () => {
  await start();
  await createWorkspace();
  const client = await connect();
  const terminal = await open("/bin/sh -c 'exit 7'", true);
  const crash = Event.parse(await received(client, "agent.crashed"));
  expect(crash).toMatchObject({ workspace: "demo", terminal: terminal.id, payload: { exitStatus: 7 } });
  expect(crash).toEqual(app!.state.getEvent(crash.id)!);
  expect(app!.state.getTerminal(terminal.id)).toMatchObject({ state: "crashed", restarts: 5 });
  // Open, five restarting/running pairs and the final crash.
  expect(client.messages.filter(message => message.type === "workspace.changed")).toHaveLength(12);
}, 15000);

test("committed process transitions in the same turn each notify; unchanged state does not", async () => {
  await start();
  await createWorkspace();
  const terminal = await open();
  const client = await connect();
  app!.state.updateTerminalState(terminal.id, { state: "restarting", pid: null });
  app!.state.updateTerminalState(terminal.id, { state: "running", pid: terminal.pid });
  app!.state.updateTerminalState(terminal.id, { state: "running", pid: terminal.pid });
  await received(client, "workspace.changed", 2);
  expect(client.messages).toHaveLength(2);
});

test("schedule events use the injected clock and retain the stored Event shape", async () => {
  await start();
  const workspace = await createWorkspace();
  const client = await connect();
  mkdirSync(join(workspace.path, ".ws"));
  writeFileSync(join(workspace.path, ".ws/workspace.toml"),
    '[[agent]]\nname = "check"\nruntime = "script"\nmode = "scheduled"\nevery = "10m"\ncommand = "exit 0"\n');
  await app!.schedules.tick();
  now += 600_000;
  await app!.schedules.tick();
  const started = Event.parse(await received(client, "run.started"));
  const finished = Event.parse(await received(client, "run.finished"));
  expect(client.messages.map(message => message.type)).toEqual(["run.started", "run.finished"]);
  for (const event of [started, finished]) {
    expect(event.time).toBe(new Date(now).toISOString());
    expect(event).toEqual(app!.state.getEvent(event.id)!);
  }
  expect(finished.payload).toMatchObject({ status: "succeeded", exitCode: 0, error: false });
});

test("health uses the HTTP body on an injected interval and is never stored", async () => {
  await start(20);
  await createWorkspace();
  const client = await connect();
  const message = await received(client, "server.health");
  const health = Health.parse("payload" in message ? message.payload : null);
  const http = Health.parse(await (await fetch(base + "/v1/health")).json());
  expect(health.name).toBe(http.name);
  expect(health.version).toBe(http.version);
  expect(health.disk.path).toBe(http.disk.path);
  expect(health.terminals).toEqual(http.terminals);
  expect(health.ram.totalBytes).toBe(http.ram.totalBytes);
  expect(app!.state.listEvents()).toEqual([]);
});

test("failed transactions never publish status or workspace changes", async () => {
  await start();
  const workspace = await createWorkspace();
  const claude = join(f.root, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec /bin/sleep 600\n", { mode: 0o755 });
  const terminal = await open(claude);
  const client = await connect();
  app!.state.db.exec("CREATE TRIGGER reject_input BEFORE INSERT ON events WHEN NEW.type = 'agent.needs_input' BEGIN SELECT RAISE(ABORT, 'reject input'); END");
  expect(() => app!.state.updateTerminalStatus(terminal.id, "needs_input")).toThrow("reject input");
  expect(() => app!.state.db.transaction(() => {
    app!.state.insertWorkspace({ ...workspace, slug: "rolled-back", path: join(f.root, "rolled-back") });
    app!.state.updateTerminalState(terminal.id, { state: "crashed", pid: null });
    throw new Error("rollback");
  })()).toThrow("rollback");
  await Bun.sleep(50);
  expect(client.messages).toEqual([]);
  expect(app!.state.getTerminal(terminal.id)).toMatchObject({ state: "running", status: "starting" });
});

test("shutdown closes connected sockets", async () => {
  await start(10);
  const client = await connect();
  const closed = new Promise<number>(resolve => { client.socket.onclose = () => resolve(client.socket.readyState); });
  await received(client, "server.health");
  await app!.stop(); app = undefined;
  expect(await closed).toBe(WebSocket.CLOSED);
});

test("non-WebSocket requests get a clear JSON 4xx", async () => {
  await start();
  for (const method of ["GET", "POST"]) {
    const response = await fetch(base + "/v1/stream", { method });
    expect(response.status).toBe(method === "GET" ? 400 : 405);
    expect(ApiError.parse(await response.json()).error.message).toContain("WebSocket");
  }
});

test("protocol rejects malformed live notifications and incomplete stored events", () => {
  for (const message of [
    { type: "workspace.changed", workspace: "Bad" },
    { type: "server.health", payload: {} },
    { type: "terminal.status", workspace: "demo", payload: {} },
  ]) expect(StreamMessage.safeParse(message).success).toBe(false);
});

for (const failure of ["buffered", "backpressure", "dropped", "closed", "throws"] as const) {
  test(`a ${failure} client is dropped without affecting other clients`, () => {
    const stream = new Stream();
    const sent: string[] = [];
    let terminated = 0;
    const slow = {
      readyState: failure === "closed" ? 3 : 1,
      getBufferedAmount: () => failure === "buffered" ? 1 : 0,
      send: () => {
        if (failure === "throws") throw new Error("closed");
        return failure === "backpressure" ? -1 : 0;
      },
      terminate: () => { terminated++; },
    } as unknown as ServerWebSocket<undefined>;
    const fast = {
      readyState: 1, getBufferedAmount: () => 0,
      send: (json: string) => { sent.push(json); return json.length; },
    } as unknown as ServerWebSocket<undefined>;
    stream.websocket.open!(slow);
    stream.websocket.open!(fast);
    const message = { type: "workspace.changed", workspace: "demo" } as const;
    stream.publish(message);
    stream.publish(message);
    expect(terminated).toBe(1);
    expect(sent.map(json => StreamMessage.parse(JSON.parse(json)))).toEqual([message, message]);
    stream.websocket.close!(fast, 1000, "");
    stream.publish(message);
    expect(sent).toHaveLength(2);
  });
}
