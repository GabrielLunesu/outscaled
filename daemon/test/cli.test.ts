import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Health, Terminal, Workspace } from "@outscaled/protocol";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";
import { fakeSsh } from "./ssh-helpers";
import { shellQuote } from "../src/terminals";

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

for (const mode of ["source", "compiled", "installed"] as const) {
  describe(`${mode} daemon and CLI`, () => {
    let f: ReturnType<typeof fixture>;
    let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
    let env: NodeJS.ProcessEnv;
    let cli: string[];
    let address: string;
    let ssh: ReturnType<typeof fakeSsh>;

    beforeAll(async () => {
      f = fixture();
      ssh = fakeSsh(f.root);
      env = { ...f.env, WSD_PORT: String(await freePort()) };
      address = `http://127.0.0.1:${env.WSD_PORT}`;
      const installed = join(f.root, "copied daemon 'with spaces'");
      if (mode === "installed") copyFileSync(join(root, "dist/wsd"), installed);
      cli = mode === "source" ? [process.execPath, "src/ws.ts"]
        : mode === "installed" ? [installed, "--ws-cli"] : [join(root, "dist/ws")];
      const command = mode === "source" ? [process.execPath, "src/wsd.ts"]
        : [mode === "installed" ? installed : join(root, "dist/wsd")];
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
      if (f) Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { env: f.env });
      for (const invocation of ssh?.invocations() ?? []) ssh.assertClean(invocation);
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

    test("invalid SSH destinations fail clearly before connecting", async () => {
      for (const command of [["health"], ["new", "demo"], ["term", "ls", "demo"]]) {
        const remote = await execute([...cli, ...command, "--on=-invalid"], { ...env, ...ssh.env });
        expect(remote.code).toBe(1);
        expect(remote.stderr).toContain("--on must be local");
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

    test("SSH CLI creates empty workspaces, clones and registers folders, checks health and opens/lists terminals", async () => {
      const remoteEnv = { ...env, ...ssh.env };
      const remote = (...args: string[]) => execute([...cli, ...args, "--on", "example-alias", "--json"], remoteEnv);
      const empty = await remote("new", "remote-empty");
      expect(empty.code).toBe(0);
      expect(Workspace.parse(JSON.parse(empty.stdout))).toMatchObject({ slug: "remote-empty", inPlace: false });

      const repoRoot = join(f.root, "remote-repo-fixture");
      mkdirSync(repoRoot);
      const repo = localRepository(repoRoot);
      const cloned = await remote("new", "remote-clone", "--repo", repo);
      expect(cloned.code).toBe(0);
      expect(cloned.stderr).toBe("");
      const clone = Workspace.parse(JSON.parse(cloned.stdout));
      expect(clone).toMatchObject({ slug: "remote-clone", repo, inPlace: false });
      expect(readFileSync(join(clone.path, "README.md"), "utf8")).toBe("workspace fixture\n");
      expect(statSync(join(clone.path, ".git")).isDirectory()).toBe(true);

      const path = join(f.root, "remote existing 'folder'; $literal");
      mkdirSync(path);
      writeFileSync(join(path, "keep"), "unchanged");
      const before = statSync(path);
      const registered = await remote("new", "remote-existing", "--path", path);
      expect(registered.code).toBe(0);
      expect(Workspace.parse(JSON.parse(registered.stdout))).toMatchObject({ slug: "remote-existing", path, inPlace: true });
      expect(readdirSync(path)).toEqual(["keep"]);
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);

      const health = await remote("health");
      expect(health.code).toBe(0);
      expect(Health.parse(JSON.parse(health.stdout)).version).toBe("0.0.0");
      const opened = await remote("term", "open", "remote-existing", "--name", "a1", "--cmd", "sleep 600");
      expect(opened.code).toBe(0);
      expect(Terminal.parse(JSON.parse(opened.stdout))).toMatchObject({ workspace: "remote-existing", name: "a1", command: "sleep 600" });
      const listed = await remote("term", "ls", "remote-existing");
      expect(listed.code).toBe(0);
      expect(Terminal.array().parse(JSON.parse(listed.stdout))).toHaveLength(1);
      expect(ssh.invocations()).toHaveLength(6);
      for (const invocation of ssh.invocations()) ssh.assertClean(invocation);
    }, 15000);

    test("invalid CLI arguments and non-absolute remote paths never invoke SSH", async () => {
      const before = ssh.invocations().length;
      for (const args of [
        ["new"], ["new", "Upper"], ["new", "one", "two"], ["new", "demo", "--repo", ""],
        ["new", "demo", "--repo", "repo", "--path", "/example"],
        ...["", "~", "~/folder", "relative", "./folder"].map(path => ["new", "demo", "--path", path]),
        ["term", "open", "demo"], ["term", "open", "demo", "--name", "Upper"],
        ["term", "ls", "demo", "--cmd", "sh"], ["term", "ls", "../escape"],
        ["health", "extra"], ["health", "--unknown"],
      ]) {
        const result = await execute([...cli, ...args, "--on", "example-alias"], { ...env, ...ssh.env });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
      }
      expect(ssh.invocations()).toHaveLength(before);
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

    test("a fake claude executes launch hooks by absolute path, including from a copied binary", async () => {
      const folder = join(f.root, "hook workspace");
      const bin = join(f.root, "fake bin");
      mkdirSync(folder);
      mkdirSync(bin);
      const fake = join(bin, "claude");
      writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const settings = JSON.parse(await Bun.file(args[1]).text());
const command = settings.hooks.SessionStart[0].hooks[0].command;
const child = Bun.spawn(["/bin/sh", "-c", command], {
  env: {...process.env, PATH: "/usr/bin:/bin"}, stdin: new Blob([JSON.stringify({hook_event_name: "SessionStart"})]), stdout: "pipe", stderr: "pipe"
});
await Bun.write("hook-result.json", JSON.stringify({args, terminal: process.env.WSD_TERMINAL, port: process.env.WSD_PORT, code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text()}));
await Bun.sleep(600000);
`, { mode: 0o755 });
      expect((await execute([...cli, "new", "hook-demo", "--path", folder], env)).code).toBe(0);
      const opened = await execute([...cli, "term", "open", "hook-demo", "--name", "c1", "--cmd", `${shellQuote(fake)} 'quoted argument'`, "--json"], env);
      expect(opened.code).toBe(0);
      const row = Terminal.parse(JSON.parse(opened.stdout));
      let result: any;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await Bun.file(join(folder, "hook-result.json")).exists()) {
          result = JSON.parse(await Bun.file(join(folder, "hook-result.json")).text());
          break;
        }
        await Bun.sleep(20);
      }
      expect(result).toEqual({
        args: ["--settings", join(f.config.stateDir, "claude-settings.json"), "quoted argument"],
        terminal: row.id, port: env.WSD_PORT, code: 0, stdout: "", stderr: "",
      });
      const listed = await execute([...cli, "term", "ls", "hook-demo", "--json"], env);
      expect(Terminal.array().parse(JSON.parse(listed.stdout))[0]).toMatchObject({ runtime: "claude-code", status: "idle" });
      for (const overrides of [{ WSD_TERMINAL: "" }, { WSD_TERMINAL: row.id, WSD_PORT: String(await freePort()) }]) {
        const child = Bun.spawn([...cli, "hook", "claude-code"], {
          cwd: root, env: { ...env, ...overrides }, stdin: new Blob(['{"hook_event_name":"Stop"}']), stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
      }
    }, 10000);
  });
}
