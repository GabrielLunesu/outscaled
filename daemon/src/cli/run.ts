import { parseArgs } from "node:util";
import { ApiError, Run, Slug } from "@outscaled/protocol";
import { parsePort } from "../config";
import { createClient, serverOptions } from "./client";
import { validateSshTarget, withSshTunnel } from "./ssh";

// The shared command client expects JSON; logs are a plain-text response.
async function readLog(server: string, id: string): Promise<string> {
  if (server !== "local") validateSshTarget(server);
  const port = parsePort(process.env.WSD_PORT);
  const address = `http://127.0.0.1:${port}`;
  const request = async (unix?: string, signal?: AbortSignal) => {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${unix ? "http://localhost" : address}/v1/runs/${encodeURIComponent(id)}/log`, {
        unix, signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
      });
      text = await response.text();
    } catch {
      signal?.throwIfAborted();
      throw new Error(unix ? "remote wsd isn't reachable through SSH (request failed or timed out)" : `wsd isn't reachable at ${address}`);
    }
    if (!response.ok) {
      let error;
      try { error = ApiError.safeParse(JSON.parse(text)); } catch { /* Use HTTP status below. */ }
      throw new Error(error?.success ? error.data.error.message : `wsd returned HTTP ${response.status}`);
    }
    return text;
  };
  return server === "local" ? request() : withSshTunnel(server, port, process.env, request);
}

export async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: serverOptions });
  const [action, target] = positionals;
  if (positionals.length !== 2 || !target || (action !== "ls" && action !== "log")) {
    throw new Error("usage: ws run <ls <workspace> | log <run-id>> [--on <server>]");
  }
  if (action === "log") {
    if (values.json) throw new Error("usage: ws run log <run-id> [--on <server>]");
    if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error("Invalid run id");
    process.stdout.write(await readLog(values.on, target));
    return;
  }
  if (!Slug.safeParse(target).success) throw new Error("Invalid workspace slug");
  const runs = Run.array().parse(await createClient(values.on).request("GET", `/v1/workspaces/${target}/runs`));
  if (values.json) console.log(JSON.stringify(runs));
  else for (const row of runs) console.log([row.agent, row.status, row.startedAt, row.exitCode ?? "-", row.id].join("\t"));
}
