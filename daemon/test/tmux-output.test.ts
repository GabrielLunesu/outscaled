import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalStatus } from "@outscaled/protocol";
import { State } from "../src/state";
import { Supervisor } from "../src/supervisor";
import { Terminals } from "../src/terminals";
import { Tmux, type TmuxPane } from "../src/tmux";
import { fixture, terminal, workspace } from "./helpers";

let f: ReturnType<typeof fixture>;
let state: State;
let supervisor: Supervisor | undefined;
let restoreClock: (() => void) | undefined;

beforeEach(() => {
  f = fixture();
  state = new State(f.config.statePath);
  state.insertWorkspace({ ...workspace, path: f.root });
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  restoreClock?.();
  restoreClock = undefined;
  state.close();
  f.cleanup();
});

test("listPanes preserves missing versus zero generations and reads activity per pane", async () => {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const argsPath = join(f.root, "args.json");
  const output = [
    "ws-demo-x1\t123\t%0\t0\t\t\t\t\t10",
    "ws-demo-x2\t124\t%1\t0\t\t\t\t0\t11",
    "ws-demo-x3\t125\t%2\t0\t\t\t\t8\t12",
  ].join("\n");
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(output)});
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const panes = await new Tmux(f.env.WSD_TMUX_SOCKET).listPanes();
    expect(panes.map(({ outputGeneration, windowActivity }) => ({ outputGeneration, windowActivity }))).toEqual([
      { outputGeneration: null, windowActivity: 10 },
      { outputGeneration: 0, windowActivity: 11 },
      { outputGeneration: 8, windowActivity: 12 },
    ]);
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    expect(args.slice(0, 6)).toEqual(["-u", "-S", f.env.WSD_TMUX_SOCKET, "list-panes", "-a", "-F"]);
    expect(args[6]).toContain("#{pane_output_generation}\t#{window_activity}");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

function observe(panes: TmuxPane[], status: TerminalStatus = "starting") {
  const tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
  let polls = 0;
  // No tmux process or real agent: feed the supervisor per-pane format results.
  tmux.listPanes = async () => { polls++; return panes.map(pane => ({ ...pane })); };
  for (const [index, pane] of panes.entries()) {
    state.insertTerminal({
      ...terminal, id: `codex-${index}`, name: `x${index + 1}`, session: pane.name,
      command: "codex", pid: pane.pid, runtime: "codex",
    });
    state.updateTerminalStatus(`codex-${index}`, status);
  }
  let now = 10_900;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const terminals = new Terminals(state, tmux);
  supervisor = new Supervisor(state, tmux, terminals);
  supervisor.start();
  return {
    async sample(time: number) {
      now = time;
      const previous = polls;
      const deadline = performance.now() + 2000;
      while (polls === previous && performance.now() < deadline) await Bun.sleep(10);
      expect(polls).toBeGreaterThan(previous);
      // Wait for that poll's status writes to finish under the lifecycle lock.
      await terminals.serial(async () => {});
    },
    notify(time: number) { now = time; terminals.codexTurnComplete("codex-0"); },
    status(index = 0) { return state.getTerminal(`codex-${index}`)!.status; },
  };
}

function pane(index = 0): TmuxPane {
  return {
    name: `ws-demo-x${index + 1}`, pid: 123 + index, pane: `%${index}`,
    dead: false, exitStatus: null, exitSignal: null, diedAt: null,
    outputGeneration: null, windowActivity: 10,
  };
}

test("activity fallback settles startup and absorbs notify redraws across second boundaries", async () => {
  const source = pane();
  const watch = observe([source]);
  await watch.sample(10_900);
  source.windowActivity = 11;
  await watch.sample(11_100);
  source.windowActivity = 12;
  await watch.sample(12_100);
  await watch.sample(12_900); // More output in the same second is indistinguishable.
  await watch.sample(14_999); // Two seconds since observation is not enough yet.
  expect(watch.status()).toBe("starting");
  await watch.sample(15_000);
  expect(watch.status()).toBe("idle");
  source.windowActivity = 15;
  await watch.sample(15_200);
  expect(watch.status()).toBe("working");
  watch.notify(15_990);
  expect(watch.status()).toBe("idle");
  source.windowActivity = 16; // The final redraw crosses into a new second.
  await watch.sample(16_100);
  expect(watch.status()).toBe("idle");
  await watch.sample(17_100); // Grace expired; the absorbed redraw stays absorbed.
  expect(watch.status()).toBe("idle");
  watch.notify(17_990); // An already-idle notification must renew grace too.
  source.windowActivity = 18;
  await watch.sample(18_100);
  expect(watch.status()).toBe("idle");
  await watch.sample(19_100);
  expect(watch.status()).toBe("idle");
  source.windowActivity = 20;
  await watch.sample(20_100);
  expect(watch.status()).toBe("working");
  expect(state.listEvents().filter(event => event.type === "terminal.status").map(event => (event.payload as {newStatus: string}).newStatus))
    .toEqual(["starting", "idle", "working", "idle", "working"]);
}, 15000);

test("generation takes precedence, including zero, while another pane falls back to activity", async () => {
  const modern = { ...pane(), outputGeneration: 0 };
  const older = pane(1);
  const watch = observe([modern, older], "idle");
  await watch.sample(10_900);
  modern.windowActivity = older.windowActivity = 11;
  await watch.sample(11_100);
  expect(watch.status()).toBe("idle");
  expect(watch.status(1)).toBe("working");
  modern.outputGeneration = 1; // Output within the same activity second.
  await watch.sample(11_200);
  expect(watch.status()).toBe("working");
});
