import { expect, test } from "bun:test";
import { ApiError, CreateWorkspaceRequest, OpenTerminalRequest } from "@outscaled/protocol";
import { validateBody } from "../src/http";

function request(body: string) {
  return new Request("http://localhost/v1/workspaces", { method: "POST", body });
}

test("validateBody returns typed schema output after consuming the body", async () => {
  const input = request(JSON.stringify({ slug: "demo", path: "/example", ignored: true }));
  const workspace = await validateBody(input, CreateWorkspaceRequest);
  if (workspace instanceof Response) throw new Error("Expected a parsed workspace request");
  const slug: string = workspace.slug;
  expect(slug).toBe("demo");
  expect(workspace).toEqual({ slug: "demo", path: "/example" });
  expect(input.bodyUsed).toBe(true);

  const terminal = await validateBody(request('{"name":"shell","alwaysOn":true}'), OpenTerminalRequest);
  if (terminal instanceof Response) throw new Error("Expected a parsed terminal request");
  const alwaysOn: boolean | undefined = terminal.alwaysOn;
  expect(alwaysOn).toBe(true);
  expect(terminal.name).toBe("shell");
});

test("validateBody returns an ApiError response for malformed or invalid input", async () => {
  for (const body of ["{broken", '{"slug":"INVALID"}']) {
    const result = await validateBody(request(body), CreateWorkspaceRequest);
    if (!(result instanceof Response)) throw new Error("Expected an error response");
    expect(result.status).toBe(400);
    expect(ApiError.parse(await result.json()).error.code).toBe("invalid_request");
  }
});
