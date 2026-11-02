import { expect, test } from "bun:test";
import { ChangeAttribution, ClaudeCodeHookPayload, StreamMessage, WorkspaceChanges } from "../src/index";

test("changed files, attribution and refetch events validate", () => {
  const agent = { terminal: "claude-1", runtime: "claude-code", time: "2026-01-01T00:00:00.000Z", inferred: false };
  for (const status of ["modified", "added", "deleted", "renamed", "untracked"]) {
    const response = { attributionAvailable: true, files: [{ path: "new", originalPath: status === "renamed" ? "old" : null, status, agents: [agent] }] };
    expect(WorkspaceChanges.parse(response)).toEqual(response);
  }
  expect(WorkspaceChanges.parse({ attributionAvailable: false, files: [] })).toEqual({ attributionAvailable: false, files: [] });
  expect(ChangeAttribution.safeParse({ ...agent, runtime: "shell" }).success).toBe(false);
  expect(ChangeAttribution.safeParse({ ...agent, inferred: "true" }).success).toBe(false);
  const event = { type: "workspace.changes", workspace: "demo" };
  expect(StreamMessage.parse(event)).toEqual(event);
  expect(StreamMessage.safeParse({ ...event, workspace: "../escape" }).success).toBe(false);
  const payload = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "relative" }, future: true };
  expect(ClaudeCodeHookPayload.parse(payload)).toEqual(payload);
});
