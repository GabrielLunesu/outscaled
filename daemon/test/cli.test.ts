import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Health, Workspace } from "@outscaled/protocol";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";

const root = join(import.meta.dir, "..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function execute(cmd: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(cmd, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  // The suite already runs under serial.sh; do not acquire its lock recursively.
  const child = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  if (code !== 0) throw new Error(`Test binary build failed: ${stderr}`);
}, 60000);

for (const mode of ["source", "compiled"] as const) {
  describe(`${mode} daemon and CLI`, () => {
    let f: ReturnType<typeof fixture>;
    let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
    let env: NodeJS.ProcessEnv;
    let cli: string[];
    let address: string;

    beforeAll(async () => {
      f = fixture();
      env = { ...f.env, WSD_PORT: String(await freePort()) };
      address = `http://127.0.0.1:${env.WSD_PORT}`;
      cli = mode === "source" ? [process.execPath, "src/ws.ts"] : [join(root, "dist/ws")];
      const command = mode === "source" ? [process.execPath, "src/wsd.ts"] : [join(root, "dist/wsd")];
      daemon = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${await new Response(daemon.stderr).text()}`);
        try {
          if ((await fetch(`${address}/v1/health`)).ok) return;
        } catch { /* Wait until the test daemon binds its socket. */ }
        await Bun.sleep(25);
      }
      throw new Error("Test daemon did not start");
    }, 10000);

    afterAll(async () => {
      if (daemon) {
        daemon.kill();
        const timer = setTimeout(() => daemon.kill("SIGKILL"), 3000);
        await daemon.exited;
        clearTimeout(timer);
      }
      f?.cleanup();
    });

    test("health prints human-readable metrics", async () => {
      const result = await execute([...cli, "health", "--on", "local"], env);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      for (const label of ["Server:", "Version:", "Uptime:", "CPU:", "RAM:", "Disk:", "Terminals:"]) {
        expect(result.stdout).toContain(label);
      }
    }, 10000);

    test("JSON CLI and curl responses parse with the shared Health schema", async () => {
      if (mode === "compiled") expect(readlinkSync(join(root, "dist/ws"))).toBe("wsd");
      const result = await execute([...cli, "health", "--json", "--on", "local"], env);
      expect(result.code).toBe(0);
      expect(Health.parse(JSON.parse(result.stdout)).terminals).toEqual({ total: 0, running: 0 });
      const curl = await execute(["curl", "-s", `${address}/v1/health`], env);
      expect(curl.code).toBe(0);
      expect(Health.parse(JSON.parse(curl.stdout)).version).toBe("0.0.0");
    }, 10000);

    test("remote names fail clearly", async () => {
      for (const command of [["health"], ["new", "demo"], ["term", "ls", "demo"]]) {
        const remote = await execute([...cli, ...command, "--on", "example"], env);
        expect(remote.code).toBe(1);
        expect(remote.stderr).toContain("remote servers aren't supported yet");
      }
    }, 10000);

    test("ws new clones demo, registers mine in place, and the API lists both", async () => {
      const repo = localRepository(f.root);
      const demoPath = join(f.config.workspacesDir, "demo");
      expect(await execute([...cli, "new", "demo", "--repo", repo, "--on", "local"], env))
        .toEqual({ code: 0, stdout: `${demoPath}\n`, stderr: "" });
      expect(readFileSync(join(demoPath, "README.md"), "utf8")).toBe("workspace fixture\n");
      expect(statSync(join(demoPath, ".git")).isDirectory()).toBe(true);

      const existing = join(f.root, "existing folder");
      mkdirSync(existing);
      writeFileSync(join(existing, "keep"), "unchanged");
      const before = statSync(existing);
      const mine = await execute([...cli, "new", "mine", "--path", existing, "--json"], env);
      expect(mine.code).toBe(0);
      expect(mine.stderr).toBe("");
      const workspace = Workspace.parse(JSON.parse(mine.stdout));
      expect(workspace).toMatchObject({ slug: "mine", path: existing, repo: null, inPlace: true });
      expect(readdirSync(existing)).toEqual(["keep"]);
      expect(readFileSync(join(existing, "keep"), "utf8")).toBe("unchanged");
      expect(statSync(existing).mtimeMs).toBe(before.mtimeMs);

      const response = await fetch(`${address}/v1/workspaces`);
      expect(response.status).toBe(200);
      const listed = Workspace.array().parse(await response.json());
      expect(listed).toHaveLength(2);
      expect(listed[0]).toMatchObject({ slug: "demo", path: demoPath, repo, inPlace: false });
      expect(listed[1]).toEqual(workspace);
    }, 10000);

    test("dispatch prints usage and command groups reject unrelated options", async () => {
      for (const args of [[], ["unknown"]]) {
        const result = await execute([...cli, ...args], env);
        expect(result.code).toBe(1);
        expect(result.stderr).toStartWith("usage: ws ");
      }
      for (const args of [["health", "--repo", "example"], ["new", "demo", "--cmd", "sh"], ["term", "ls", "demo", "--repo", "example"]]) {
        const result = await execute([...cli, ...args], env);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Unknown option");
      }
    }, 10000);

    test("unreachable daemon produces one line with its address and exit 1", async () => {
      const port = await freePort();
      const result = await execute([...cli, "health"], { ...env, WSD_PORT: String(port) });
      expect(result.code).toBe(1);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain(`wsd isn't reachable at http://127.0.0.1:${port}`);
    }, 10000);
  });
}
