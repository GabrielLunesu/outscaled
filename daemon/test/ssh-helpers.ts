import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SshInvocation {
  argv: string[];
  pid: number;
  unix: string;
  permissions: number;
  proxyPid?: number;
}

/** PATH contains only this fake; even a broken test cannot fall back to real ssh. */
export function fakeSsh(root: string) {
  const bin = join(root, "fake-bin");
  const log = join(root, "ssh.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
import { appendFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { connect, createServer } from "node:net";
const argv = process.argv.slice(2);
const forward = argv[argv.indexOf("-L") + 1];
const [unix, port] = forward.split(":127.0.0.1:");
const mode = process.env.WS_TEST_SSH_MODE;
let proxy;
if (mode === "proxy" || mode === "dead-proxy") {
  proxy = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
}
appendFileSync(process.env.WS_TEST_SSH_LOG, JSON.stringify({ argv, pid: process.pid, unix, permissions: statSync(dirname(unix)).mode & 0o777, proxyPid: proxy?.pid }) + "\\n");
if (mode === "dead-proxy") { console.error("Proxy failed"); process.exit(255); }
if (mode === "auth" || mode === "forward") {
  console.error(mode === "auth" ? "Permission denied (publickey)." : "Could not request local forwarding.");
  process.exit(255);
}
process.on("SIGTERM", () => { if (mode !== "ignore-term") process.exit(0); });
if (mode === "stall") { setInterval(() => {}, 1000); }
else {
  await Bun.sleep(Number(process.env.WS_TEST_SSH_DELAY ?? 0));
  createServer(socket => {
    const remote = connect({ host: "127.0.0.1", port: Number(port) });
    socket.pipe(remote).pipe(socket);
    socket.on("error", () => remote.destroy());
    remote.on("error", () => socket.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("close", () => socket.destroy());
  }).listen(unix);
  if (mode === "die") setTimeout(() => { console.error("Connection lost"); process.exit(255); }, 250);
}
`, { mode: 0o755 });
  return {
    env: { PATH: bin, WS_TEST_SSH_LOG: log },
    invocations: (): SshInvocation[] => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    assertClean(invocation: SshInvocation) {
      if (existsSync(invocation.unix) || existsSync(dirname(invocation.unix))) throw new Error("SSH socket directory leaked");
      try { process.kill(invocation.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      throw new Error("SSH process leaked");
    },
  };
}
