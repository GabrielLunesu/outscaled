import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { ApiError, FsList, FsStat, FsWriteOptions, Workspace } from "@outscaled/protocol";
import { createFsRoute } from "../src/routes/fs";
import { startServer } from "../src/server";
import { fixture } from "./helpers";
import { localRepository } from "./workspace-helpers";

let f: ReturnType<typeof fixture>;
let app: Awaited<ReturnType<typeof startServer>>;
let base: string;
let root: string;
beforeEach(async () => {
  f = fixture();
  app = await startServer(f.config);
  base = `http://127.0.0.1:${app.server.port}`;
  root = join(f.root, "existing");
  mkdirSync(root);
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "text.txt"), "hello workspace\n");
  writeFileSync(join(root, "folder", "nested.txt"), "nested");
  symlinkSync("text.txt", join(root, "inside-link"));
  symlinkSync("folder", join(root, "folder-link"));
  const response = await fetch(`${base}/v1/workspaces`, {
    method: "POST", body: JSON.stringify({ slug: "demo", path: root }),
  });
  expect(response.status).toBe(201);
});
afterEach(async () => { await app.stop(); f.cleanup(); });

const get = (path = "", op?: string) => fetch(`${base}/v1/fs/demo/${path}${op ? `?op=${op}` : ""}`);
const put = (path: string, body: BodyInit | null = "written", query = "") =>
  fetch(`${base}/v1/fs/demo/${path}${query ? `?${query}` : ""}`, { method: "PUT", body });
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ApiError.parse(await response.json()).error.code).toBe(code);
}

function requestPath(path: string, method = "GET", body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: app.server.port, path, method }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
        status: response.statusCode,
      })));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("stat returns root, file, folder and contained symlink metadata", async () => {
  for (const [path, type, symlink, diskPath] of [
    ["", "directory", false, root],
    ["text.txt", "file", false, join(root, "text.txt")],
    ["folder", "directory", false, join(root, "folder")],
    ["inside-link", "file", true, join(root, "text.txt")],
    ["folder-link", "directory", true, join(root, "folder")],
  ] as const) {
    const response = await get(path, "stat");
    expect(response.status).toBe(200);
    const actual = FsStat.parse(await response.json());
    const expected = statSync(diskPath);
    expect(actual).toEqual({ type, symlink, size: expected.size, mtimeMs: expected.mtimeMs, ctimeMs: expected.ctimeMs });
  }
  expect((await fetch(`${base}/v1/fs/demo?op=stat`)).status).toBe(200);
  await error(await get("missing", "stat"), 404, "not_found");
});

test("list sorts names and reports file, directory and symlink types", async () => {
  const response = await get("", "list");
  expect(response.status).toBe(200);
  expect(FsList.parse(await response.json())).toEqual([
    { name: "folder", type: "directory", symlink: false },
    { name: "folder-link", type: "directory", symlink: true },
    { name: "inside-link", type: "file", symlink: true },
    { name: "text.txt", type: "file", symlink: false },
  ]);
  for (const path of ["folder", "folder-link"]) {
    expect(await (await get(path, "list")).json()).toEqual([{ name: "nested.txt", type: "file", symlink: false }]);
  }
  await error(await get("text.txt", "list"), 400, "not_directory");
});

test("reads text, binary, contained symlinks and segment-encoded filenames", async () => {
  const binary = new Uint8Array([0, 255, 128, 1, 13, 10]);
  writeFileSync(join(root, "binary"), binary);
  const name = "space # ? % café.txt";
  writeFileSync(join(root, "folder", name), "encoded name");
  const response = await get("text.txt");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(await response.text()).toBe("hello workspace\n");
  expect(await (await get("inside-link", "read")).text()).toBe("hello workspace\n");
  expect(new Uint8Array(await (await get("binary")).arrayBuffer())).toEqual(binary);
  expect(await (await get(`folder/${encodeURIComponent(name)}`)).text()).toBe("encoded name");
  await error(await get("folder"), 400, "is_directory");
  await error(await get("missing"), 404, "not_found");
  await error(await get("text.txt/child"), 400, "not_directory");
});

