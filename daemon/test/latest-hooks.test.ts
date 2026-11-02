import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHooksRoute } from "../src/routes/hooks";
import { State } from "../src/state";
import { Terminals } from "../src/terminals";
import { Tmux } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let state: State;
let route: ReturnType<typeof createHooksRoute>;
beforeEach(() => {
  f = fixture(); state = new State(f.config.statePath);
  state.insertWorkspace(workspace);
  state.insertTerminal({ ...terminal, runtime: "codex" });
  route = createHooksRoute({ config: f.config, state, terminals: new Terminals(state, new Tmux(f.config.tmuxSocket)) });
});
afterEach(() => { state.close(); f.cleanup(); });
const post = (runtime: string, payload: unknown) => route(new Request(`http://localhost/v1/hooks/${runtime}`, {
  method: "POST", body: JSON.stringify({ terminal: terminal.id, payload }),
}), "127.0.0.1");

test("Codex notify extracts last-assistant-message; missing/empty and future events preserve latest text", async () => {
  expect((await post("codex", { type: "future", "last-assistant-message": "not complete" }))?.status).toBe(204);
  expect(state.getTerminal(terminal.id)?.latestLine).toBeNull();
  expect((await post("codex", { type: "agent-turn-complete", "last-assistant-message": "first\n  final reply  \n", future: true }))?.status).toBe(204);
  expect(state.getTerminal(terminal.id)).toMatchObject({ latestLine: "final reply", status: "idle" });
  for (const payload of [{ type: "agent-turn-complete" }, { type: "agent-turn-complete", "last-assistant-message": " \n" }]) {
    expect((await post("codex", payload))?.status).toBe(204);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("final reply");
  }
  expect((await post("codex", { type: "agent-turn-complete", "last-assistant-message": 42 }))?.status).toBe(400);
});

test("every Claude hook reads its transcript, even an event without a status transition", async () => {
  state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
  const path = join(f.root, "transcript.jsonl");
  for (const [index, event] of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "FutureEvent", "Stop"].entries()) {
    writeFileSync(path, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `assistant ${index}` }] } }) + "\n");
    expect((await post("claude-code", { hook_event_name: event, transcript_path: path }))?.status).toBe(204);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe(`assistant ${index}`);
  }
  expect((await post("claude-code", { hook_event_name: "Stop", transcript_path: join(f.root, "missing") }))?.status).toBe(204);
  expect(state.getTerminal(terminal.id)?.latestLine).toBe("assistant 5");
});
