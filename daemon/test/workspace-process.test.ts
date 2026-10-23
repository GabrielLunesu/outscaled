import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, Workspace } from "@outscaled/protocol";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";

test("git is noninteractive, partial clones roll back, and a slow clone completes over HTTP", async () => {
  const f = fixture();
  let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  try {
    const repo = localRepository(f.root);
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$GIT_TERMINAL_PROMPT" != "0" ]; then
  echo 'terminal prompts were not disabled' >&2
  exit 1
fi
if [ "$3" = "test-partial-failure" ]; then
  echo 'partial clone data' > "$4/partial"
  echo 'first diagnostic' >&2
  echo 'fatal: test clone failed' >&2
  exit 1
fi
sleep 22
exec "$WSD_TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    const env = {
      ...f.env,
      WSD_PORT: String(port),
      PATH: `${bin}:${process.env.PATH}`,
      WSD_TEST_REAL_GIT: Bun.which("git")!,
    };
    daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/wsd.ts")], {
      env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const address = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${await new Response(daemon.stderr).text()}`);
      try {
        if ((await fetch(`${address}/v1/health`)).ok) { ready = true; break; }
      } catch { /* Wait for the test daemon to bind. */ }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const failed = await fetch(`${address}/v1/workspaces`, {
      method: "POST", body: JSON.stringify({ slug: "failed", repo: "test-partial-failure" }),
    });
    expect(failed.status).toBe(500);
    expect(ApiError.parse(await failed.json()).error).toEqual({ code: "clone_failed", message: "Git clone failed: fatal: test clone failed" });
    expect(existsSync(join(f.config.workspacesDir, "failed"))).toBe(false);
    expect(await (await fetch(`${address}/v1/workspaces`)).json()).toEqual([]);

    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/ws.ts"), "new", "slow", "--repo", repo, "--json"], {
      env, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const workspace = Workspace.parse(JSON.parse(stdout));
      expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe("workspace fixture\n");
      expect(await (await fetch(`${address}/v1/workspaces`)).json()).toEqual([workspace]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (daemon) {
      daemon.kill();
      const timer = setTimeout(() => daemon!.kill("SIGKILL"), 3000);
      await daemon.exited;
      clearTimeout(timer);
    }
    f.cleanup();
  }
}, 45000);
