import type { Config } from "./config";
import type { RouteContext } from "./context";
import { apiError } from "./http";
import { createHealthRoute } from "./routes/health";
import { createHooksRoute } from "./routes/hooks";
import { createTerminalsRoute } from "./routes/terminals";
import { createWorkspacesRoute } from "./routes/workspaces";
import { createRunsRoute } from "./routes/runs";
import { Schedules, type SchedulesOptions } from "./schedules";
import { State } from "./state";
import { Stream, type StreamOptions } from "./stream";
import { Supervisor, type SupervisorOptions } from "./supervisor";
import { Terminals, writeClaudeSettings } from "./terminals";
import { Tmux } from "./tmux";

export async function startServer(config: Config, supervisorOptions?: SupervisorOptions, schedulesOptions?: SchedulesOptions, streamOptions?: StreamOptions) {
  const stream = new Stream(streamOptions);
  const state = new State(config.statePath, message => stream.publish(message));
  try {
    const tmux = new Tmux(config.tmuxSocket);
    const launch = { claudeSettings: writeClaudeSettings(config.stateDir), port: config.port };
    const terminals = new Terminals(state, tmux, launch);
    await terminals.reconcile();
    const supervisor = new Supervisor(state, tmux, terminals, supervisorOptions);
    const context: RouteContext = { config, state, terminals };
    const schedules = new Schedules(state, config.stateDir, schedulesOptions);
    const health = createHealthRoute(context);
    const routes = [health, createWorkspacesRoute(context), createTerminalsRoute(context), createHooksRoute(context), createRunsRoute(context)];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/v1/stream") return stream.upgrade(request, server);
        return (async () => {
          for (const route of routes) {
            const response = await route(request, server.requestIP(request)?.address);
            if (response) return response;
          }
          return apiError(404, "not_found", "Route not found");
        })();
      },
      websocket: stream.websocket,
      error(error) {
        console.error("wsd: request failed", error);
        return apiError(500, "internal_error", "Internal server error");
      },
    });
    launch.port = server.port!;
    await schedules.start();
    supervisor.start();
    // Reuse the exact health collector, including its shared CPU sample and
    // uptime origin, without making an HTTP request to ourselves.
    stream.startHealth(async () => (await health(new Request("http://localhost/v1/health")))!.json());
    return {
      server,
      state,
      schedules,
      async stop() {
        await stream.stop();
        await schedules.stop();
        await supervisor.stop();
        // Bun 1.3.14 can leave this promise pending after a server-side WS
        // close, even though the socket is closed (oven-sh/bun#36223).
        // All sockets have been closed by stream.stop; bound the stale counter
        // wait and release the listener's event-loop reference as well.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopped = server.stop(true);
        server.unref();
        try {
          await Promise.race([stopped, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
        } finally { clearTimeout(timer); }
        state.close();
      },
    };
  } catch (error) {
    await stream.stop();
    state.close();
    throw error;
  }
}
