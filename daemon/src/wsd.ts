import { loadConfig } from "./config";
import { startServer } from "./server";

export function runDaemon(): void {
  try {
    const app = startServer(loadConfig());
    console.log(`wsd listening on http://127.0.0.1:${app.server.port}`);
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void app.stop();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (error) {
    console.error(`wsd: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) runDaemon();
