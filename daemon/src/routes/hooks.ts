import { ClaudeCodeHookRequest, type ClaudeCodeHookPayload, type TerminalStatus } from "@outscaled/protocol";
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

export function createHooksRoute({ state, terminals }: RouteContext) {
  return async (request: Request, peerAddress?: string): Promise<Response | undefined> => {
    const match = /^\/v1\/hooks\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "POST") return;
    // Use the socket peer, never Host or forwarding headers supplied by clients.
    if (!peerAddress || !/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(peerAddress)) {
      return apiError(403, "forbidden", "Hooks are accepted only from loopback");
    }
    if (match[1] !== "claude-code") return apiError(400, "invalid_runtime", "Unsupported hook runtime");
    const body = await validateBody(request, ClaudeCodeHookRequest);
    if (body instanceof Response) return body;
    return terminals.serial(async () => {
      const terminal = state.getTerminal(body.terminal);
      if (!terminal) return apiError(404, "not_found", "Terminal not found");
      if (terminal.runtime !== "claude-code") return apiError(409, "runtime_mismatch", "Terminal runtime does not match hook runtime");
      const status = claudeStatus(body.payload);
      if (status) state.updateTerminalStatus(terminal.id, status);
      return new Response(null, { status: 204 });
    });
  };
}
