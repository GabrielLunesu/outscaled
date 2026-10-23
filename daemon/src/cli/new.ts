import { parseArgs } from "node:util";
import { createClient, serverOptions } from "./client";

export async function newWorkspace(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...serverOptions,
      repo: { type: "string" },
      path: { type: "string" },
    },
  });
  createClient(values.on);
  throw new Error("not implemented yet");
}
