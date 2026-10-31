import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ScheduledAgent } from "@outscaled/protocol";

export function intervalMs(every: string): number {
  return Number(every.slice(0, -1)) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[every.at(-1)!]!);
}

export function parseWorkspaceConfig(text: string): { agents: ScheduledAgent[]; errors: string[] } {
  const agents: ScheduledAgent[] = [];
  const errors: string[] = [];
  let file: Record<string, unknown>;
  try { file = Bun.TOML.parse(text) as Record<string, unknown>; }
  catch { return { agents, errors: ["invalid workspace.toml"] }; }
  if (file.agent === undefined) return { agents, errors };
  if (!Array.isArray(file.agent)) return { agents, errors: ["agent must be an array of tables"] };
  // Names belong to the workspace, including entries in other modes.
  const names = new Map<unknown, number>();
  for (const entry of file.agent) {
    if (entry && typeof entry === "object" && typeof entry.name === "string") {
      names.set(entry.name, (names.get(entry.name) ?? 0) + 1);
    }
  }
  for (const [index, entry] of file.agent.entries()) {
    if (!entry || typeof entry !== "object" || entry.mode !== "scheduled") continue;
    const parsed = ScheduledAgent.safeParse(entry);
    if (!parsed.success) errors.push(`agent[${index}]: ${parsed.error.issues[0]?.message ?? "invalid scheduled agent"}`);
    else if (names.get(parsed.data.name)! > 1) errors.push(`agent[${index}]: duplicate name ${parsed.data.name}`);
    else agents.push(parsed.data);
  }
  return { agents, errors };
}

export async function promptFile(workspacePath: string, prompt: string): Promise<string> {
  const root = await realpath(join(workspacePath, ".ws"));
  const path = await realpath(resolve(root, prompt));
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) {
    throw new Error("Prompt must stay inside .ws/ (including symlinks)");
  }
  if (!(await stat(path)).isFile()) throw new Error("Prompt must be a file");
  return path;
}

export async function readWorkspaceConfig(path: string): Promise<ReturnType<typeof parseWorkspaceConfig>> {
  let text: string;
  try { text = await readFile(join(path, ".ws/workspace.toml"), "utf8"); }
  catch (error) {
    return { agents: [], errors: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : ["cannot read workspace.toml"] };
  }
  const parsed = parseWorkspaceConfig(text);
  const agents: ScheduledAgent[] = [];
  for (const agent of parsed.agents) {
    try {
      if (agent.runtime !== "script") await promptFile(path, agent.prompt);
      agents.push(agent);
    } catch {
      parsed.errors.push(`${agent.name}: prompt must be an existing file inside .ws/`);
    }
  }
  return { agents, errors: parsed.errors };
}
