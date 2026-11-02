import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamMessage, WorkspaceChanges, type Terminal } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { shellQuote } from "../src/terminals";
import { fixture, workspace } from "./helpers";
import { localRepository } from "./workspace-helpers";

let app: Awaited<ReturnType<typeof startServer>> | undefined;
let f: ReturnType<typeof fixture> | undefined;
afterEach(async () => {
  await app?.stop(); app = undefined;
  if (f) { Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]); f.cleanup(); f = undefined; }
});

async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); }
  throw new Error("Timed out waiting for attribution");
}

test("HTTP input snapshots before Codex edits, notify records attribution, and live clients refetch", async () => {
  f = fixture();
  const root = fileURLToPath(localRepository(f.root));
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const marker = join(f.root, "ready");
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { createInterface } from "node:readline";
const notify = Bun.TOML.parse(process.argv[3]).notify;
await Bun.write(${JSON.stringify(marker)}, "ready");
for await (const line of createInterface({ input: process.stdin })) {
  await Bun.write("README.md", "Codex edit");
  await Bun.spawn([...notify, JSON.stringify({ type: "agent-turn-complete" })], { stdout: "ignore", stderr: "inherit" }).exited;
}
`, { mode: 0o755 });
  app = await startServer(f.config);
  app.state.insertWorkspace({ ...workspace, path: root });
  const address = `http://127.0.0.1:${app.server.port}`;
  const messages: StreamMessage[] = [];
  const socket = new WebSocket(address.replace("http:", "ws:") + "/v1/stream");
  socket.onmessage = event => messages.push(StreamMessage.parse(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  try {
    const response = await fetch(`${address}/v1/workspaces/demo/terminals`, {
      method: "POST", body: JSON.stringify({ name: "codex-1", command: shellQuote(join(bin, "codex")) }),
    });
    expect(response.status).toBe(201);
    const terminal = await response.json() as Terminal;
    await eventually(() => Bun.file(marker).exists());
    // Agent starts editing immediately on input, before a supervisor output poll.
    expect((await fetch(`${address}/v1/workspaces/demo/terminals/codex-1/input`, {
      method: "POST", body: JSON.stringify({ text: "edit" }),
    })).status).toBe(200);
    await eventually(() => app!.state.getTerminal(terminal.id)?.status === "idle");
    await eventually(() => messages.some(message => message.type === "workspace.changes" && message.workspace === "demo"));
    const changes = WorkspaceChanges.parse(await (await fetch(`${address}/v1/workspaces/demo/changes`)).json());
    expect(changes).toMatchObject({ attributionAvailable: true, files: [{ path: "README.md", status: "modified", agents: [
      { terminal: "codex-1", runtime: "codex", inferred: true },
    ] }] });
    expect(app.state.listEvents().some(event => event.type === "workspace.changes")).toBe(false);
  } finally { socket.close(); }
}, 10000);
