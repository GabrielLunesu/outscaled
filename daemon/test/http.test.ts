import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";
import { ApiError, Health } from "@outscaled/protocol";
import { startServer } from "../src/server";
import { fixture, terminal, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let base: string;
beforeEach(async () => {
  f = fixture();
  app = await startServer({ ...f.config, workspacesDir: join(f.root, "missing", "workspaces") });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => { await app.stop(); f.cleanup(); });

test("health over real loopback HTTP reports machine, disk and database values", async () => {
  expect(app.server.hostname).toBe("127.0.0.1");
  app.state.insertWorkspace(workspace);
  app.state.insertTerminal(terminal);
  app.state.insertTerminal({ ...terminal, id: "terminal-2", name: "other", session: "ws-demo-other", state: "exited" });
  const response = await fetch(`${base}/v1/health`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const health = Health.parse(await response.json());
  expect(health.name).toBe("test-host");
  expect(health.version).toBe("0.0.0");
  expect(health.cpu.cores).toBe(cpus().length);
  expect(health.ram.totalBytes).toBe(totalmem());
  expect(health.uptimeSec).toBeGreaterThan(0);
  expect(health.disk.path).toBe(f.root);
  expect(health.disk.totalBytes).toBeGreaterThan(0);
  expect(health.disk.usedBytes).toBeLessThanOrEqual(health.disk.totalBytes);
  expect(health.terminals).toEqual({ total: 2, running: 1 });
  mkdirSync(join(f.root, "missing", "workspaces"), { recursive: true });
  const next = Health.parse(await (await fetch(`${base}/v1/health`)).json());
  expect(next.disk.path).toBe(join(f.root, "missing", "workspaces"));
  expect(next.uptimeSec).toBeGreaterThan(health.uptimeSec);
});

test("CPU sampling does not block other requests", async () => {
  const pending = fetch(`${base}/v1/health`);
  await Bun.sleep(10);
  const missing = fetch(`${base}/missing`);
  expect(await Promise.race([pending.then(() => "health"), missing.then(() => "missing")])).toBe("missing");
  const response = await missing;
  expect(response.status).toBe(404);
  expect((await pending).status).toBe(200);
});

test("unknown paths and methods return JSON 404", async () => {
  for (const [path, method] of [["/health", "GET"], ["/v1/unknown", "GET"], ["/v1/workspaces", "DELETE"], ["/v1/health", "POST"]]) {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(404);
    expect(ApiError.parse(await response.json()).error.code).toBe("not_found");
  }
});

test("request schemas reject invalid slugs, conflicting repo/path and malformed bodies", async () => {
  const invalidWorkspaces = [{}, { slug: "Upper" }, { slug: "-bad" }, { slug: "a".repeat(41) },
    { slug: "a", repo: "repo", path: "/example" }, { slug: "a", repo: null }, { slug: "a", path: "" }, null];
  const invalidTerminals = [{}, { name: "bad_name" }, { name: "a", command: "" }, { name: "a", alwaysOn: "yes" }];
  for (const [path, bodies] of [["/v1/workspaces", invalidWorkspaces], ["/v1/workspaces/demo/terminals", invalidTerminals]] as const) {
    for (const body of [...bodies.map(value => JSON.stringify(value)), "{broken", ""]) {
      const response = await fetch(`${base}${path}`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");
    }
  }
  expect((await fetch(`${base}/v1/workspaces/INVALID/terminals`)).status).toBe(400);
});
