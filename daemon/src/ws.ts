import { parseArgs } from "node:util";
import { ApiError, Health } from "@outscaled/protocol";
import { parsePort } from "./config";

function bytes(value: number): string {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        on: { type: "string", default: "local" },
        json: { type: "boolean", default: false },
        repo: { type: "string" },
        path: { type: "string" },
        name: { type: "string" },
        cmd: { type: "string" },
        "always-on": { type: "boolean" },
      },
    });
    if (values.on !== "local") throw new Error("remote servers aren't supported yet; use --on local");
    const [command, subcommand] = positionals;
    if (command === "new" || (command === "term" && (subcommand === "open" || subcommand === "ls"))) {
      throw new Error("not implemented yet");
    }
    if (command !== "health" || positionals.length !== 1) {
      throw new Error("usage: ws [--on local] [--json] health | new | term open | term ls");
    }
    const address = `http://127.0.0.1:${parsePort(process.env.WSD_PORT)}`;
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${address}/v1/health`, { signal: AbortSignal.timeout(3000) });
      raw = await response.text();
    } catch {
      throw new Error(`wsd isn't reachable at ${address}`);
    }
    if (!response.ok) {
      const error = ApiError.safeParse(JSON.parse(raw));
      throw new Error(error.success ? error.data.error.message : `wsd returned HTTP ${response.status}`);
    }
    const health = Health.parse(JSON.parse(raw));
    if (values.json) {
      console.log(raw);
    } else {
      console.log([
        `Server: ${health.name}`,
        `Version: ${health.version}`,
        `Uptime: ${health.uptimeSec.toFixed(1)} s`,
        `CPU: ${health.cpu.usagePct.toFixed(1)}% (${health.cpu.cores} cores, load ${health.cpu.load1.toFixed(2)})`,
        `RAM: ${bytes(health.ram.usedBytes)} / ${bytes(health.ram.totalBytes)}`,
        `Disk: ${bytes(health.disk.usedBytes)} / ${bytes(health.disk.totalBytes)} (${health.disk.path})`,
        `Terminals: ${health.terminals.running} running / ${health.terminals.total} total`,
      ].join("\n"));
    }
    return 0;
  } catch (error) {
    console.error(`ws: ${error instanceof Error ? error.message.replace(/\s*\n\s*/g, " ") : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli();
