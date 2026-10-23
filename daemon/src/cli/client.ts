import { ApiError } from "@outscaled/protocol";
import { parsePort } from "../config";

export const serverOptions = {
  on: { type: "string", default: "local" },
  json: { type: "boolean", default: false },
} as const;

export function createClient(server = "local", env: NodeJS.ProcessEnv = process.env) {
  if (server !== "local") throw new Error("remote servers aren't supported yet; use --on local");
  const address = `http://127.0.0.1:${parsePort(env.WSD_PORT)}`;

  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      let response: Response;
      let raw: string;
      try {
        response = await fetch(`${address}${path}`, {
          method,
          headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(3000),
        });
        raw = await response.text();
      } catch {
        throw new Error(`wsd isn't reachable at ${address}`);
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
    },
  };
}
