import { OpenTerminalRequest, Slug } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError, notImplemented, validateBody } from "../http";

export function createTerminalsRoute(context: RouteContext) {
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
    }
    return notImplemented();
  };
}
