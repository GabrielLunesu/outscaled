import { afterEach, beforeEach, expect, jest, test } from "bun:test";
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

beforeEach(() => {
  f = fixture();
  state = new State(f.config.statePath);
  state.insertWorkspace({ ...workspace, path: f.root });
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  jest.useRealTimers();
  state.close();
  f.cleanup();
});

test("listPanes reads output, attached clients and size per pane in one call", async () => {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const argsPath = join(f.root, "args.json");
  const output = [
    "ws-demo-x1\t123\t%0\t0\t\t\t\t\t10\t0\t80\t24",
    "ws-demo-x2\t124\t%1\t0\t\t\t\t0\t11\t1\t120\t40",
    "ws-demo-x3\t125\t%2\t0\t\t\t\t8\t12\t2\t100\t30",
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
    expect(panes.map(({ attachedClients, width, height }) => ({ attachedClients, width, height }))).toEqual([
      { attachedClients: 0, width: 80, height: 24 },
      { attachedClients: 1, width: 120, height: 40 },
      { attachedClients: 2, width: 100, height: 30 },
    ]);
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    expect(args.slice(0, 6)).toEqual(["-u", "-S", f.env.WSD_TMUX_SOCKET, "list-panes", "-a", "-F"]);
    expect(args[6]).toContain("#{pane_output_generation}\t#{window_activity}\t#{session_attached}\t#{pane_width}\t#{pane_height}");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

function observe(panes: TmuxPane[], status: TerminalStatus = "starting") {
  jest.useFakeTimers({ now: 10_900 });
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
  const terminals = new Terminals(state, tmux);
  supervisor = new Supervisor(state, tmux, terminals);
  supervisor.start();
  return {
    async sample(time: number) {
      const previous = polls;
      // Queue one poll, then set its observation time before it runs under the
      // lifecycle lock. Neither polling nor second boundaries use real time.
      jest.advanceTimersToNextTimer();
      jest.setSystemTime(time);
      // Wait for that poll's status writes to finish under the lifecycle lock.
      await terminals.serial(async () => {});
      expect(polls).toBe(previous + 1);
    },
    notify(time: number) { jest.setSystemTime(time); terminals.codexTurnComplete("codex-0"); },
    status(index = 0) { return state.getTerminal(`codex-${index}`)!.status; },
  };
}

function pane(index = 0): TmuxPane {
  return {
    name: `ws-demo-x${index + 1}`, pid: 123 + index, pane: `%${index}`,
    dead: false, exitStatus: null, exitSignal: null, diedAt: null,
    outputGeneration: null, windowActivity: 10, attachedClients: 1, width: 80, height: 24,
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
});

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

for (const generation of [0, null]) {
  const path = generation === null ? "activity fallback" : "generation";
  const changes = {
    attach: { attachedClients: 2 },
    detach: { attachedClients: 0 },
    width: { width: 120 },
    height: { height: 40 },
  };
  const output = (source: TmuxPane, time: number) => {
    if (source.outputGeneration !== null) source.outputGeneration++;
    source.windowActivity = Math.floor(time / 1000);
  };

  for (const [change, fields] of Object.entries(changes)) {
    test(`${path}: idle Codex absorbs ${change} redraws, then detects later work`, async () => {
      const source = { ...pane(), outputGeneration: generation };
      const watch = observe([source], "idle");
      await watch.sample(10_900);
      Object.assign(source, fields);
      output(source, 11_990);
      await watch.sample(11_990); // Layout change and output arrive in the same poll.
      expect(watch.status()).toBe("idle");
      output(source, 12_490); // A later redraw also crosses an activity second.
      await watch.sample(12_490);
      expect(watch.status()).toBe("idle");
      await watch.sample(13_490); // Expiring grace must not replay absorbed output.
      expect(watch.status()).toBe("idle");
      output(source, 14_100); // A prompt/output after grace still starts work.
      await watch.sample(14_100);
      expect(watch.status()).toBe("working");
      expect(state.listEvents().filter(event => event.type === "terminal.status").map(event => (event.payload as {newStatus: string}).newStatus))
        .toEqual(["idle", "working"]);
    });
  }

  test(`${path}: delayed redraw grace is per pane and sustained output outlasts it`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const other = { ...pane(1), outputGeneration: generation };
    const watch = observe([source, other], "idle");
    await watch.sample(10_900);
    source.attachedClients++;
    await watch.sample(11_990); // No output yet; change alone must start grace.
    expect(watch.status()).toBe("idle");
    output(source, 12_490);
    output(other, 12_490);
    await watch.sample(12_490);
    expect(watch.status()).toBe("idle");
    expect(watch.status(1)).toBe("working");
    output(source, 12_989);
    await watch.sample(12_989);
    expect(watch.status()).toBe("idle");
    // Crossing the next second makes continued output visible to older tmux.
    output(source, 13_000);
    await watch.sample(13_000);
    expect(watch.status()).toBe("working");
  });
}
