import { ClaudeCodeHookRequest, CodexHookRequest, type ClaudeCodeHookPayload, type TerminalStatus } from "@outscaled/protocol";
import type { Schedules } from "../schedules";
import type { RouteContext } from "../context";
import { apiError, validateBody } from "../http";

export function claudeStatus(payload: ClaudeCodeHookPayload): TerminalStatus | null {
  switch (payload.hook_event_name) {
    case "SessionStart": case "Stop": return "idle";
    case "UserPromptSubmit": case "PreToolUse": case "PostToolUse": return "working";
    case "PermissionRequest": return "needs_input";
    case "Notification": return payload.notification_type === "permission_prompt" ? "needs_input" : null;
    default: return null;
  }
}

export function createHooksRoute({ state, terminals }: RouteContext, schedules?: Schedules) {
  return async (request: Request, peerAddress?: string): Promise<Response | undefined> => {
    const match = /^\/v1\/hooks\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "POST") return;
    // Use the socket peer, never Host or forwarding headers supplied by clients.
    if (!peerAddress || !/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(peerAddress)) {
      return apiError(403, "forbidden", "Hooks are accepted only from loopback");
    }
    const runtime = match[1];
    if (runtime !== "claude-code" && runtime !== "codex") return apiError(400, "invalid_runtime", "Unsupported hook runtime");
    const body = runtime === "codex"
      ? await validateBody(request, CodexHookRequest)
      : await validateBody(request, ClaudeCodeHookRequest);
    if (body instanceof Response) return body;
    return terminals.serial(async () => {
      const terminal = state.getTerminal(body.terminal);
      if (!terminal) return apiError(404, "not_found", "Terminal not found");
      if (terminal.runtime !== runtime) return apiError(409, "runtime_mismatch", "Terminal runtime does not match hook runtime");
      if (terminal.state !== "running") return new Response(null, { status: 204 });
      if (runtime === "codex") {
        if (body.payload.type === "agent-turn-complete") {
          terminals.codexTurnComplete(terminal.id);
          await schedules?.terminalIdle(terminal.id);
        }
      } else {
        const status = claudeStatus(ClaudeCodeHookRequest.parse(body).payload);
        if (status && !(body.payload.hook_event_name === "SessionStart" && schedules?.runningTerminal(terminal.id))) {
          state.updateTerminalStatus(terminal.id, status);
        }
        if (body.payload.hook_event_name === "Stop") await schedules?.terminalIdle(terminal.id);
      }
      return new Response(null, { status: 204 });
    });
  };
}
