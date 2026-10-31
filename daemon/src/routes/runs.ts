import { readFile } from "node:fs/promises";
import { Slug } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError } from "../http";

export function createRunsRoute({ state }: Pick<RouteContext, "state">) {
  return async (request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET") return;
    const path = new URL(request.url).pathname;
    const workspace = /^\/v1\/workspaces\/([^/]+)\/runs$/.exec(path)?.[1];
    if (workspace !== undefined) {
      if (!Slug.safeParse(workspace).success) return apiError(400, "invalid_request", "Invalid workspace slug");
      if (!state.getWorkspace(workspace)) return apiError(404, "not_found", "Workspace not found");
      return Response.json(state.listRuns(workspace));
    }
    const id = /^\/v1\/runs\/([^/]+)\/log$/.exec(path)?.[1];
    if (id === undefined) return;
    const run = state.getRun(id);
    if (!run) return apiError(404, "not_found", "Run not found");
    try {
      return new Response(await readFile(run.logPath), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return apiError(404, "not_found", "Run log not found");
      }
      throw error;
    }
  };
}
