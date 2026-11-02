import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHooksRoute } from "../src/routes/hooks";
import { State } from "../src/state";
import { Terminals } from "../src/terminals";
import { Tmux } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let state: State;
let terminals: Terminals;
let route: ReturnType<typeof createHooksRoute>;
beforeEach(() => {
  f = fixture(); state = new State(f.config.statePath);
  state.insertWorkspace(workspace);
  state.insertTerminal({ ...terminal, runtime: "codex" });
  terminals = new Terminals(state, new Tmux(f.config.tmuxSocket));
  route = createHooksRoute({ config: f.config, state, terminals });
});
afterEach(async () => { await terminals.stop(); state.close(); f.cleanup(); jest.useRealTimers(); });
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

const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
const tick = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  // Drain the timer's queued lifecycle operation, including the async file read.
  await terminals.serial(async () => {});
};

for (const event of ["Stop", "Notification"]) {
  test(`${event} responds before late assistant text and rereads until it appears`, async () => {
    jest.useFakeTimers();
    state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
    const path = join(f.root, "late.jsonl");
    writeFileSync(path, JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }, { type: "tool_use" }] } }) + "\n");
    const update = spyOn(state, "updateLatestLine");
    expect((await post("claude-code", { hook_event_name: event, transcript_path: path }))?.status).toBe(204);
    expect(state.getTerminal(terminal.id)?.latestLine).toBeNull();
    await tick(300);
    expect(update).not.toHaveBeenCalled();
    writeFileSync(path, assistant("I created hello.txt."));
    await tick(700);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("I created hello.txt.");
    // Success stops rereads: a later transcript write needs its own hook.
    writeFileSync(path, assistant("unannounced text"));
    await tick(2000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("I created hello.txt.");
  });
}

test("rereads unchanged text through the final attempt and then stops", async () => {
  jest.useFakeTimers();
  state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
  const path = join(f.root, "unchanged.jsonl");
  writeFileSync(path, assistant("previous turn"));
  await post("claude-code", { hook_event_name: "PreToolUse", transcript_path: path });
  await post("claude-code", { hook_event_name: "Stop", transcript_path: path });
  await tick(300);
  await tick(700);
  writeFileSync(path, assistant("arrived at last attempt"));
  await tick(2000);
  expect(state.getTerminal(terminal.id)?.latestLine).toBe("arrived at last attempt");
});

test("text never appears: retries are bounded and preserve the previous line", async () => {
  jest.useFakeTimers();
  state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
  const path = join(f.root, "empty.jsonl");
  writeFileSync(path, assistant("previous turn"));
  await post("claude-code", { hook_event_name: "PreToolUse", transcript_path: path });
  await post("claude-code", { hook_event_name: "Stop", transcript_path: path });
  for (const delay of [300, 700, 2000]) await tick(delay);
  expect(state.getTerminal(terminal.id)?.latestLine).toBe("previous turn");
  writeFileSync(path, assistant("too late"));
  await tick(10000);
  expect(state.getTerminal(terminal.id)?.latestLine).toBe("previous turn");
});

for (const withTranscript of [true, false]) {
  test(`a newer hook cancels a pending reread (transcript=${withTranscript})`, async () => {
    jest.useFakeTimers();
    state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
    const oldPath = join(f.root, "old.jsonl");
    const newPath = join(f.root, "new.jsonl");
    writeFileSync(oldPath, "");
    writeFileSync(newPath, assistant("newer hook text"));
    await post("claude-code", { hook_event_name: "Stop", transcript_path: oldPath });
    await tick(300);
    await post("claude-code", { hook_event_name: "UserPromptSubmit", ...(withTranscript ? { transcript_path: newPath } : {}) });
    writeFileSync(oldPath, assistant("stale delayed text"));
    for (const delay of [700, 2000, 10000]) await tick(delay);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe(withTranscript ? "newer hook text" : null);
  });
}

test("shutdown cancels pending transcript reads before closing state", async () => {
  jest.useFakeTimers();
  state.db.exec("UPDATE terminals SET runtime = 'claude-code'");
  const path = join(f.root, "shutdown.jsonl");
  writeFileSync(path, "");
  await post("claude-code", { hook_event_name: "Stop", transcript_path: path });
  await terminals.stop();
  writeFileSync(path, assistant("after shutdown"));
  await tick(3000);
  expect(state.getTerminal(terminal.id)?.latestLine).toBeNull();
});
