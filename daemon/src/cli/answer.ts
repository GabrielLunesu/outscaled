import { parseArgs } from "node:util";
import { Slug, TerminalAnswer } from "@outscaled/protocol";
import { createClient } from "./client";

export async function answer(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: "string", default: "local" } } });
  const [workspace, name, choice] = positionals;
  if (positionals.length !== 3 || !Slug.safeParse(workspace).success || !Slug.safeParse(name).success || (choice !== "allow" && choice !== "deny")) {
    throw new Error("usage: ws answer <workspace> <name> allow|deny [--on <server>]");
  }
  const client = createClient(values.on);
  const result = TerminalAnswer.parse(await client.request("POST", `/v1/workspaces/${workspace}/terminals/${name}/answer`, {
    answer: choice === "allow" ? "allow_once" : "deny",
  }));
  console.log(`${result.question}\n${result.option.number}. ${result.option.label}`);
}
