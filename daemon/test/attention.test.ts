import { afterEach, expect, jest, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamMessage } from "@outscaled/protocol";
import { latestLine, permissionPrompt, transcriptLatestLine, TRANSCRIPT_TAIL_BYTES } from "../src/attention";
import { State } from "../src/state";
import { Terminals } from "../src/terminals";
import { Tmux, type TmuxPane } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";
import { permissionFixture as promptFixture } from "./permission-fixtures";

afterEach(() => jest.useRealTimers());

for (const [name, no] of [["edit", 3], ["bash", 4]] as const) {
  test(`real ${name} permission screen finds exact Yes and No options`, () => {
    const parsed = permissionPrompt(promptFixture(name))!;
    expect(parsed.prompt.question).toBe(name === "edit" ? "Do you want to create notes.txt?" : "Do you want to proceed?");
    expect(parsed.prompt.options.find(option => option.label === "Yes")?.number).toBe(1);
    expect(parsed.prompt.options.find(option => option.label === "No")?.number).toBe(no);
    expect(parsed.prompt.options[1]!.label).toContain(name === "edit" ? "(shift+tab)" : "<workspace>");
    expect(permissionPrompt("Bash command: first\n" + promptFixture(name))!.fingerprint)
      .not.toBe(permissionPrompt("Bash command: second\n" + promptFixture(name))!.fingerprint);
  });
}

test("rejects folder trust, after-No and after-Escape screens, garbage and unknown layouts", () => {
  for (const text of [
    promptFixture("trust"), promptFixture("after-no"), promptFixture("after-esc"),
    "", "garbage", "Do you want to proceed?\n1. Yes\n2. No", // incomplete
    promptFixture("edit").replace("1. Yes", "1. Yes, always"),
    promptFixture("edit").replace("3. No", "4. No"),
    promptFixture("edit").replace("3. No", "3. Yes"),
    promptFixture("edit").replace("   3. No", "bogus option"),
    promptFixture("edit") + "Another message after the old prompt",
    promptFixture("edit") + promptFixture("bash"),
    "Do you want to proceed?\n" + Array.from({length: 10}, (_, i) => `${i + 1}. ${i === 0 ? "Yes" : i === 9 ? "No" : "Other option"}`).join("\n") + "\nEsc to cancel",

  ]) expect(permissionPrompt(text)).toBeNull();
});

test("footer accepts standalone cancel or separated hints and rejects lookalikes", () => {
  const screen = promptFixture("edit");
  expect(screen).toContain(" Esc to cancel · Tab to amend\n");
  for (const footer of ["Esc to cancel", "Esc to cancel · Tab to amend", "Esc to cancel · Tab to amend · More hints"]) {
    expect(permissionPrompt(screen.replace("Esc to cancel · Tab to amend", footer))?.prompt.options.find(option => option.label === "No")?.number).toBe(3);
  }
  for (const footer of ["Esc to cancellation", "Esc to cancel arbitrary text", "Esc to cancel ·", "Hint · Esc to cancel", "Esc to cancel · Tab to amend\nNew output"]) {
    expect(permissionPrompt(screen.replace("Esc to cancel · Tab to amend", footer))).toBeNull();
  }
});

test("latest line is trimmed, single-line, bounded, and ignores blank lines and terminal escapes", () => {
  expect(latestLine("old\n \n  \x1b[32mnew text\x1b[0m  \n\n")).toBe("new text");
  expect(latestLine(" \n\r ")).toBeNull();
  expect(latestLine("x".repeat(300))).toHaveLength(200);
});

// The tmux adapter supplies only rows above the cursor and joins wraps. These
// unit cases check selection and null updates without consulting a full screen.
for (const { name, captured, expected } of [
  { name: "prompt on the cursor row", captured: "old\nLAST_OUTPUT\n", expected: "LAST_OUTPUT" },
  { name: "multi-line prompt", captured: "LAST_OUTPUT\ncontext\n", expected: "context" },
  { name: "full screen", captured: "line-7\nline-8\nline-9\nline-10\nline-11\n", expected: "line-11" },
  { name: "empty screen", captured: "", expected: null },
  { name: "blank rows above the cursor", captured: "\n \n", expected: null },
  { name: "wrapped output", captured: `old\n${"x".repeat(35)}\n`, expected: "x".repeat(35) },
]) {
  test(`shell line choice: ${name}`, async () => {
    const state = new State(":memory:");
    const tmux = new Tmux("unused-test-socket");
    tmux.captureShellScreen = async () => captured;
    tmux.captureScreen = async () => { throw new Error("Shell line selection must not use the prompt row"); };
    const terminals = new Terminals(state, tmux);
    state.insertWorkspace(workspace);
    state.insertTerminal({ ...terminal, latestLine: "previous output" });
    try {
      await terminals.refreshScreen(state.getTerminal(terminal.id)!, {
        pid: 10, pane: "%0", outputGeneration: 0, windowActivity: 10,
      } as TmuxPane);
      expect(state.getTerminal(terminal.id)?.latestLine).toBe(expected);
    } finally { await terminals.stop(); state.close(); }
  });
}

