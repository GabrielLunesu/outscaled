import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { FsOperation, FsWriteOptions, Slug, type FsEntry, type FsStat } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError } from "../http";

class FsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function inside(root: string, path: string): void {
  const child = relative(root, path);
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
    throw new FsError(403, "forbidden", "Path must stay inside the workspace");
  }
}

function segments(path: string): string[] {
  let parts: string[];
  try { parts = path.split("/").map(part => decodeURIComponent(part)); }
  catch { throw new FsError(400, "invalid_request", "Invalid path encoding"); }
  if (parts.some(part => part === "." || part === ".." || /[/\\\0]/.test(part)) ||
    path.startsWith("/") || /^[a-z]:/i.test(parts[0] ?? "")) {
    throw new FsError(400, "invalid_request", "Path must be relative, without traversal, backslashes or NUL bytes");
  }
  return parts.filter(part => part !== "");
}

// Resolve each existing component before accessing it. For a new write, the
// remaining suffix is relative to the deepest existing, contained parent.
// A dangling symlink fails realpath rather than becoming a creatable filename.
async function target(root: string, parts: string[], writing = false): Promise<{ path: string; symlink: boolean }> {
  let path = root;
  let symlink = false;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let info: Stats;
    try { info = await lstat(path); }
    catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path: join(path, ...parts.slice(index + 1)), symlink: false };
    }
    symlink = info.isSymbolicLink();
    path = await realpath(path);
    inside(root, path);
  }
  return { path, symlink };
}

function fileType(info: Stats): FsStat["type"] {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  throw new FsError(403, "forbidden", "Only regular files and directories are supported");
}

function filesystemError(error: unknown): Response {
  if (error instanceof FsError) return apiError(error.status, error.code, error.message);
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT": return apiError(404, "not_found", "File or directory not found");
    case "EEXIST": return apiError(409, "exists", "File already exists");
    case "EISDIR": return apiError(400, "is_directory", "Path is a directory");
    case "ENOTDIR": return apiError(400, "not_directory", "Path is not a directory");
    case "EPERM": case "EACCES": case "ELOOP":
      return apiError(403, "forbidden", "Path is not accessible");
    case "ENAMETOOLONG": case "EINVAL":
      return apiError(400, "invalid_request", "Invalid filesystem path");
    default: throw error;
  }
}

async function write(request: Request, path: string, options: FsWriteOptions): Promise<Response> {
  try {
    const info = await stat(path);
    if (fileType(info) === "directory") throw new FsError(400, "is_directory", "Path is a directory");
    if (!options.overwrite) throw new FsError(409, "exists", "File already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.create) throw error;
  }
  const flags = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW |
    (options.create ? constants.O_CREAT : 0) | (options.overwrite ? 0 : constants.O_EXCL);
  const handle = await open(path, flags, 0o666);
  try {
    if (request.body) {
      for await (const chunk of request.body) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      }
    }
  } finally { await handle.close(); }
  return new Response(null, { status: 204 });
}

export function createFsRoute({ state }: Pick<RouteContext, "state">) {
  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET" && request.method !== "PUT") return;
    const match = /^https?:\/\/[^/]+\/v1\/fs\/([^/?]+)(?:\/([^?]*))?(?:\?|$)/.exec(request.url);
    if (!match) return;
    try {
      const slug = decodeURIComponent(match[1]!);
      if (!Slug.safeParse(slug).success) throw new FsError(400, "invalid_request", "Invalid workspace slug");
      const parts = segments(match[2] ?? "");
      const workspace = state.getWorkspace(slug);
      if (!workspace) throw new FsError(404, "not_found", "Workspace not found");
      const query = new URL(request.url).searchParams;
      const operation = FsOperation.safeParse(query.get("op") ?? undefined);
      const boolean = (key: string) => {
        const value = query.get(key);
        return value === null ? undefined : value === "true" ? true : value === "false" ? false : value;
      };
      const options = FsWriteOptions.safeParse({ create: boolean("create"), overwrite: boolean("overwrite") });
      if (request.method === "GET" ? !operation.success : !options.success) {
        throw new FsError(400, "invalid_request", "Invalid filesystem operation or write options");
      }
      const root = await realpath(workspace.path);
      const resolved = await target(root, parts, request.method === "PUT");
      if (request.method === "PUT") return await write(request, resolved.path, options.data!);
      const info = await stat(resolved.path);
      const type = fileType(info);
      if (operation.data === "stat") {
        return Response.json({ type, symlink: resolved.symlink, size: info.size,
          mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } satisfies FsStat);
      }
      if (operation.data === "list") {
        if (type !== "directory") throw new FsError(400, "not_directory", "Path is not a directory");
        const entries: FsEntry[] = [];
        for (const name of (await readdir(resolved.path)).sort()) {
          const symlink = (await lstat(join(resolved.path, name))).isSymbolicLink();
          try {
            const entry = await target(root, [...parts, name]);
            entries.push({ name, type: fileType(await stat(entry.path)), symlink: entry.symlink });
          } catch (error) {
            // Keep inaccessible links visible without following outside targets
            // for metadata or turning a dangling link into a writable file.
            if (!symlink || !(error instanceof FsError && error.code === "forbidden" ||
              (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
            entries.push({ name, type: "unknown", symlink: true });
          }
        }
        return Response.json(entries);
      }
      if (type === "directory") throw new FsError(400, "is_directory", "Path is a directory");
      const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (fileType(await handle.stat()) === "directory") throw new FsError(400, "is_directory", "Path is a directory");
        // Node and Bun declare different BYOB reader overloads for this stream.
        const body = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream;
        return new Response(body, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (error) { await handle.close(); throw error; }
    } catch (error) {
      if (error instanceof URIError) return apiError(400, "invalid_request", "Invalid path encoding");
      return filesystemError(error);
    }
  };
}
