import { parseArgs } from "node:util";
import { Health } from "@outscaled/protocol";
import { createClient, serverOptions } from "./client";

function bytes(value: number): string {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export async function health(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: serverOptions, allowPositionals: false });
  const data = await createClient(values.on).request("GET", "/v1/health");
  const health = Health.parse(data);
  if (values.json) {
    console.log(JSON.stringify(data));
    return;
  }
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
