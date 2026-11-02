import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTerminalsRoute } from "../src/routes/terminals";
import { State } from "../src/state";
import { Terminals } from "../src/terminals";
import { Tmux, type TmuxPane } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";

const block = (name: string) => readFileSync(join(import.meta.dir, `fixtures/permissions/${name}.txt`), "utf8");
let f: ReturnType<typeof fixture>;
let state: State;
let terminals: Terminals;
let route: ReturnType<typeof createTerminalsRoute>;
let screen: string;
let keys: string[][];
let panes: TmuxPane[];
beforeEach(() => {
  f = fixture(); state = new State(f.config.statePath);
  state.insertWorkspace(workspace);
  state.insertTerminal({ ...terminal, runtime: "claude-code", status: "working", statusChangedAt: workspace.createdAt });
  const tmux = new Tmux(f.config.tmuxSocket);
  panes = [{ name: terminal.session, pane: "%0", pid: 10, dead: false } as TmuxPane];
  keys = []; screen = block("edit");
  tmux.listPanes = async () => panes;
  tmux.captureScreen = async () => screen;
  tmux.sendKeys = async (_pane, sent) => { keys.push(sent); };
  terminals = new Terminals(state, tmux);
  route = createTerminalsRoute({ config: f.config, state, terminals });
});
afterEach(() => { state.close(); f.cleanup(); });
const answer = async (body: unknown = { answer: "allow_once" }, name = "shell") => (await route(new Request(`http://localhost/v1/workspaces/demo/terminals/${name}/answer`, { method: "POST", body: JSON.stringify(body) })))!;

for (const [layout, choice, number] of [["edit", "allow_once", 1], ["edit", "deny", 3], ["bash", "allow_once", 1], ["bash", "deny", 4]] as const) {
  test(`${choice} on ${layout} sends only the discovered option number and consumes the request`, async () => {
    screen = block(layout);
    await terminals.captureRequest(terminal.id, "Claude needs permission");
    const response = await answer({ answer: choice });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ question: layout === "edit" ? "Do you want to create notes.txt?" : "Do you want to proceed?", option: { number, label: choice === "deny" ? "No" : "Yes" } });
    expect(keys).toEqual([[String(number)]]);
    expect(state.getTerminal(terminal.id)).toMatchObject({ status: "working", request: null });
    expect((await answer()).status).toBe(409);
    expect(keys).toHaveLength(1);
  });
}

test("unknown terminal and workspace return 404; malformed answers return 400", async () => {
  expect((await answer(undefined, "missing")).status).toBe(404);
  const missing = await route(new Request("http://localhost/v1/workspaces/missing/terminals/shell/answer", { method: "POST", body: '{"answer":"deny"}' }));
  expect(missing?.status).toBe(404);
  for (const body of [{}, { answer: "yes" }, { answer: "deny", key: "2" }, null]) expect((await answer(body)).status).toBe(400);
  expect(keys).toEqual([]);
});

for (const reason of ["not waiting", "wrong runtime", "exited", "dead pane", "missing pane", "no prompt", "trust", "layout", "changed question", "changed context", "not captured"] as const) {
  test(`409 with no key for ${reason}`, async () => {
    await terminals.captureRequest(terminal.id, "Permission requested");
    if (reason === "not waiting") state.updateTerminalStatus(terminal.id, "idle");
    if (reason === "wrong runtime") state.db.exec("UPDATE terminals SET runtime = 'codex'");
    if (reason === "exited") state.updateTerminalState(terminal.id, { state: "exited", pid: null });
    if (reason === "dead pane") panes[0]!.dead = true;
    if (reason === "missing pane") panes = [];
    if (reason === "no prompt") screen = "Request finished\n❯";
    if (reason === "trust") screen = "Do you trust this folder?\n1. Yes\n2. No\nEsc to cancel";
    if (reason === "layout") screen = block("edit").replace("3. No", "3. Never");
    if (reason === "changed question") screen = block("bash");
    if (reason === "changed context") screen = "A different tool call\n" + screen;
    if (reason === "not captured") state.db.exec("UPDATE terminals SET request = NULL, requestScreenHash = NULL");
    const response = await answer();
    expect(response.status).toBe(409);
    expect((await response.json() as {error: {message: string}}).error.message.length).toBeGreaterThan(10);
    expect(keys).toEqual([]);
  });
}

test("request stores hook text, fills a late prompt, publishes updates and clears on leaving needs_input", async () => {
  screen = "prompt not drawn yet";
  await terminals.captureRequest(terminal.id, "Please approve the edit");
  expect(state.getTerminal(terminal.id)?.request).toEqual({ message: "Please approve the edit", permission: null });
  const first = state.getTerminal(terminal.id)!;
  screen = block("edit");
  await terminals.refreshScreen(first, { ...panes[0]!, outputGeneration: 1, windowActivity: 10 });
  const waiting = state.getTerminal(terminal.id)!;
  expect(waiting.statusChangedAt).toBe(first.statusChangedAt);
  expect(waiting.request?.permission?.question).toBe("Do you want to create notes.txt?");
  expect(waiting.request?.message).toBe("Please approve the edit");
  expect(state.listEvents().filter(event => event.type === "agent.needs_input")).toHaveLength(1);
  expect(state.listEvents().some(event => event.type === "terminal.status" && JSON.stringify((event.payload as {request: unknown}).request) === JSON.stringify(waiting.request))).toBe(true);
  // Further hooks cannot silently replace the captured prompt while waiting.
  screen = block("bash");
  await terminals.captureRequest(terminal.id);
  expect((await answer()).status).toBe(409);
  state.updateTerminalStatus(terminal.id, "idle");
  expect(state.getTerminal(terminal.id)?.request).toBeNull();
  expect(state.requestScreenHash(terminal.id)).toBeNull();
  expect(state.listEvents().some(event => event.type === "terminal.status" && (event.payload as {newStatus: string; request: unknown}).newStatus === "idle" && (event.payload as {request: unknown}).request === null)).toBe(true);
  await terminals.captureRequest(terminal.id, "Next prompt");
  expect(state.getTerminal(terminal.id)?.request?.permission?.question).toBe("Do you want to proceed?");
});

test("waiting requests, fingerprints and latest lines survive database reopen without leaking internal columns", async () => {
  await terminals.captureRequest(terminal.id, "Waiting");
  state.updateLatestLine(terminal.id, "Assistant reply", true);
  const before = state.getTerminal(terminal.id);
  const hash = state.requestScreenHash(terminal.id);
  state.close(); state = new State(f.config.statePath);
  expect(state.getTerminal(terminal.id)).toEqual(before);
  expect(state.requestScreenHash(terminal.id)).toBe(hash);
  expect(state.hasAgentLatestLine(terminal.id)).toBe(true);
  expect(Object.keys(state.getTerminal(terminal.id)!)).not.toContain("requestScreenHash");
});
