import type { Config } from "./config";
import type { RouteContext } from "./context";
import { apiError } from "./http";
import { createHealthRoute } from "./routes/health";
import { createTerminalsRoute } from "./routes/terminals";
import { createWorkspacesRoute } from "./routes/workspaces";
import { State } from "./state";

export function startServer(config: Config) {
  const state = new State(config.statePath);
  try {
    const context: RouteContext = { config, state };
    const routes = [createHealthRoute(context), createWorkspacesRoute(context), createTerminalsRoute(context)];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      async fetch(request) {
        for (const route of routes) {
          const response = await route(request);
          if (response) return response;
        }
        return apiError(404, "not_found", "Route not found");
      },
      error(error) {
        console.error("wsd: request failed", error);
        return apiError(500, "internal_error", "Internal server error");
      },
    });
    return {
      server,
      state,
      async stop() {
        await server.stop(true);
        state.close();
      },
    };
  } catch (error) {
    state.close();
    throw error;
  }
}
