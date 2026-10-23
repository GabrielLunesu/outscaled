import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { Health } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { version } from "../../package.json";

function cpuTimes() {
  const cores = cpus();
  return {
    cores: cores.length,
    idle: cores.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: cores.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
  };
}

async function cpuUsage(): Promise<Health["cpu"]> {
  const before = cpuTimes();
  await Bun.sleep(100);
  const after = cpuTimes();
  const elapsed = after.total - before.total;
  return {
    cores: after.cores,
    load1: loadavg()[0]!,
    usagePct: elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (after.idle - before.idle) / elapsed))) : 0,
  };
}

export async function diskUsage(workspacesDir: string): Promise<Health["disk"]> {
  let path = workspacesDir;
  for (;;) {
    try {
      const disk = await statfs(path);
      return { path, totalBytes: disk.blocks * disk.bsize, usedBytes: (disk.blocks - disk.bfree) * disk.bsize };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
}

export function createHealthRoute({ config, state }: RouteContext) {
  const startedAt = performance.now();
  // Concurrent polls share one short, asynchronous CPU sample.
  let sample: Promise<Health["cpu"]> | undefined;
  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/health") return;
    sample ??= cpuUsage().finally(() => { sample = undefined; });
    const [cpu, disk] = await Promise.all([sample, diskUsage(config.workspacesDir)]);
    const ram = totalmem();
    return Response.json(Health.parse({
      name: config.name,
      version,
      uptimeSec: (performance.now() - startedAt) / 1000,
      cpu,
      ram: { totalBytes: ram, usedBytes: ram - freemem() },
      disk,
      terminals: state.terminalCounts(),
    }));
  };
}
