import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClient } from "../src/cli/client";

let server: ReturnType<typeof Bun.serve>;
let client: ReturnType<typeof createClient>;

beforeEach(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/error") {
        return Response.json({ error: { code: "conflict", message: "Workspace exists\nChoose another slug" } }, { status: 409 });
      }
      if (path === "/v1/malformed") return new Response("not JSON");
      if (path === "/v1/unexpected") return Response.json({ unexpected: true }, { status: 502 });
      return Response.json({ method: request.method, path, contentType: request.headers.get("content-type"), body: await request.text() });
    },
  });
  client = createClient("local", { WSD_PORT: String(server.port) });
});
afterEach(async () => { await server.stop(true); });

test("client sends method, path and optional JSON body and returns parsed JSON", async () => {
  expect(await client.request("POST", "/v1/workspaces", { slug: "demo" })).toEqual({
    method: "POST", path: "/v1/workspaces", contentType: "application/json", body: '{"slug":"demo"}',
  });
  expect(await client.request("GET", "/v1/workspaces")).toEqual({
    method: "GET", path: "/v1/workspaces", contentType: null, body: "",
  });
});

test("client turns ApiError responses into one-line errors", async () => {
  await expect(client.request("POST", "/v1/error", {})).rejects.toThrow("Workspace exists Choose another slug");
});

test("client reports invalid JSON and non-ApiError failures clearly", async () => {
  await expect(client.request("GET", "/v1/malformed")).rejects.toThrow("wsd returned invalid JSON (HTTP 200)");
  await expect(client.request("GET", "/v1/unexpected")).rejects.toThrow("wsd returned HTTP 502");
});

test("client rejects remote names and reports an unreachable local address", async () => {
  expect(() => createClient("example")).toThrow("remote servers aren't supported yet");
  const address = `http://127.0.0.1:${server.port}`;
  await server.stop(true);
  await expect(client.request("GET", "/v1/health")).rejects.toThrow(`wsd isn't reachable at ${address}`);
});
