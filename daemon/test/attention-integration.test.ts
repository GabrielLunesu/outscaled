import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { fixture } from "./helpers";
import { attentionScenario } from "./attention-scenario";

test("private tmux agents supply waiting requests, live latest lines and safe answers through API and CLI", async () => {
  const f = fixture();
  const oldShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  const folder = join(f.root, "attention"); mkdirSync(folder);
  const app = await startServer(f.config);
  try {
    await attentionScenario(`http://127.0.0.1:${app.server.port}`, [process.execPath, join(import.meta.dir, "../src/ws.ts")],
      { ...f.env, WSD_PORT: String(app.server.port) }, folder);
    expect(app.state.listEvents().filter(event => event.type === "agent.needs_input")).toHaveLength(7);
  } finally {
    await app.stop();
    Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]);
    f.cleanup();
    if (oldShell === undefined) delete process.env.SHELL; else process.env.SHELL = oldShell;
  }
}, 30000);
