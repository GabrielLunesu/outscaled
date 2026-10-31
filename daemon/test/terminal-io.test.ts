import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ioFixture, eventually } from "./terminal-io-helpers";
import { shellQuote } from "../src/terminals";

let f: Awaited<ReturnType<typeof ioFixture>>;
beforeEach(async () => { f = await ioFixture(); });
afterEach(async () => { await f?.cleanup(); });
const input = (body: unknown, name = "agent") => fetch(`${f.path}/${name}/input`, { method: "POST", body: JSON.stringify(body) });
const output = (query = "", name = "agent") => fetch(`${f.path}/${name}/output${query}`);
const received = () => Bun.file(join(f.root, "received.bin")).text();

test("input pastes intact UTF-8 as one bracketed paste, sends keys, and defaults to submitting", async () => {
  const terminal = await f.open({ name: "agent", command: f.command });
  await f.ready();
  const text = "  'quotes' \"double\" $HOME `literal`\nsecond line: café 日本語  ";
  expect((await input({ text, submit: false })).status).toBe(200);
  await eventually(async () => await received().catch(() => "") === `\x1b[200~${text}\x1b[201~`);
  expect(f.app.state.getTerminal(terminal.id)?.status).toBe("idle");
  expect((await input({ keys: ["Escape", "Tab"] })).status).toBe(200);
  await eventually(async () => (await received()).endsWith("\x1b\t"));
  expect((await input({ text: " next" })).status).toBe(200);
  expect(f.app.state.getTerminal(terminal.id)?.status).toBe("working");
  await eventually(async () => (await received()).endsWith("\x1b[200~ next\x1b[201~\r"));
  await eventually(() => f.app.state.getTerminal(terminal.id)?.status === "idle");
});

test("submit and Enter keys immediately mark an idle agent working", async () => {
  const terminal = await f.open({ name: "agent", command: f.command });
  await f.ready();
  for (const body of [{ submit: true }, { keys: ["Enter"] }, { text: "" }]) {
    expect((await input(body)).status).toBe(200);
    expect(f.app.state.getTerminal(terminal.id)?.status).toBe("working");
    await eventually(() => f.app.state.getTerminal(terminal.id)?.status === "idle");
  }
});

test("invalid input is rejected before any text reaches the pane", async () => {
  await f.open({ name: "agent", command: f.command });
  await f.ready();
  for (const body of [{}, { keys: [] }, { keys: ["Enter;kill-server"] }, { keys: ["-t"] }, { keys: ["Enter\n"] }, { keys: ["x".repeat(41)] }, { text: "bad\0text" }, { submit: "true" }]) {
    expect((await input(body)).status).toBe(400);
  }
  expect(await Bun.file(join(f.root, "received.bin")).exists()).toBe(false);
});

test("unknown and no longer running terminals return 404 and 409, including retained dead panes", async () => {
  expect((await input({ text: "hello" }, "unknown")).status).toBe(404);
  expect((await output("", "unknown")).status).toBe(404);
  await f.open({ name: "agent", command: "sleep 600" });
  Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-session", "-t", "=ws-demo-agent"]);
  expect((await input({ text: "hello" })).status).toBe(409);
  expect((await output()).status).toBe(409);
  await f.open({ name: "dead", command: "true", alwaysOn: true });
  await eventually(async () => Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "display-message", "-p", "-t", "=ws-demo-dead:", "#{pane_dead}"]).stdout.toString().trim() === "1");
  expect((await input({ text: "hello" }, "dead")).status).toBe(409);
  expect((await output("", "dead")).status).toBe(409);
  expect((await (await fetch(f.path)).json() as {name: string; state: string}[]).find(t => t.name === "dead")?.state).not.toBe("running");
});

test("output includes scrollback, joins wraps, keeps leading whitespace and drops trailing blanks", async () => {
  const script = join(f.root, "output.ts");
  writeFileSync(script, `console.log(Array.from({length: 350}, (_, i) => 'line-' + i).join('\\n'));\nconsole.log('  ' + 'x'.repeat(240));\nconsole.log('last\\n\\n');\nawait Bun.sleep(600000);\n`);
  await f.open({ name: "agent", command: `${shellQuote(process.execPath)} ${shellQuote(script)}` });
  await eventually(async () => (await (await output()).json() as {text: string}).text.endsWith("last"));
  const all = (await (await output("?lines=5000")).json() as {text: string}).text;
  expect(all.split("\n")).toHaveLength(352);
  expect(all).toStartWith("line-0\n");
  expect(all).toEndWith(`\n  ${"x".repeat(240)}\nlast`);
  const defaults = (await (await output()).json() as {text: string}).text;
  expect(defaults.split("\n")).toHaveLength(200);
  expect((await (await output("?lines=2")).json() as {text: string}).text).toBe(`  ${"x".repeat(240)}\nlast`);
  for (const lines of ["0", "5001", "-1", "1.5", "oops", ""]) expect((await output(`?lines=${lines}`)).status).toBe(400);
});
