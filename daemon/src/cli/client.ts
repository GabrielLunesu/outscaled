import { ApiError } from "@outscaled/protocol";
import { parsePort } from "../config";
import { validateSshTarget, withSshTunnel } from "./ssh";

export const serverOptions = {
  on: { type: "string", default: "local" },
  json: { type: "boolean", default: false },
} as const;

export function createClient(server = "local", env: NodeJS.ProcessEnv = process.env) {
  if (server !== "local") validateSshTarget(server);
  const port = parsePort(env.WSD_PORT);
  const address = `http://127.0.0.1:${port}`;

  return {
    async request(method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<unknown> {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (server !== "local") {
        return withSshTunnel(server, port, env, (unix, signal) => request(unix, signal));
      }
      return request();

      async function request(unix?: string, signal?: AbortSignal): Promise<unknown> {
        let response: Response;
        let raw: string;
        try {
          response = await fetch(`${unix ? "http://localhost" : address}${path}`, {
            unix,
            method,
            headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
            body: payload,
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
          });
          raw = await response.text();
        } catch {
          signal?.throwIfAborted();
          throw new Error(unix ? "remote wsd isn't reachable through SSH (request failed or timed out)" : `wsd isn't reachable at ${address}`);
        }
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`wsd returned invalid JSON (HTTP ${response.status})`);
        }
        if (!response.ok) {
          const error = ApiError.safeParse(data);
          throw new Error(error.success
            ? error.data.error.message.replace(/[\r\n]+/g, " ")
            : `wsd returned HTTP ${response.status}`);
        }
        return data;
      }
    },
  };
}
