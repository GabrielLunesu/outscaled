import { Slug } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError } from "../http";

export function createChangesRoute({ state, terminals }: RouteContext) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/workspaces\/([^/]+)\/changes$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "GET") return;
    const slug = Slug.safeParse(match[1]);
    if (!slug.success) return apiError(400, "invalid_request", "Invalid workspace slug");
    const workspace = state.getWorkspace(slug.data);
    if (!workspace) return apiError(404, "not_found", "Workspace not found");
    return terminals.serial(async () => Response.json(await terminals.changes.list(workspace)));
  };
}