test("transcript reads only the bounded tail, ignores partial records and non-text entries", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "transcript.jsonl");
    const assistant = (content: unknown) => JSON.stringify({ type: "assistant", message: { content } });
    writeFileSync(path, assistant("outside bounded tail") + "\n" + "x".repeat(TRANSCRIPT_TAIL_BYTES * 20) + "\n" + [
      assistant("older"),
      JSON.stringify({ type: "user", message: { content: "user text" } }),
      assistant([{ type: "thinking", thinking: "secret thoughts" }, { type: "text", text: "first\n latest assistant text  " }, { type: "tool_use", name: "Edit" }]),
      assistant([{ type: "tool_use", name: "Bash" }]),
      JSON.stringify({ type: "api-request-blob", message: { content: [{ type: "text", text: "request internals" }, { type: "tool_addition" }] } }),
      "garbage", "{partial",
    ].join("\n"));
    expect(await transcriptLatestLine(path)).toBe("latest assistant text");
    writeFileSync(path, assistant("complete") + "\n" + assistant("not newline-committed"));
    expect(await transcriptLatestLine(path)).toBe("complete");
    writeFileSync(path, assistant([{ type: "thinking", text: "not assistant text" }]) + "\n");
    expect(await transcriptLatestLine(path)).toBeNull();
    expect(await transcriptLatestLine(join(f.root, "missing"))).toBeNull();
    expect(await transcriptLatestLine(f.root)).toBeNull();
  } finally { f.cleanup(); }
});

test("latest-line notifications coalesce per terminal with a trailing update and no stored events", async () => {
  jest.useFakeTimers({ now: 10_000 });
  const messages: StreamMessage[] = [];
  const state = new State(":memory:", message => messages.push(message));
  try {
    state.insertWorkspace(workspace);
    state.insertTerminal(terminal);
    state.insertTerminal({ ...terminal, id: "second", name: "second", session: "ws-demo-second" });
    await Promise.resolve(); messages.length = 0;
    state.updateLatestLine(terminal.id, "first");
    await Promise.resolve();
    for (let i = 0; i < 100; i++) state.updateLatestLine(terminal.id, `line ${i}`);
    state.updateLatestLine("second", "independent");
    await Promise.resolve();
    expect(messages).toHaveLength(2);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("line 99");
    jest.advanceTimersByTime(999);
    expect(messages).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({ type: "terminal.latest_line", terminal: terminal.id, payload: { latestLine: "line 99" } });
    state.updateLatestLine(terminal.id, "line 99");
    await Promise.resolve(); jest.advanceTimersByTime(1000);
    expect(messages).toHaveLength(3);
    expect(state.listEvents()).toEqual([]);
    expect(() => state.db.transaction(() => { state.updateLatestLine(terminal.id, "rollback"); throw new Error("rollback"); })()).toThrow();
    await Promise.resolve(); jest.advanceTimersByTime(1000);
    expect(messages).toHaveLength(3);
    state.updateLatestLine(terminal.id, "agent text", true);
    state.updateLatestLine(terminal.id, "screen fallback");
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("agent text");
  } finally { state.close(); }
});

test("screen fallback reads at most once a second after output, including a trailing dirty sample", async () => {
  jest.useFakeTimers({ now: 10_000 });
  const state = new State(":memory:");
  const tmux = new Tmux("unused-test-socket");
  let reads = 0;
  tmux.captureShellScreen = async () => `screen ${++reads}`;
  tmux.captureScreen = async () => { throw new Error("Shells must capture above the cursor"); };
  const terminals = new Terminals(state, tmux);
  const pane = { pid: 10, pane: "%0", outputGeneration: 0, windowActivity: 10 } as TmuxPane;
  state.insertWorkspace(workspace); state.insertTerminal(terminal);
  try {
    await terminals.refreshScreen(terminal, pane);
    pane.outputGeneration = 1;
    jest.advanceTimersByTime(500);
    await terminals.refreshScreen(terminal, pane);
    expect(reads).toBe(1);
    jest.advanceTimersByTime(500);
    await terminals.refreshScreen(terminal, pane);
    expect(reads).toBe(2);
    jest.advanceTimersByTime(1000);
    await terminals.refreshScreen(terminal, pane);
    expect(reads).toBe(2);
    expect(state.getTerminal(terminal.id)?.latestLine).toBe("screen 2");
  } finally { state.close(); }
});

for (const runtime of ["claude-code", "codex"] as const) {
  test(`${runtime} never takes a screen line, including while capturing a permission prompt`, async () => {
    const state = new State(":memory:");
    const tmux = new Tmux("unused-test-socket");
    let reads = 0;
    tmux.captureShellScreen = async () => { throw new Error("Agents must not sample shell output"); };
    tmux.captureScreen = async () => { reads++; return promptFixture("edit"); };
    const terminals = new Terminals(state, tmux);
    const pane = { pid: 10, pane: "%0", outputGeneration: 0, windowActivity: 10 } as TmuxPane;
    state.insertWorkspace(workspace);
    state.insertTerminal({ ...terminal, runtime, status: "idle", statusChangedAt: workspace.createdAt });
    try {
      await terminals.refreshScreen(state.getTerminal(terminal.id)!, pane);
      expect(reads).toBe(0);
      state.updateLatestLine(terminal.id, "? for shortcuts");
      expect(state.getTerminal(terminal.id)?.latestLine).toBeNull();
      state.updateTerminalStatus(terminal.id, "needs_input");
      // New process observation forces a screen sample without a wall-clock wait.
      pane.pid++;
      await terminals.refreshScreen(state.getTerminal(terminal.id)!, pane);
      expect(reads).toBe(1);
      expect(state.getTerminal(terminal.id)?.request?.permission).not.toBeNull();
      expect(state.getTerminal(terminal.id)?.latestLine).toBeNull();
      state.updateLatestLine(terminal.id, "assistant output", true);
      expect(state.getTerminal(terminal.id)?.latestLine).toBe("assistant output");
    } finally { await terminals.stop(); state.close(); }
  });
}
