import type { Config } from "./config";
import type { RouteContext } from "./context";
import { apiError } from "./http";
import { createHealthRoute } from "./routes/health";
import { createTerminalsRoute } from "./routes/terminals";
import { createWorkspacesRoute } from "./routes/workspaces";
import { State } from "./state";
import { Supervisor, type SupervisorOptions } from "./supervisor";
import { Terminals } from "./terminals";
import { Tmux } from "./tmux";

export async function startServer(config: Config, supervisorOptions?: SupervisorOptions) {
  const state = new State(config.statePath);
  try {
    const tmux = new Tmux(config.tmuxSocket);
    const terminals = new Terminals(state, tmux);
    await terminals.reconcile();
    const supervisor = new Supervisor(state, tmux, terminals, supervisorOptions);
    const context: RouteContext = { config, state, terminals };
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
    supervisor.start();
    return {
      server,
      state,
      async stop() {
        await supervisor.stop();
        await server.stop(true);
        state.close();
      },
    };
  } catch (error) {
    state.close();
    throw error;
  }
}
