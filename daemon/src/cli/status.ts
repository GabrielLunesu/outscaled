import { parseArgs } from "node:util";
import { Terminal } from "@outscaled/protocol";
import { createClient } from "./client";
import { readServers } from "./servers";

export async function status(args: string[]): Promise<number> {
  const usage = "usage: ws status [--json]; --on is not accepted because status covers every server";
  if (args.some(arg => arg === "--on" || arg.startsWith("--on="))) throw new Error(usage);
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, options: { json: { type: "boolean", default: false } },
  });
  if (positionals.length) throw new Error(usage);

  const results = await Promise.all(readServers().map(async server => {
    try {
      const terminals = Terminal.array().parse(await createClient(server).request("GET", "/v1/terminals"));
      return { server, terminals };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { server, error: message.replace(/[\x00-\x1f\x7f]+/g, " ") };
    }
  }));
  if (values.json) console.log(JSON.stringify(results));
  else {
    const rows = results.flatMap(result => (result.terminals ?? []).map(terminal =>
      [result.server, terminal.workspace, terminal.name, terminal.state, terminal.status ?? "-"]));
    const widths = Array.from({ length: 4 }, (_, column) =>
      rows.reduce((width, row) => Math.max(width, row[column]!.length), 0));
    for (const row of rows) console.log(row.map((cell, column) =>
      column < widths.length ? cell.padEnd(widths[column]!) : cell).join("  "));
    for (const result of results) if (result.error !== undefined) console.error(`ws: ${result.server}: ${result.error}`);
  }
  return results.some(result => result.error !== undefined) ? 1 : 0;
}
