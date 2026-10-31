import { ClaudeCodeHookRequest } from "@outscaled/protocol";
import { parsePort } from "../config";

export async function hook(args: string[]): Promise<void> {
  // This is a best-effort notification. In particular, stdout must stay empty:
  // Claude treats UserPromptSubmit stdout as additional model context.
  if (!process.env.WSD_TERMINAL || args.length !== 1 || args[0] !== "claude-code") return;
  const signal = AbortSignal.timeout(800);
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
    const port = parsePort(process.env.WSD_PORT);
    const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/claude-code`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      redirect: "error",
    });
    await response.body?.cancel();
  } catch {
    // Bad input, stale terminal ids and unavailable daemons must not block Claude.
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
