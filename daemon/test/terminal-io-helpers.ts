import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { shellQuote } from "../src/terminals";
import { fixture, workspace } from "./helpers";

export async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for fake terminal");
}

export async function ioFixture() {
  const f = fixture();
  const shell = process.env.SHELL;
  const home = process.env.HOME;
  process.env.SHELL = "/bin/bash";
  process.env.HOME = f.root;
  mkdirSync(join(f.root, "bin"));
  const fake = join(f.root, "bin/claude");
  // Named claude for runtime detection, but never runs an installed agent.
  writeFileSync(fake, `#!${process.execPath}
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?2004h");
const received = [];
let pending = "";
let pasted = false;
let prompt = "";
const hook = hook_event_name => fetch("http://127.0.0.1:" + process.env.WSD_PORT + "/v1/hooks/claude-code", {
  method: "POST", body: JSON.stringify({terminal: process.env.WSD_TERMINAL, payload: {hook_event_name}})
});
await hook("SessionStart");
console.log("FAKE READY");
process.stdin.on("data", chunk => {
  received.push(chunk);
  require("node:fs").writeFileSync("received.bin", Buffer.concat(received));
  pending += chunk.toString();
  while (pending.length) {
    if (pending.startsWith("\\x1b[200~")) { pasted = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\\x1b[201~")) { pasted = false; pending = pending.slice(6); continue; }
    // Don't consume a partial bracketed-paste marker.
    if (pending.startsWith("\\x1b") && pending.length < 6 && ("\\x1b[200~".startsWith(pending) || "\\x1b[201~".startsWith(pending))) break;
    const char = pending[0]; pending = pending.slice(1);
    if (char === "\\r" && !pasted) {
      const reply = prompt; prompt = "";
      setTimeout(async () => { console.log("FAKE REPLY: " + reply); await hook("Stop"); }, 250);
    } else prompt += char;
  }
});
`, { mode: 0o755 });
  const app = await startServer(f.config);
  app.state.insertWorkspace({ ...workspace, path: f.root });
  const address = `http://127.0.0.1:${app.server.port}`;
  const path = `${address}/v1/workspaces/demo/terminals`;
  return {
    ...f, app, address, path, command: shellQuote(fake),
    async open(body: object) {
      const response = await fetch(path, { method: "POST", body: JSON.stringify(body) });
      if (response.status !== 201) throw new Error(await response.text());
      return response.json() as Promise<import("@outscaled/protocol").Terminal>;
    },
    async ready() {
      await eventually(async () => {
        const response = await fetch(`${path}/agent/output`);
        return response.ok && (await response.json() as {text: string}).text.includes("FAKE READY");
      });
    },
    async cleanup() {
      await app.stop();
      Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"]);
      f.cleanup();
      if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    },
  };
}
