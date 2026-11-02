import { CreateScheduleRequest, Slug, UpdateScheduleRequest } from "@outscaled/protocol";
import type { RouteContext } from "../context";
import { apiError, validateBody } from "../http";
import { ScheduleError, type Schedules } from "../schedules";

export function createSchedulesRoute({ state }: RouteContext, schedules: Schedules) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/workspaces\/([^/]+)\/schedules(?:\/([^/]+)(?:\/(run|pause|resume))?)?$/.exec(new URL(request.url).pathname);
    if (!match) return;
    const [, slug, name, action] = match;
    const method = request.method;
    if (action ? method !== "POST" : name ? !["PATCH", "DELETE"].includes(method) : !["GET", "POST"].includes(method)) return;
    if (!Slug.safeParse(slug).success || (name && !Slug.safeParse(name).success)) {
      return apiError(400, "invalid_request", "Invalid workspace or schedule name");
    }
    const workspace = state.getWorkspace(slug!);
    if (!workspace) return apiError(404, "not_found", "Workspace not found");
    try {
      if (action === "run") return Response.json(await schedules.run(workspace, name!), { status: 201 });
      if (action) return Response.json(await schedules.pause(workspace, name!, action === "pause"));
      if (method === "DELETE") {
        await schedules.delete(workspace, name!);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const body = await validateBody(request, UpdateScheduleRequest);
        if (body instanceof Response) return body;
        return Response.json(await schedules.update(workspace, name!, body));
      }
      if (method === "POST") {
        const body = await validateBody(request, CreateScheduleRequest);
        if (body instanceof Response) return body;
        return Response.json(await schedules.create(workspace, body), { status: 201 });
      }
      return Response.json(await schedules.list(workspace));
    } catch (error) {
      if (error instanceof ScheduleError) return apiError(error.status, error.status === 404 ? "not_found" : "conflict", error.message);
      throw error;
    }
  };
}
