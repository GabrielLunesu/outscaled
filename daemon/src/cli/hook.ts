import { ClaudeCodeHookRequest, CodexHookRequest } from "@outscaled/protocol";
import { parsePort } from "../config";

export async function hook(args: string[]): Promise<void> {
  // This is a best-effort notification. In particular, stdout must stay empty:
  // Claude treats UserPromptSubmit stdout as additional model context.
  if (!process.env.WSD_TERMINAL) return;
  const runtime = args[0];
  if (runtime !== "claude-code" && runtime !== "codex") return;
  if (args.length !== (runtime === "codex" ? 2 : 1)) return;
  const signal = AbortSignal.timeout(800);
  if (runtime === "codex") {
    try {
      if (Buffer.byteLength(args[1]!) > 1024 * 1024) return;
      const body = CodexHookRequest.parse({ terminal: process.env.WSD_TERMINAL, payload: JSON.parse(args[1]!) });
      await forward(runtime, body, signal);
    } catch { /* Notify must never block or print into the agent's terminal. */ }
    return;
  }
  const reader = Bun.stdin.stream().getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) return;
      chunks.push(value);
    }
    signal.throwIfAborted();
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const body = ClaudeCodeHookRequest.parse({ terminal: process.env.WSD_TERMINAL, payload });
    await forward(runtime, body, signal);
  } catch {
    // Bad input, stale terminal ids and unavailable daemons must not block Claude.
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function forward(runtime: string, body: unknown, signal: AbortSignal): Promise<void> {
  const port = parsePort(process.env.WSD_PORT);
  const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/${runtime}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    redirect: "error",
  });
  await response.body?.cancel();
}
