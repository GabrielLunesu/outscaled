import type { Config } from "./config";
import { apiError } from "./http";
import { createHealthRoute } from "./routes/health";
import { terminals } from "./routes/terminals";
import { workspaces } from "./routes/workspaces";
import { State } from "./state";

export function startServer(config: Config) {
  const startedAt = performance.now();
  const state = new State(config.statePath);
  const health = createHealthRoute(config, state, startedAt);
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/health" && request.method === "GET") return health();
        if (request.method === "GET" || request.method === "POST") {
          if (path === "/v1/workspaces") return workspaces(request);
          const match = /^\/v1\/workspaces\/([^/]+)\/terminals$/.exec(path);
          if (match) return terminals(request, match[1]!);
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
