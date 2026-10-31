import { OpenTerminalRequest, Slug, TerminalInputRequest, TerminalOutputLines } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError, validateBody } from "../http";
import { TerminalConflict, TerminalNotFound } from "../terminals";

export function createTerminalsRoute(context: RouteContext) {
  const { terminals } = context;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const pane = /^\/v1\/workspaces\/([^/]+)\/terminals\/([^/]+)\/(input|output)$/.exec(path);
    if (pane && ((pane[3] === "input" && request.method === "POST") || (pane[3] === "output" && request.method === "GET"))) {
      const workspace = pane[1]!;
      const name = pane[2]!;
      if (!Slug.safeParse(workspace).success || !Slug.safeParse(name).success) {
        return apiError(400, "invalid_request", "Invalid workspace or terminal name");
      }
      try {
        if (pane[3] === "input") {
          const body = await validateBody(request, TerminalInputRequest);
          if (body instanceof Response) return body;
          return Response.json(await terminals.input(workspace, name, body));
        }
        const lines = TerminalOutputLines.safeParse(url.searchParams.has("lines") ? Number(url.searchParams.get("lines")) : undefined);
        if (!lines.success) return apiError(400, "invalid_request", "lines must be an integer from 1 to 5000");
        return Response.json({ text: await terminals.output(workspace, name, lines.data) });
      } catch (error) {
        if (error instanceof TerminalNotFound) return apiError(404, "not_found", error.message);
        if (error instanceof TerminalConflict) return apiError(409, "conflict", error.message);
        throw error;
      }
    }
    if (path === "/v1/terminals" && request.method === "GET") {
      const rows = (await Promise.all(context.state.listWorkspaces()
        .map(workspace => terminals.list(workspace.slug)))).flat();
      rows.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name));
      return Response.json(rows);
    }
    const match = /^\/v1\/workspaces\/([^/]+)\/terminals$/.exec(path);
    if (!match || (request.method !== "GET" && request.method !== "POST")) return;
    const workspace = match[1]!;
    if (!Slug.safeParse(workspace).success) {
      return apiError(400, "invalid_request", "Invalid workspace slug");
    }
    if (request.method === "POST") {
      const body = await validateBody(request, OpenTerminalRequest);
      if (body instanceof Response) return body;
      const row = context.state.getWorkspace(workspace);
      if (!row) return apiError(404, "not_found", "Workspace not found");
      try {
        return Response.json(await terminals.open(row, body), { status: 201 });
      } catch (error) {
        if (error instanceof TerminalConflict) return apiError(409, "conflict", error.message);
        throw error;
      }
    }
    if (!context.state.getWorkspace(workspace)) return apiError(404, "not_found", "Workspace not found");
    return Response.json(await terminals.list(workspace));
  };
}
