import { OpenTerminalRequest, Slug } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError, validateBody } from "../http";
import { TerminalConflict, Terminals } from "../terminals";
import { Tmux } from "../tmux";

export function createTerminalsRoute(context: RouteContext) {
  const terminals = new Terminals(context.state, new Tmux(context.config.tmuxSocket));
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/workspaces\/([^/]+)\/terminals$/.exec(new URL(request.url).pathname);
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