test("a large read delivers multiple chunks with all bytes intact", async () => {
  const data = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  writeFileSync(join(root, "large"), data);
  const response = await get("large");
  expect(response.status).toBe(200);
  const hash = createHash("sha256");
  let chunks = 0;
  let bytes = 0;
  for await (const chunk of response.body!) { chunks++; bytes += chunk.byteLength; hash.update(chunk); }
  expect(chunks).toBeGreaterThan(1);
  expect(bytes).toBe(data.length);
  expect(hash.digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
});

test("write creates and truncates files, preserves binary bytes and follows inside links", async () => {
  expect(FsWriteOptions.parse({})).toEqual({ create: true, overwrite: true });
  expect((await put("created", "new content")).status).toBe(204);
  expect(await (await get("created")).text()).toBe("new content");
  expect((await put("created", "short", "create=false&overwrite=true")).status).toBe(204);
  expect(readFileSync(join(root, "created"), "utf8")).toBe("short");
  const binary = new Uint8Array([255, 0, 128, 4]);
  expect((await put("folder/binary", binary, "create=true&overwrite=false")).status).toBe(204);
  expect(new Uint8Array(await (await get("folder/binary")).arrayBuffer())).toEqual(binary);
  expect((await put("inside-link", "via link")).status).toBe(204);
  expect(readFileSync(join(root, "text.txt"), "utf8")).toBe("via link");
  expect((await put("folder-link/new", "via folder")).status).toBe(204);
  expect(readFileSync(join(root, "folder", "new"), "utf8")).toBe("via folder");
  expect((await put("created", null)).status).toBe(204);
  expect(readFileSync(join(root, "created")).byteLength).toBe(0);
});

test("write consumes a chunked request as the full file contents", async () => {
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 255]));
      await Bun.sleep(10);
      controller.enqueue(new Uint8Array([128, 2]));
      controller.close();
    },
  });
  expect((await put("chunked", body)).status).toBe(204);
  expect(readFileSync(join(root, "chunked"))).toEqual(Buffer.from([0, 1, 255, 128, 2]));
});

test("write enforces create/overwrite flags and requires an existing parent", async () => {
  for (const query of ["create=false", "create=false&overwrite=false"]) {
    await error(await put("missing", "new", query), 404, "not_found");
  }
  for (const query of ["overwrite=false", "create=false&overwrite=false"]) {
    await error(await put("text.txt", "replace", query), 409, "exists");
  }
  expect(readFileSync(join(root, "text.txt"), "utf8")).toBe("hello workspace\n");
  expect(existsSync(join(root, "missing"))).toBe(false);
  await error(await put("missing/child"), 404, "not_found");
  await error(await put("text.txt/child"), 400, "not_directory");
  for (const path of ["", "folder", "folder-link"]) await error(await put(path), 400, "is_directory");
});

test("invalid operations, booleans, workspace slugs and encodings return JSON errors", async () => {
  for (const op of ["unknown", "", "READ"]) {
    await error(await fetch(`${base}/v1/fs/demo/text.txt?op=${op}`), 400, "invalid_request");
  }
  for (const query of ["create=1", "overwrite=no", "create=", "overwrite=True"]) {
    await error(await put("text.txt", "unchanged", query), 400, "invalid_request");
  }
  for (const path of ["%", "%FF", "%2Fetc/passwd", "/absolute", "C%3A/file", "bad%5Cpath", "bad%00path", "a%2Fb",
    "%2e%2e%2ftext.txt", "folder%2F..%2Ftext.txt", "%2e%2e%5ctext.txt", ".%2ftext.txt"]) {
    await error(await get(path), 400, "invalid_request");
    await error(await put(path), 400, "invalid_request");
  }
  await error(await fetch(`${base}/v1/fs/INVALID/file`), 400, "invalid_request");
  await error(await fetch(`${base}/v1/fs/unknown/file`), 404, "not_found");
  await error(await fetch(`${base}/v1/fs/unknown/file`, { method: "PUT", body: "new" }), 404, "not_found");
});

test("segment validation rejects dot segments before further URL parsing when exposed by the runtime", async () => {
  const route = createFsRoute(app);
  for (const path of ["./text.txt", "%2e/text.txt", "../text.txt", "%2e%2e/text.txt",
    "folder/../text.txt", "folder/%2E./text.txt", "folder/%2e/text.txt", "bad\\path"]) {
    for (const method of ["GET", "PUT"]) {
      const request = new Request(`${base}/v1/fs/demo/`, { method });
      // Request constructors normalize dot segments; exercise the route's raw
      // spelling validation separately from the runtime's URL handling.
      Object.defineProperty(request, "url", { value: `${base}/v1/fs/demo/${path}` });
      await error((await route(request))!, 400, "invalid_request");
    }
  }
});

