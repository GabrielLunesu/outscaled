import { CreateWorkspaceRequest } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError, validateBody } from "../http";
import { createWorkspaceManager, WorkspaceError } from "../workspaces";

export function createWorkspacesRoute(context: RouteContext) {
  const workspaces = createWorkspaceManager(context);
  return async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== "/v1/workspaces") return;
    if (request.method !== "GET" && request.method !== "POST") return;
    if (request.method === "POST") {
      const body = await validateBody(request, CreateWorkspaceRequest);
      if (body instanceof Response) return body;
      try {
        return Response.json(await workspaces.create(body), { status: 201 });
      } catch (error) {
        if (error instanceof WorkspaceError) return apiError(error.status, error.code, error.message);
        throw error;
      }
    }
    return Response.json(context.state.listWorkspaces());
  };
}
