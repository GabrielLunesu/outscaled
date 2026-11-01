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
  tmux.sendKeys = async () => {};
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
    reconcile() { return terminals.reconcile(); },
    submit() { return terminals.input("demo", "x1", { keys: ["Enter"], submit: false }); },
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

test("activity fallback allows a full timestamp bucket before startup settles", async () => {
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
});

test("generation takes precedence over activity, including zero", async () => {
  const source = { ...pane(), outputGeneration: 0 };
  const watch = observe([source], "idle");
  await watch.sample(10_900);
  for (const time of [11_100, 11_600, 12_100]) {
    source.windowActivity++;
    await watch.sample(time);
    expect(watch.status()).toBe("idle");
  }
  for (const time of [12_600, 13_100, 13_600]) {
    source.outputGeneration++;
    await watch.sample(time);
    expect(watch.status()).toBe(time === 13_600 ? "working" : "idle");
  }
});

test("generation requires three consecutive 500 ms output polls per pane", async () => {
  const source = { ...pane(), outputGeneration: 0 };
  const other = { ...pane(1), outputGeneration: 0 };
  const watch = observe([source, other], "idle");
  await watch.sample(10_900);
  for (const time of [11_400, 11_900]) {
    source.outputGeneration++;
    await watch.sample(time);
    expect(watch.status()).toBe("idle");
  }
  await watch.sample(12_400); // Silence discards both preceding observations.
  for (const time of [12_900, 13_400, 13_900]) {
    source.outputGeneration++;
    await watch.sample(time);
    expect(watch.status()).toBe(time === 13_900 ? "working" : "idle");
    expect(watch.status(1)).toBe("idle");
  }
});

test("a new Codex process does not inherit a previous output streak", async () => {
  const source = { ...pane(), outputGeneration: 0 };
  const watch = observe([source], "idle");
  await watch.sample(10_900);
  for (const time of [11_400, 11_900]) {
    source.outputGeneration++;
    await watch.sample(time);
  }
  source.pid++;
  source.outputGeneration++;
  await watch.sample(12_400);
  expect(watch.status()).toBe("idle");
  for (const time of [12_900, 13_400, 13_900]) {
    source.outputGeneration++;
    await watch.sample(time);
    expect(watch.status()).toBe(time === 13_900 ? "working" : "idle");
  }
});

for (const offset of [100, 600, 990]) {
  test(`activity fallback requires three consecutive activity seconds at offset ${offset}`, async () => {
    const source = pane();
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    for (let index = 0; index < 5; index++) {
      const time = 11_000 + offset + index * 500;
      source.windowActivity = Math.floor(time / 1000); // Output every 500 ms.
      await watch.sample(time);
      expect(watch.status()).toBe(source.windowActivity >= 13 ? "working" : "idle");
    }
  });
}

test("activity fallback discards a streak after silence or skipped activity seconds", async () => {
  const source = pane();
  const other = pane(1);
  const watch = observe([source, other], "idle");
  await watch.sample(10_900);
  for (const time of [11_100, 11_600, 12_100, 12_600]) {
    source.windowActivity = Math.floor(time / 1000);
    await watch.sample(time);
    expect(watch.status()).toBe("idle");
  }
  await watch.sample(13_100); // An expired unchanged bucket breaks the streak.
  for (const time of [14_100, 14_600, 15_100, 15_600, 16_100]) {
    source.windowActivity = Math.floor(time / 1000);
    await watch.sample(time);
    expect(watch.status()).toBe(time === 16_100 ? "working" : "idle");
    expect(watch.status(1)).toBe("idle");
  }
});

