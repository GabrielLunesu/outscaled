import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../src/cli/client";
import { validateSshTarget, withSshTunnel } from "../src/cli/ssh";
import { fakeSsh } from "./ssh-helpers";

let root: string;
let ssh: ReturnType<typeof fakeSsh>;
let server: ReturnType<typeof Bun.serve>;
let env: NodeJS.ProcessEnv;
let healthStatus: number;
let healthCalls: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-ssh-test-"));
  ssh = fakeSsh(root);
  healthStatus = 200;
  healthCalls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/health") { healthCalls++; return Response.json({}, { status: healthStatus }); }
      if (path === "/slow") await Bun.sleep(1000);
      if (path === "/invalid") return new Response("invalid JSON");
      if (path === "/error") return Response.json({ error: { code: "conflict", message: "Already exists" } }, { status: 409 });
      return Response.json({ method: request.method, body: await request.json().catch(() => null) });
    },
  });
  env = { ...ssh.env, WSD_PORT: String(server.port) };
});

afterEach(async () => {
  await server.stop(true);
  // Assert before removing fixtures so a transport leak cannot be hidden.
  for (const invocation of ssh.invocations()) ssh.assertClean(invocation);
  rmSync(root, { recursive: true, force: true });
});

test("SSH targets allow aliases, user@host and IPv6, and reject options and commands", () => {
  for (const target of ["example-alias", "user@example.invalid", "user@192.0.2.1", "user@[2001:db8::1]", "::1"]) {
    expect(() => validateSshTarget(target)).not.toThrow();
  }
  for (const target of ["", "-example", "user@-example", "host command", "host\ncommand", "$(command)", "host;command", "ssh://example"]) {
    expect(() => validateSshTarget(target)).toThrow("--on must be local");
  }
});

test("transport uses a private socket and structured ssh argv, waits for readiness, then cleans up", async () => {
  env.WS_TEST_SSH_DELAY = "100";
  const body = { slug: "demo", repo: "https://example.invalid/repo with spaces;$(literal)" };
  expect(await createClient("user@example.invalid", env).request("POST", "/v1/workspaces", body))
    .toEqual({ method: "POST", body });
  expect(healthCalls).toBeGreaterThan(0);
  const calls = ssh.invocations();
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.permissions).toBe(0o700);
  expect(call.argv.slice(-3)).toEqual(["-L", `${call.unix}:127.0.0.1:${server.port}`, "user@example.invalid"]);
  for (const option of ["BatchMode=yes", "ExitOnForwardFailure=yes", "ControlMaster=no", "ControlPath=none", "ForkAfterAuthentication=no"]) {
    expect(call.argv).toContain(option);
  }
  expect(call.argv).not.toContain("StrictHostKeyChecking=no");
  expect(call.argv).not.toContain("UserKnownHostsFile=/dev/null");
  expect(call.argv).not.toContain(body.repo);
});

for (const [mode, detail] of [["auth", "Permission denied"], ["forward", "Could not request local forwarding"]]) {
  test(`SSH ${mode} failure is reported and cleaned up`, async () => {
    await expect(createClient("example", { ...env, WS_TEST_SSH_MODE: mode }).request("GET", "/v1/health"))
      .rejects.toThrow(detail);
  });
}

test("missing ssh executable fails without opening a tunnel", async () => {
  await expect(createClient("example", { PATH: root }).request("GET", "/v1/health")).rejects.toThrow();
  expect(ssh.invocations()).toEqual([]);
});

test("startup timeout cleans up a stuck SSH process", async () => {
  await expect(withSshTunnel("example", server.port!, { ...env, WS_TEST_SSH_MODE: "stall" },
    async () => { throw new Error("must not dispatch"); }, { startupTimeoutMs: 500 }))
    .rejects.toThrow("timed out waiting for remote wsd health");
  expect(ssh.invocations()).toHaveLength(1);
});

test("a bound socket with failing health is not considered ready", async () => {
  healthStatus = 503;
  let dispatched = false;
  await expect(withSshTunnel("example", server.port!, env,
    async () => { dispatched = true; }, { startupTimeoutMs: 1000 }))
    .rejects.toThrow("timed out waiting for remote wsd health");
  expect(healthCalls).toBeGreaterThan(0);
  expect(dispatched).toBe(false);
});

test("request timeout, API error and malformed JSON all release the tunnel", async () => {
  const client = createClient("example", env);
  await expect(client.request("GET", "/slow", undefined, 40)).rejects.toThrow("request failed or timed out");
  await expect(client.request("GET", "/error")).rejects.toThrow("Already exists");
  await expect(client.request("GET", "/invalid")).rejects.toThrow("invalid JSON");
  expect(ssh.invocations()).toHaveLength(3);
});

test("SSH exiting during a request aborts it and reports the SSH diagnostic", async () => {
  await expect(createClient("example", { ...env, WS_TEST_SSH_MODE: "die" }).request("GET", "/slow"))
    .rejects.toThrow("SSH tunnel failed");
});

test("cleanup escalates when SSH ignores SIGTERM", async () => {
  expect(await createClient("example", { ...env, WS_TEST_SSH_MODE: "ignore-term" }).request("GET", "/"))
    .toEqual({ method: "GET", body: null });
});

test("cleanup also kills proxy subprocesses in the owned process group", async () => {
  await createClient("example", { ...env, WS_TEST_SSH_MODE: "proxy" }).request("GET", "/");
  const proxyPid = ssh.invocations()[0]?.proxyPid;
  expect(proxyPid).toBeGreaterThan(0);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { process.kill(proxyPid!, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error("SSH proxy process leaked");
});

test("a proxy holding stderr open does not hide an SSH exit", async () => {
  await expect(withSshTunnel("example", server.port!, { ...env, WS_TEST_SSH_MODE: "dead-proxy" },
    async () => {}, { startupTimeoutMs: 2000 })).rejects.toThrow("Proxy failed");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  test(`${signal} interrupts startup and cleans up SSH before the CLI exits`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "health", "--on", "example"], {
      env: { ...env, WS_TEST_SSH_MODE: "stall" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const deadline = Date.now() + 2000;
      while (ssh.invocations().length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(ssh.invocations()).toHaveLength(1);
      child.kill(signal);
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toContain(`SSH tunnel interrupted (${signal})`);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      clearTimeout(timer);
    }
  });
}

test("process exit also kills SSH and removes its socket directory", async () => {
  const module = join(import.meta.dir, "../src/cli/ssh.ts");
  const code = `import { withSshTunnel } from ${JSON.stringify(module)};
    await withSshTunnel("example", ${server.port}, process.env, async () => { process.exit(7); });`;
  const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    expect(await child.exited).toBe(7);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(ssh.invocations()).toHaveLength(1);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try { ssh.assertClean(ssh.invocations()[0]!); return; } catch { await Bun.sleep(10); }
    }
    ssh.assertClean(ssh.invocations()[0]!);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    clearTimeout(timer);
  }
});