test("Bun-normalized dot segments return only contained files or not_found", async () => {
  writeFileSync(join(root, "folder", "text.txt"), "nested text\n");
  const outside = join(f.root, "existing-outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "outside content");
  for (const part of ["..", "%2e%2e", ".", "%2e"]) {
    const response = await requestPath(`/v1/fs/demo/folder/${part}/text.txt`);
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) {
      expect(await response.text()).toBe(part === "." || part === "%2e" ? "nested text\n" : "hello workspace\n");
    } else await error(response, 404, "not_found");
  }
  for (const part of ["..", "%2e%2e"]) {
    const response = await requestPath(`/v1/fs/demo/folder/${part}/text.txt`, "PUT", "contained write");
    expect([204, 404]).toContain(response.status);
    expect(readFileSync(join(root, "text.txt"), "utf8")).toBe(response.status === 204 ? "contained write" : "hello workspace\n");
    if (response.status === 204) writeFileSync(join(root, "text.txt"), "hello workspace\n");
    for (const method of ["GET", "PUT"]) {
      await error(await requestPath(`/v1/fs/demo/${part}/existing-outside/secret`, method, method === "PUT" ? "blocked" : undefined),
        404, "not_found");
    }
  }
  expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside content");
});

test("outside symlinks and symlinked parents cannot be read, listed, statted or written through", async () => {
  const outside = join(f.root, "existing-outside"); // Shares the root's prefix.
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "outside content");
  symlinkSync(join(outside, "secret"), join(root, "outside-file"));
  symlinkSync(outside, join(root, "outside-folder"));
  for (const path of ["outside-file", "outside-folder", "outside-folder/secret", "outside-folder/new", "outside-folder/missing/deep"]) {
    for (const op of ["stat", "list", "read"]) await error(await get(path, op), 403, "forbidden");
    await error(await put(path), 403, "forbidden");
  }
  expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside content");
  expect(existsSync(join(outside, "new"))).toBe(false);
  expect(existsSync(join(outside, "missing"))).toBe(false);
});

test("dangling symlinks never create their missing targets", async () => {
  symlinkSync(join(f.root, "missing-outside"), join(root, "dangling-outside"));
  symlinkSync("missing-inside", join(root, "dangling-inside"));
  for (const path of ["dangling-outside", "dangling-inside", "dangling-outside/child", "dangling-inside/child"]) {
    for (const op of ["stat", "list", "read"]) await error(await get(path, op), 404, "not_found");
    await error(await put(path), 404, "not_found");
  }
  expect(existsSync(join(f.root, "missing-outside"))).toBe(false);
  expect(existsSync(join(root, "missing-inside"))).toBe(false);
});

test("list includes outside and dangling symlinks as unknown while preserving contained link types", async () => {
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "outside content");
  symlinkSync(join(outside, "secret"), join(root, "outside-file"));
  symlinkSync(outside, join(root, "outside-folder"));
  symlinkSync("missing", join(root, "dangling"));
  symlinkSync(join(f.root, "missing-outside"), join(root, "dangling-outside"));
  const response = await get("", "list");
  expect(response.status).toBe(200);
  expect(FsList.parse(await response.json())).toEqual([
    { name: "dangling", type: "unknown", symlink: true },
    { name: "dangling-outside", type: "unknown", symlink: true },
    { name: "folder", type: "directory", symlink: false },
    { name: "folder-link", type: "directory", symlink: true },
    { name: "inside-link", type: "file", symlink: true },
    { name: "outside-file", type: "unknown", symlink: true },
    { name: "outside-folder", type: "unknown", symlink: true },
    { name: "text.txt", type: "file", symlink: false },
  ]);
});

test("registered and cloned folders expose the same filesystem operations", async () => {
  const response = await fetch(`${base}/v1/workspaces`, {
    method: "POST", body: JSON.stringify({ slug: "cloned", repo: localRepository(f.root) }),
  });
  expect(response.status).toBe(201);
  const cloned = Workspace.parse(await response.json());
  expect(cloned.inPlace).toBe(false);
  expect(app.state.getWorkspace("demo")!.inPlace).toBe(true);
  for (const ws of ["demo", "cloned"]) {
    const url = `${base}/v1/fs/${ws}/`;
    expect(FsStat.parse(await (await fetch(`${url}?op=stat`)).json()).type).toBe("directory");
    expect((await fetch(`${url}client.txt`, { method: "PUT", body: "edited" })).status).toBe(204);
    expect(await (await fetch(`${url}client.txt`)).text()).toBe("edited");
    expect(FsList.parse(await (await fetch(`${url}?op=list`)).json())).toContainEqual({
      name: "client.txt", type: "file", symlink: false,
    });
  }
});