for (const generation of [0, null]) {
  const path = generation === null ? "activity fallback" : "generation";
  const emit = (source: TmuxPane, time: number) => {
    if (source.outputGeneration !== null) source.outputGeneration++;
    source.windowActivity = Math.floor(time / 1000);
  };

  test(`${path}: continuous completion rendering stays idle until quiet, then new work is detected`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    watch.notify(11_000);
    await watch.sample(11_500); // Quiet inside the minimum grace cannot release settling.
    for (let time = 12_000; time <= 32_000; time += 500) {
      emit(source, time);
      await watch.sample(time);
      expect(watch.status()).toBe("idle");
    }
    await watch.sample(32_500); // Older tmux's current activity bucket is still inconclusive.
    await watch.sample(33_000); // Both paths have now observed silence after grace.
    for (let time = 33_500; time <= 35_500; time += 500) {
      emit(source, time);
      await watch.sample(time);
      const workingAt = generation === null ? 35_000 : 34_500;
      expect(watch.status()).toBe(time >= workingAt ? "working" : "idle");
    }
  });

  test(`${path}: reconciliation preserves notify settling across adoption`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.reconcile(); // Restores the persisted idle/notify timestamp.
    await watch.sample(13_000); // First poll after grace is a baseline, not silence.
    for (let time = 13_500; time <= 18_000; time += 500) {
      emit(source, time);
      await watch.sample(time);
      expect(watch.status()).toBe("idle");
    }
  });

  test(`${path}: duplicate notify re-arms settling and API submission bypasses it immediately`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    watch.notify(11_000);
    await watch.sample(12_100); // Quiet after grace releases the first notification.
    watch.notify(12_200); // Already idle: statusChangedAt is unchanged.
    for (let time = 12_700; time <= 17_200; time += 500) {
      emit(source, time);
      await watch.sample(time);
      expect(watch.status()).toBe("idle");
    }
    expect((await watch.submit()).status).toBe("working");
    await watch.sample(17_700);
    expect(watch.status()).toBe("working");
  });

  test(`${path}: a new process does not inherit completion settling`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    watch.notify(11_000);
    source.pid++;
    state.updateTerminalStatus("codex-0", "starting");
    await watch.sample(11_500);
    await watch.sample(15_000);
    expect(watch.status()).toBe("idle");
    for (let time = 15_500; time <= 17_500; time += 500) {
      emit(source, time);
      await watch.sample(time);
    }
    expect(watch.status()).toBe("working");
  });

  for (const [change, fields] of Object.entries({
    attach: { attachedClients: 2 }, detach: { attachedClients: 0 },
    width: { width: 120 }, height: { height: 40 },
  })) {
    test(`${path}: ${change} redraws during and after grace stay idle`, async () => {
      const source = { ...pane(), outputGeneration: generation };
      const watch = observe([source], "idle");
      await watch.sample(10_900);
      Object.assign(source, fields);
      for (const time of [11_990, 12_490, 12_990, 13_490]) {
        emit(source, time);
        await watch.sample(time);
        expect(watch.status()).toBe("idle");
      }
      await watch.sample(13_990); // Silence breaks the output streak.
      emit(source, 15_490); // A late redraw well outside grace is still harmless.
      await watch.sample(15_490);
      await watch.sample(15_990);
      expect(watch.status()).toBe("idle");
    });
  }

  test(`${path}: isolated late output and brief typing do not accumulate`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    for (const start of [12_100, 17_100, 22_100]) {
      emit(source, start);
      await watch.sample(start);
      emit(source, start + 500); // At most two polls of composer output.
      await watch.sample(start + 500);
      await watch.sample(start + 1000);
      await watch.sample(start + 1500);
      expect(watch.status()).toBe("idle");
    }
    expect(state.listEvents().filter(event => event.type === "terminal.status")).toHaveLength(1);
  });

  test(`${path}: notify clears prior output evidence and a later burst stays idle`, async () => {
    const source = { ...pane(), outputGeneration: generation };
    const watch = observe([source], "idle");
    await watch.sample(10_900);
    for (const time of [11_100, 11_600]) {
      emit(source, time);
      await watch.sample(time);
    }
    watch.notify(11_990);
    for (const time of [12_100, 12_600, 13_100, 13_600]) {
      emit(source, time);
      await watch.sample(time);
      expect(watch.status()).toBe("idle");
    }
    await watch.sample(14_100);
    emit(source, 16_100); // A single burst after notify grace must not start work.
    await watch.sample(16_100);
    await watch.sample(16_600);
    await watch.sample(17_100);
    expect(watch.status()).toBe("idle");
    watch.notify(17_990); // Duplicate idle notify also renews grace.
    emit(source, 18_100);
    await watch.sample(18_100);
    await watch.sample(19_100);
    expect(watch.status()).toBe("idle");
  });
}
