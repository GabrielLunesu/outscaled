import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CreateWorkspaceRequest, Workspace } from "@outscaled/protocol";
import { createClient, serverOptions } from "./client";

export async function newWorkspace(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...serverOptions,
      repo: { type: "string" },
      path: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new Error("usage: ws new <slug> [--repo <url> | --path <dir>] [--on <server>] [--json]");
  if (values.repo !== undefined && values.path !== undefined) throw new Error("--repo and --path are mutually exclusive");
  let path = values.path;
  if (path !== undefined) {
    if (!path || path.includes("\0")) throw new Error("--path must be a non-empty directory path without NUL bytes");
    if (values.on !== "local") {
      if (!path.startsWith("/")) throw new Error("remote --path must be an absolute server path (no ~ or relative paths)");
    } else {
      if (path === "~") path = homedir();
      else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
      path = resolve(path);
    }
  }
  if (values.repo !== undefined && (!values.repo.trim() || values.repo.includes("\0"))) {
    throw new Error("--repo must be a non-empty repository address without NUL bytes");
  }
  const input = CreateWorkspaceRequest.safeParse({ slug: positionals[0], repo: values.repo, path });
  if (!input.success) throw new Error("invalid workspace slug or options");
  const client = createClient(values.on);
  const data = await client.request("POST", "/v1/workspaces", input.data, 30 * 60 * 1000);
  const workspace = Workspace.parse(data);
  console.log(values.json ? JSON.stringify(data) : workspace.path);
}
