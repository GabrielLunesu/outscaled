import { CreateWorkspaceRequest } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { notImplemented, validateBody } from "../http";

export function createWorkspacesRoute(context: RouteContext) {
  return async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== "/v1/workspaces") return;
    if (request.method !== "GET" && request.method !== "POST") return;
    if (request.method === "POST") {
      const body = await validateBody(request, CreateWorkspaceRequest);
      if (body instanceof Response) return body;
    }
    return notImplemented();
  };
}
