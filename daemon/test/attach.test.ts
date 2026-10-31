import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "@outscaled/protocol";
import { fixture, terminal } from "./helpers";
import { fakeSsh } from "./ssh-helpers";

let f: ReturnType<typeof fixture>;
let ssh: ReturnType<typeof fakeSsh>;
let server: ReturnType<typeof Bun.serve>;
let env: NodeJS.ProcessEnv;
let terminals: Terminal[];
let requests: string[];
let log: string;

function attachments(): { argv: string[]; tmux: string | null }[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

beforeEach(() => {
  f = fixture();
  ssh = fakeSsh(f.root);
  log = join(f.root, "attach.jsonl");
  // Only these fakes are on PATH, so neither real SSH nor tmux can run.
  const fake = `
require("node:fs").appendFileSync(process.env.WS_TEST_ATTACH_LOG,
  JSON.stringify({argv: process.argv.slice(2), tmux: process.env.TMUX ?? null}) + "\\n");
if (process.env.WS_TEST_ATTACH_ECHO) {
  process.stdout.write(await new Response(Bun.stdin.stream()).text());
}
process.stderr.write(process.env.WS_TEST_ATTACH_ERROR ?? "");
process.exit(Number(process.env.WS_TEST_ATTACH_EXIT ?? 0));
`;
  writeFileSync(join(ssh.env.PATH, "tmux"), `#!${process.execPath}\n${fake}`, { mode: 0o755 });
  const sshFile = join(ssh.env.PATH, "ssh");
  const tunnel = readFileSync(sshFile, "utf8").split("\n").slice(1).join("\n");
  writeFileSync(sshFile, `#!${process.execPath}\nif (process.argv[2] === "-t") { ${fake} }\n${tunnel}`);
  terminals = [{ ...terminal, name: "a1", session: "ws-demo-a1" }];
  requests = [];
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/v1/health") return Response.json({});
      if (path === "/v1/workspaces/demo/terminals") return Response.json(terminals);
      return Response.json({ error: { code: "not_found", message: "Workspace not found" } }, { status: 404 });
    },
  });
  env = { ...f.env, ...ssh.env, WSD_PORT: String(server.port), WS_TEST_ATTACH_LOG: log, TMUX: "/outer/socket,123,0" };
});

afterEach(async () => {
  await server.stop(true);
  for (const call of ssh.invocations()) ssh.assertClean(call);
  f.cleanup();
});

async function execute(args: string[], overrides: NodeJS.ProcessEnv = {}, input = "") {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "attach", ...args], {
    env: { ...env, ...overrides }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    clearTimeout(timer);
  }
}

test("local attach uses the private socket, UTF-8 and an exact session target, without TMUX", async () => {
  expect(await execute(["demo", "a1"], { WS_TEST_ATTACH_ECHO: "1" }, "typed input: café\n"))
    .toEqual({ code: 0, stdout: "typed input: café\n", stderr: "" });
  expect(attachments()).toEqual([{
    argv: ["-u", "-S", env.WSD_TMUX_SOCKET!, "attach-session", "-t", "=ws-demo-a1"], tmux: null,
  }]);
  expect(requests).toEqual(["GET /v1/workspaces/demo/terminals"]);
  expect(ssh.invocations()).toEqual([]);
});

test("explicit local target uses the default socket when no override is set", async () => {
  expect((await execute(["demo", "a1", "--on", "local"], { WSD_TMUX_SOCKET: "" })).code).toBe(0);
  // Still a fake tmux: this test never contacts the real default socket.
  expect(attachments()).toEqual([{ argv: ["-u", "attach-session", "-t", "=ws-demo-a1"], tmux: null }]);
});

for (const state of ["exited", "crashed", "restarting"] as const) {
  test(`${state} terminal fails before tmux is started`, async () => {
    terminals[0]!.state = state;
    const result = await execute(["demo", "a1"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: `ws: Terminal demo/a1 is not running (${state})\n` });
    expect(attachments()).toEqual([]);
  });
}

test("unknown terminal or workspace fails clearly without starting tmux", async () => {
  expect(await execute(["demo", "missing"]))
    .toEqual({ code: 1, stdout: "", stderr: "ws: Terminal demo/missing not found\n" });
  expect(await execute(["missing", "a1"]))
    .toEqual({ code: 1, stdout: "", stderr: "ws: Workspace not found\n" });
  expect(attachments()).toEqual([]);
});

test("unreachable daemon fails clearly without starting tmux", async () => {
  const port = server.port;
  await server.stop(true);
  const result = await execute(["demo", "a1"]);
  expect(result).toEqual({ code: 1, stdout: "", stderr: `ws: wsd isn't reachable at http://127.0.0.1:${port}\n` });
  expect(attachments()).toEqual([]);
});

test("remote attach checks via SSH, then passes the exact interactive SSH argv and exit code", async () => {
  expect(await execute(["demo", "a1", "--on", "user@example.invalid"], {
    WS_TEST_ATTACH_EXIT: "37", WS_TEST_ATTACH_ERROR: "sudo: a password is required\n",
  })).toEqual({ code: 37, stdout: "", stderr: "sudo: a password is required\n" });
  expect(attachments()).toEqual([{
    argv: ["-t", "user@example.invalid", "sudo", "-n", "-u", "ws", "-H", "tmux", "-u", "attach-session", "-t", "=ws-demo-a1"],
    tmux: null,
  }]);
  expect(ssh.invocations()).toHaveLength(1);
  expect(ssh.invocations()[0]!.argv.at(-1)).toBe("user@example.invalid");
  expect(requests).toContain("GET /v1/health");
  expect(requests).toContain("GET /v1/workspaces/demo/terminals");
});

test("remote unknown or exited terminals and failed SSH preflight never start interactive SSH", async () => {
  expect((await execute(["demo", "missing", "--on", "example-alias"])).stderr).toContain("not found");
  terminals[0]!.state = "exited";
  expect((await execute(["demo", "a1", "--on", "example-alias"])).stderr).toContain("not running (exited)");
  const failed = await execute(["demo", "a1", "--on", "example-alias"], { WS_TEST_SSH_MODE: "auth" });
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("Permission denied");
  expect(attachments()).toEqual([]);
});

for (const code of [0, 23, 255]) {
  test(`local tmux exit ${code} passes through`, async () => {
    expect((await execute(["demo", "a1"], { WS_TEST_ATTACH_EXIT: String(code) })).code).toBe(code);
  });
}

test("invalid hosts, slugs, argument counts and --json fail before any request or child", async () => {
  for (const args of [
    [], ["demo"], ["demo", "a1", "extra"], ["../demo", "a1"], ["demo", "a1;command"],
    ["demo", "a1", "--on=-option"], ["demo", "a1", "--on", "host command"],
    ["demo", "a1", "--on", "host;command"], ["demo", "a1", "--json"],
    ["demo", "a1", "--on", "example-alias", "--json"],
    ["Upper", "a1", "--on", "example-alias"], ["demo", "Upper", "--on", "example-alias"],
  ]) {
    const result = await execute(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  }
  expect(requests).toEqual([]);
  expect(attachments()).toEqual([]);
  expect(ssh.invocations()).toEqual([]);
});
