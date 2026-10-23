import { parseArgs } from "node:util";
import { createClient, serverOptions } from "./client";

export async function term(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...serverOptions,
      name: { type: "string" },
      cmd: { type: "string" },
      "always-on": { type: "boolean" },
    },
  });
  createClient(values.on);
  if (positionals[0] !== "open" && positionals[0] !== "ls") {
    throw new Error("usage: ws term <open | ls> <workspace> [options]");
  }
  throw new Error("not implemented yet");
}
