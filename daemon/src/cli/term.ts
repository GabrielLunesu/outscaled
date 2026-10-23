import { parseArgs } from "node:util";
import { OpenTerminalRequest, Slug, Terminal } from "@outscaled/protocol";
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
  const client = createClient(values.on);
  const [action, workspace] = positionals;
  if ((action !== "open" && action !== "ls") || positionals.length !== 2) {
    throw new Error("usage: ws term <open | ls> <workspace> [options]");
  }
  if (!Slug.safeParse(workspace).success) throw new Error("Invalid workspace slug");
  const path = `/v1/workspaces/${workspace}/terminals`;
  if (action === "open") {
    const body = OpenTerminalRequest.safeParse({ name: values.name, command: values.cmd, alwaysOn: values["always-on"] });
    if (!body.success) throw new Error("usage: ws term open <workspace> --name <name> [--cmd <command>] [--always-on] [--on <server>] [--json]");
    const terminal = Terminal.parse(await client.request("POST", path, body.data));
    console.log(values.json ? JSON.stringify(terminal) : `${terminal.session}\nAttach: tmux attach -t ${terminal.session}`);
    return;
  }
  if (values.name !== undefined || values.cmd !== undefined || values["always-on"] !== undefined) {
    throw new Error("usage: ws term ls <workspace> [--on <server>] [--json]");
  }
  const terminals = Terminal.array().parse(await client.request("GET", path));
  if (values.json) console.log(JSON.stringify(terminals));
  else for (const terminal of terminals) {
    console.log([terminal.name, terminal.state, terminal.session, terminal.command.replace(/[\r\n]+/g, " ")].join("\t"));
  }
}
