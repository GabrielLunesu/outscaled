import { expect, test } from "bun:test";
import { ClaudeCodeHookPayload, CodexHookPayload, LatestLine, StreamMessage, TerminalAnswerRequest, TerminalRequest } from "../src/index";

test("attention contracts validate request details, answers, hook text and live latest lines", () => {
  const request = { message: "Permission needed", permission: { question: "Do you want to proceed?", options: [{ number: 1, label: "Yes" }, { number: 4, label: "No" }] } };
  expect(TerminalRequest.parse(request)).toEqual(request);
  for (const answer of ["allow_once", "deny"]) expect(TerminalAnswerRequest.parse({ answer })).toEqual({ answer });
  for (const answer of ["allow", "yes", "no", 1, null]) expect(TerminalAnswerRequest.safeParse({ answer }).success).toBe(false);
  expect(TerminalAnswerRequest.safeParse({ answer: "deny", keys: ["2"] }).success).toBe(false);
  for (const value of ["", " x", "x\nline", "x".repeat(201)]) expect(LatestLine.safeParse(value).success).toBe(false);
  expect(LatestLine.parse(null)).toBeNull();
  const update = { type: "terminal.latest_line", workspace: "demo", terminal: "id", payload: { latestLine: "Hello" } };
  expect(StreamMessage.parse(update)).toEqual(update);
  expect(StreamMessage.safeParse({ ...update, payload: { latestLine: "x".repeat(201) } }).success).toBe(false);
  expect(ClaudeCodeHookPayload.parse({ hook_event_name: "Notification", message: "Waiting", transcript_path: "/example/transcript.jsonl", future: true })).toMatchObject({ future: true, message: "Waiting" });
  expect(CodexHookPayload.parse({ type: "agent-turn-complete", "last-assistant-message": "Done", future: true })).toMatchObject({ "last-assistant-message": "Done", future: true });
  expect(CodexHookPayload.safeParse({ type: "agent-turn-complete", "last-assistant-message": 1 }).success).toBe(false);
});
