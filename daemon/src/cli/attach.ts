import { parseArgs } from "node:util";
import { Slug, Terminal } from "@outscaled/protocol";
import { shellQuote } from "../terminals";
import { createClient, serverOptions } from "./client";

export async function attach(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { on: serverOptions.on },
  });
  if (positionals.length !== 2) {
    throw new Error("usage: ws attach <workspace> <name> [--on <server>]");
  }
  const [workspace, name] = positionals;
  if (!Slug.safeParse(workspace).success) throw new Error("Invalid workspace slug");
  if (!Slug.safeParse(name).success) throw new Error("Invalid terminal name");

  const client = createClient(values.on);
  const terminals = Terminal.array().parse(await client.request("GET", `/v1/workspaces/${workspace}/terminals`));
  const terminal = terminals.find(terminal => terminal.name === name);
  if (!terminal) throw new Error(`Terminal ${workspace}/${name} not found`);
  if (terminal.state !== "running") {
    throw new Error(`Terminal ${workspace}/${name} is not running (${terminal.state})`);
  }

  const command = ["tmux", "-u",
    ...(values.on === "local" && process.env.WSD_TMUX_SOCKET ? ["-S", process.env.WSD_TMUX_SOCKET] : []),
    "attach-session", "-t", `=ws-${workspace}-${name}`];
  const env = { ...process.env };
  // Allow attaching from an outer tmux client without its nesting/socket hints.
  delete env.TMUX;
  // SSH joins remote argv for the login shell; quote even tmux's =target.
  const child = Bun.spawn(values.on === "local" ? command
    : ["ssh", "-t", values.on, ...["sudo", "-n", "-u", "ws", "-H", ...command].map(shellQuote)], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  return await child.exited;
}
