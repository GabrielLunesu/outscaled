import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CreateWorkspaceRequest, Workspace } from "@outscaled/protocol";
import type { RouteContext } from "./context";

export class WorkspaceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

async function clone(repo: string, path: string): Promise<void> {
  try {
    const child = Bun.spawn(["git", "clone", "--", repo, path], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) {
      const lastLine = stderr.trim().split(/[\r\n]+/).at(-1);
      throw new Error(lastLine || `git exited with status ${code}`);
    }
  } catch (error) {
    throw new WorkspaceError(500, "clone_failed", `Git clone failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createWorkspaceManager({ config, state }: RouteContext) {
  // Reserve pending clones without exposing incomplete workspaces in the database.
  const pendingSlugs = new Set<string>();
  const pendingPaths = new Set<string>();
  const conflict = (message: string): never => { throw new WorkspaceError(409, "conflict", message); };

  return {
    async create(input: CreateWorkspaceRequest): Promise<Workspace> {
      if (input.repo !== undefined && (!input.repo.trim() || input.repo.includes("\0"))) {
        throw new WorkspaceError(400, "invalid_request", "repo must be a non-empty repository address");
      }
      let path: string;
      if (input.path !== undefined) {
        if (!isAbsolute(input.path) || input.path.includes("\0")) {
          throw new WorkspaceError(400, "invalid_request", "path must be an absolute path to an existing directory");
        }
        path = resolve(input.path);
        try {
          if (!statSync(path).isDirectory()) throw new WorkspaceError(400, "invalid_request", "path must be an existing directory");
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw new WorkspaceError(400, "invalid_request", "path must be an existing directory");
          }
          throw error;
        }
      } else {
        path = join(config.workspacesDir, input.slug);
      }

      if (state.getWorkspace(input.slug) || pendingSlugs.has(input.slug)) conflict("Workspace slug is already taken");
      const canonical = input.path === undefined
        ? join(canonicalPath(config.workspacesDir), input.slug)
        : canonicalPath(path);
      if (pendingPaths.has(canonical) || state.listWorkspaces().some(ws => canonicalPath(ws.path) === canonical)) {
        conflict("Path is already registered by another workspace");
      }

      if (input.path === undefined) {
        mkdirSync(config.workspacesDir, { recursive: true });
        try {
          // Claim the target atomically, including for clones into an empty folder.
          mkdirSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") conflict("Workspace target folder already exists");
          throw error;
        }
      }
      pendingSlugs.add(input.slug);
      pendingPaths.add(canonical);
      try {
        if (input.repo !== undefined) await clone(input.repo, path);
        return state.insertWorkspace({
          slug: input.slug,
          path,
          repo: input.repo ?? null,
          inPlace: input.path !== undefined,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        if (input.path === undefined) rmSync(path, { recursive: true, force: true });
        throw error;
      } finally {
        pendingSlugs.delete(input.slug);
        pendingPaths.delete(canonical);
      }
    },
  };
}
