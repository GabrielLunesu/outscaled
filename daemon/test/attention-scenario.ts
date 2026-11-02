import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StreamMessage, Terminal } from "@outscaled/protocol";
import { shellQuote } from "../src/terminals";

// Shared by the source integration test and the private built-binary check.
export async function attentionScenario(address: string, cli: string[], env: NodeJS.ProcessEnv, folder: string, report: (text: string) => void = () => {}) {
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const eventually = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 8000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for attention scenario");
      await Bun.sleep(25);
    }
  };
  const execute = async (args: string[]) => {
    const child = Bun.spawn([...cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    report(`$ ws ${args.join(" ")}\nexit=${code}\n${stdout}${stderr}`);
    check(code === 0, `CLI failed: ${stderr}`);
    return stdout;
  };
  const post = async (path: string, body: unknown) => fetch(address + path, { method: "POST", body: JSON.stringify(body) });
  const base = "/v1/workspaces/attention/terminals";
  const rows = async () => Terminal.array().parse(await (await fetch(address + base)).json());
  const row = async (name: string) => (await rows()).find(row => row.name === name)!;
  const open = async (name: string, command: string) => {
    const response = await post(base, { name, command });
    check(response.status === 201, `Open ${name}: ${await response.clone().text()}`);
    return Terminal.parse(await response.json());
  };
  const bin = join(folder, "bin"); mkdirSync(bin, { recursive: true });
  for (const name of ["edit", "bash"]) writeFileSync(join(folder, `${name}.txt`), readFileSync(join(import.meta.dir, `fixtures/permissions/${name}.txt`)));
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[1], "utf8"));
const name = args[2];
const transcript = name + ".jsonl";
writeFileSync(transcript, JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Earlier line\\nClaude latest assistant line"}]}}) + "\\n");
const hook = async (event, extra = {}) => {
 const child = Bun.spawn(["/bin/sh", "-c", settings.hooks[event][0].hooks[0].command], {
   env: process.env, stdin: new Blob([JSON.stringify({hook_event_name:event,transcript_path:process.cwd()+"/"+transcript,...extra})]), stdout:"pipe", stderr:"pipe"
 });
 if (await child.exited !== 0) throw new Error("hook failed");
};
process.stdin.setRawMode(true);
process.stdin.on("data", async chunk => {
 appendFileSync(name + ".keys", chunk);
 process.stdout.write("\\x1b[2J\\x1b[HAnswered\\n");
 await hook("PostToolUse");
 appendFileSync(transcript, JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Claude answered " + chunk.toString()}]}}) + "\\n");
 await hook("Stop");
});
await hook("SessionStart");
let previous = "";
setInterval(async () => {
 const path = name + ".screen";
 if (!existsSync(path)) return;
 const mode = readFileSync(path,"utf8");
 if (mode === previous) return;
 previous = mode;
 const kind = mode.replace("-changed", "");
 const screen = kind === "trust" ? "Quick safety check: Is this a project you created or one you trust?\\n1. Yes, I trust this folder\\n2. No, exit\\nEnter to confirm" : kind === "none" ? "No permission prompt\\n❯" : readFileSync(kind + ".txt", "utf8");
 process.stdout.write("\\x1b[2J\\x1b[H" + screen);
 if (!mode.endsWith("-changed")) await hook("Notification", {notification_type:"permission_prompt",message:"Claude requests permission for " + kind});
 writeFileSync(name+".drawn",mode);
}, 30);
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const args = process.argv.slice(2);
const notify = JSON.parse(args[1].slice("notify=".length));
console.log("Codex screen fallback");
const child = Bun.spawn([...notify, JSON.stringify({type:"agent-turn-complete", "last-assistant-message":"Earlier Codex text\\nCodex latest assistant line"})], {env:process.env,stdout:"pipe",stderr:"pipe"});
await child.exited;
await Bun.sleep(600000);
`, { mode: 0o755 });
  await execute(["new", "attention", "--path", folder, "--json"]);
  const messages: StreamMessage[] = [];
  const socket = new WebSocket(address.replace("http:", "ws:") + "/v1/stream");
  socket.onmessage = event => messages.push(StreamMessage.parse(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  try {
    await open("codex", shellQuote(join(bin, "codex")));
    await open("shell", "/bin/sh -c 'printf \"shell latest line\\n\"; exec sleep 600'");
    await eventually(async () => (await row("codex"))?.latestLine === "Codex latest assistant line" && (await row("shell"))?.latestLine === "shell latest line");
    report(`Latest lines: Codex=${(await row("codex")).latestLine}; shell=${(await row("shell")).latestLine}`);
    for (const [layout, choice, expected] of [["edit", "allow_once", "1"], ["edit", "deny", "3"], ["bash", "allow_once", "1"], ["bash", "deny", "4"]] as const) {
      const name = `${layout}-${choice.replace("_", "-")}`;
      writeFileSync(join(folder, `${name}.screen`), layout);
      await open(name, `${shellQuote(join(bin, "claude"))} ${name}`);
      await eventually(async () => (await row(name))?.status === "needs_input" && Boolean((await row(name))?.request?.permission));
      const waiting = await row(name);
      check(waiting.request?.message === `Claude requests permission for ${layout}`, "Missing notification message");
      check(waiting.latestLine === "Claude latest assistant line", "Missing transcript latest line");
      report(`${name} waiting: ${JSON.stringify({request:waiting.request,latestLine:waiting.latestLine})}`);
      if (name === "bash-deny") {
        const result = await execute(["answer", "attention", name, "deny", "--on", "local"]);
        check(result.includes("4. No"), "CLI chose wrong option");
      } else {
        const response = await post(`${base}/${name}/answer`, { answer: choice });
        const body = await response.json() as { option: { number: number } };
        check(response.status === 200 && body.option.number === Number(expected), "Wrong answer response");
        report(`POST ${name}/answer ${choice}: ${response.status} ${JSON.stringify(body)}`);
      }
      await eventually(async () => Bun.file(join(folder, `${name}.keys`)).exists());
      check(readFileSync(join(folder, `${name}.keys`), "utf8") === expected, "Wrong key received");
      await eventually(async () => (await row(name)).status === "idle" && (await row(name)).request === null);
      report(`${name} received key ${expected}; request cleared; latestLine=${(await row(name)).latestLine}`);
    }
    for (const mode of ["none", "trust", "changed"] as const) {
      const name = `reject-${mode}`;
      writeFileSync(join(folder, `${name}.screen`), mode === "changed" ? "edit" : mode);
      await open(name, `${shellQuote(join(bin, "claude"))} ${name}`);
      await eventually(async () => (await row(name))?.status === "needs_input");
      if (mode === "changed") {
        writeFileSync(join(folder, `${name}.screen`), "bash-changed");
        await eventually(async () => await Bun.file(join(folder, `${name}.drawn`)).text().catch(() => "") === "bash-changed");
      }
      for (const answer of ["allow_once", "deny"]) {
        const response = await post(`${base}/${name}/answer`, { answer });
        check(response.status === 409, `${mode}: expected conflict`);
        report(`POST ${name}/answer ${answer}: ${response.status} ${await response.text()}`);
      }
      await Bun.sleep(100);
      check(!await Bun.file(join(folder, `${name}.keys`)).exists(), `${mode} received a key`);
      report(`${name}: no key received`);
    }
    const listed = Terminal.array().parse(JSON.parse(await execute(["term", "ls", "attention", "--json"])));
    check(listed.some(row => row.latestLine === "shell latest line"), "CLI lost latestLine");
    await eventually(async () => messages.some(message => message.type === "terminal.latest_line"));
    check(messages.some(message => message.type === "terminal.status" && "payload" in message && JSON.stringify(message.payload).includes("Claude requests permission")), "Stream lost request");
    report(`Live events: ${messages.filter(message => message.type === "terminal.latest_line").length} latest-line updates; status events include waiting requests`);
    report("PASS: Claude/Codex/shell latest lines, requests, four option mappings, CLI and safe rejections");
  } finally { socket.close(); }
}
