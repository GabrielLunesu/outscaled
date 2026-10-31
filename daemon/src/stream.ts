import { Health, StreamMessage } from "@outscaled/protocol";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { apiError } from "./http";

export interface StreamOptions {
  healthIntervalMs?: number;
}

export class Stream {
  private readonly clients = new Set<ServerWebSocket<undefined>>();
  private readonly healthIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private sampling?: Promise<void>;
  private stopped = false;

  constructor(options: StreamOptions = {}) {
    this.healthIntervalMs = options.healthIntervalMs ?? 15_000;
    if (!Number.isFinite(this.healthIntervalMs) || this.healthIntervalMs <= 0) {
      throw new Error("Invalid stream health interval");
    }
  }

  readonly websocket: WebSocketHandler<undefined> = {
    open: socket => {
      if (this.stopped) socket.close(1001, "Daemon stopping");
      else this.clients.add(socket);
    },
    close: socket => { this.clients.delete(socket); },
    message() {}, // This stream is broadcast-only; no subscriptions or replay.
    backpressureLimit: 64 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    sendPings: true,
  };

  upgrade(request: Request, server: Server<undefined>): Response | undefined {
    if (this.stopped) return apiError(503, "unavailable", "Daemon stopping");
    if (request.method !== "GET") return apiError(405, "method_not_allowed", "Use GET to open a WebSocket");
    if (server.upgrade(request)) return;
    return apiError(400, "websocket_required", "A WebSocket upgrade is required for /v1/stream");
  }

  publish(message: StreamMessage): void {
    if (this.stopped || !this.clients.size) return;
    const json = JSON.stringify(StreamMessage.parse(message));
    for (const socket of this.clients) {
      try {
        // Bun returns -1 for backpressure and 0 for a dropped send. Never
        // queue retries: reconnecting clients must fetch a fresh HTTP snapshot.
        if (socket.readyState !== 1 || socket.getBufferedAmount() > 0 || socket.send(json) <= 0) {
          this.drop(socket);
        }
      } catch {
        this.drop(socket);
      }
    }
  }

  private drop(socket: ServerWebSocket<undefined>): void {
    this.clients.delete(socket);
    socket.terminate();
  }

  startHealth(collect: () => Promise<Health>): void {
    this.timer = setInterval(() => {
      if (this.stopped || this.sampling || !this.clients.size) return;
      this.sampling = collect().then(payload => {
        this.publish({ type: "server.health", payload });
      }).catch(error => {
        console.error("wsd: stream health failed", error);
      }).finally(() => { this.sampling = undefined; });
    }, this.healthIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const socket of this.clients) socket.close(1001, "Daemon stopping");
    this.clients.clear();
    // Health reads SQLite after asynchronous CPU/disk sampling.
    await this.sampling;
  }
}
