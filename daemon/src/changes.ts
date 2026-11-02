import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangedFile, ClaudeCodeHookPayload, Terminal, Workspace, WorkspaceChanges } from "@outscaled/protocol";
import type { State } from "./state";

export const SNAPSHOT_PATH_LIMIT = 1000;
export const SNAPSHOT_FILE_SIZE_LIMIT = 1024 * 1024;
type Change = Omit<ChangedFile, "agents"> & { code: string };
export interface Snapshot { capped: boolean; fingerprints: Map<string, string> }

async function git(folder: string, args: string[]): Promise<{ code: number; output: string; error: string }> {
  const child = Bun.spawn(["git", "-C", folder, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output, error };
  } finally { clearTimeout(timer); }
}

// Porcelain -z is unquoted, destination first for renames, including paths with
// tabs/newlines. --untracked-files=all lists files rather than directory groups.
export function parseStatus(output: string, prefix = ""): Change[] {
  const entries = output.split("\0");
  const files: Change[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const original = /[RC]/.test(code) ? entries[++index] ?? null : null;
    if (!path.startsWith(prefix)) continue;
    files.push({
      path: path.slice(prefix.length), originalPath: original?.startsWith(prefix) ? original.slice(prefix.length) : null, code,
      status: code === "??" ? "untracked" : code.includes("R") ? "renamed" : code.includes("D") ? "deleted" : code.includes("A") || code.includes("C") ? "added" : "modified",
    });
  }
  return files;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

// Check the deepest existing ancestor too, so missing paths through an outside
// symlink cannot enter attribution. Keep the lexical path to match git status.
async function contained(root: string, path: string): Promise<boolean> {
  if (!inside(root, path)) return false;
  let ancestor = path;
  while (true) {
    try { return inside(await realpath(root), await realpath(ancestor)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}

async function fingerprint(root: string, file: Change, sizeLimit: number): Promise<string> {
  const path = join(root, file.path);
  let content: string;
  try {
    // Never read outside symlinks (including a symlink in a parent directory).
    if (!await contained(root, dirname(path))) return `${file.code}:outside`;
    const info = await lstat(path);
    const metadata = `${info.size}:${info.mtimeMs}:${info.mode}`;
    if (info.isSymbolicLink()) content = `link:${await readlink(path)}`;
    else if (!info.isFile() || info.size > sizeLimit) content = `metadata:${metadata}`;
    else {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        // Bound allocation/read even if a file grows after lstat.
        const buffer = Buffer.alloc(sizeLimit + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        content = length > sizeLimit ? `metadata:${metadata}` : `sha256:${createHash("sha256").update(buffer.subarray(0, length)).digest("hex")}:${info.mode}`;
      } finally { await handle.close(); }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") console.error(`wsd: change snapshot could not read ${file.path}: ${code}`);
    content = `missing:${code}`;
  }
  return `${file.code}:${file.originalPath ?? ""}:${content}`;
}

export class Changes {
  private readonly turns = new Map<string, Snapshot>();
  constructor(private readonly state: State, private readonly limits = { paths: SNAPSHOT_PATH_LIMIT, fileSize: SNAPSHOT_FILE_SIZE_LIMIT }) {}

  private async status(workspace: Workspace): Promise<Change[] | null> {
    const prefix = await git(workspace.path, ["rev-parse", "--show-prefix"]);
    if (prefix.code !== 0) {
      // A plain folder is expected; other git failures must not prune records.
      if (prefix.error.includes("not a git repository")) return null;
      throw new Error(`Git repository check failed: ${prefix.error.trim()}`);
    }
    const result = await git(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames", "--", "."]);
    if (result.code !== 0) throw new Error(`Git status failed: ${result.error.trim()}`);
    const files = parseStatus(result.output, prefix.output.replace(/\n$/, ""));
    this.state.pruneChanges(workspace.slug, new Set(files.map(file => file.path)), files.filter(file => file.status === "renamed"));
    return files;
  }

  async list(workspace: Workspace): Promise<WorkspaceChanges> {
    const files = await this.status(workspace);
    if (files === null) return { attributionAvailable: false, files: [] };
    const agents = this.state.changeAttributions(workspace.slug);
    return { attributionAvailable: true, files: files.map(({ code, ...file }) => ({ ...file, agents: agents.get(file.path) ?? [] }))
      .sort((a, b) => (b.agents[0]?.time ?? "").localeCompare(a.agents[0]?.time ?? "") || a.path.localeCompare(b.path)) };
  }

  async snapshot(workspace: Workspace): Promise<Snapshot | null> {
    const files = await this.status(workspace);
    if (files === null) return null;
    if (files.length > this.limits.paths) console.error(`wsd: change snapshot path cap hit (${this.limits.paths} of ${files.length}) for ${workspace.slug}`);
    const fingerprints = new Map<string, string>();
    for (const file of files.slice(0, this.limits.paths)) fingerprints.set(file.path, await fingerprint(workspace.path, file, this.limits.fileSize));
    return { capped: files.length > this.limits.paths, fingerprints };
  }

  async startTurn(terminal: Pick<Terminal, "id" | "workspace">): Promise<void> {
    this.turns.delete(terminal.id);
    const workspace = this.state.getWorkspace(terminal.workspace);
    if (!workspace) return;
    try {
      const snapshot = await this.snapshot(workspace);
      if (snapshot) this.turns.set(terminal.id, snapshot);
    } catch (error) { console.error("wsd: starting change snapshot failed", error); }
  }

  forgetTurn(id: string): void { this.turns.delete(id); }

  async endTurn(terminal: Terminal): Promise<void> {
    const before = this.turns.get(terminal.id);
    this.turns.delete(terminal.id);
    const workspace = this.state.getWorkspace(terminal.workspace);
    if (!workspace) return;
    try {
      const after = before ? await this.snapshot(workspace) : null;
      if (before && after) {
        for (const [path, hash] of after.fingerprints) {
          // A path omitted by the baseline cap is unknown, not newly created.
          if ((before.fingerprints.has(path) || !before.capped) && before.fingerprints.get(path) !== hash) {
            this.record(terminal, path, true);
          }
        }
      }
    } catch (error) { console.error("wsd: finishing change snapshot failed", error); }
    this.state.notifyChanges(workspace.slug);
  }

  async claudeEdit(terminal: Terminal, payload: ClaudeCodeHookPayload): Promise<void> {
    if (payload.hook_event_name !== "PostToolUse" || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(payload.tool_name ?? "")) return;
    const input = payload.tool_input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const value = (input as Record<string, unknown>)[payload.tool_name === "NotebookEdit" ? "notebook_path" : "file_path"];
    if (typeof value !== "string" || !value || value.includes("\0")) return;
    const workspace = this.state.getWorkspace(terminal.workspace);
    if (!workspace) return;
    try {
      const root = await realpath(workspace.path);
      // Registered folders may themselves be symlinks. Accept both the launch
      // path and the physical cwd an agent reports, retaining git-relative names.
      let path: string;
      try { path = await realpath(resolve(workspace.path, value)); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        throw error;
      }
      if (!inside(root, path)) return;
      const files = await this.status(workspace);
      const name = relative(root, path);
      if (files?.some(file => file.path === name)) {
        this.record(terminal, name, false);
      }
      // An edit that restores a clean file still needs to remove it in clients.
      if (files !== null) this.state.notifyChanges(workspace.slug);
    } catch (error) { console.error("wsd: recording Claude edit failed", error); }
  }

  private record(terminal: Terminal, path: string, inferred: boolean): void {
    if (!terminal.runtime) return;
    this.state.recordChange(terminal.workspace, path, { terminal: terminal.name, runtime: terminal.runtime, time: new Date().toISOString(), inferred });
  }
}
