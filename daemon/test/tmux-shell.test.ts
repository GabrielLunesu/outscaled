import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestLine } from "../src/attention";
import { Tmux } from "../src/tmux";
import { fixture } from "./helpers";

// Exercise row selection at the tmux boundary, without a daemon or shell
// configuration. Each pane has a fixed 20-column, six-row screen.
for (const { name, screen, expected } of [
  { name: "prompt on the cursor row", screen: "old\r\nLAST_OUTPUT\r\nsh-3.2$ ", expected: "LAST_OUTPUT" },
  { name: "multi-line prompt excludes only its cursor row", screen: "LAST_OUTPUT\r\ncontext\r\n$ ", expected: "context" },
  { name: "full screen with scrollback", screen: Array.from({ length: 12 }, (_, i) => `line-${i}\r\n`).join("") + "$ ", expected: "line-11" },
  { name: "empty screen", screen: "", expected: null },
  { name: "only a prompt", screen: "$ ", expected: null },
  { name: "blank rows above the cursor", screen: " \r\n\r\n$ ", expected: null },
  { name: "blank rows after output", screen: "LAST_OUTPUT\r\n\r\n \r\n$ ", expected: "LAST_OUTPUT" },
  { name: "wrapped output is joined before choosing the latest line", screen: "old\r\n" + "x".repeat(35) + "\r\n$ ", expected: "x".repeat(35) },
  { name: "cursor on the first row ignores history and stale rows below it", screen: "history\r\n".repeat(12) + "\x1b[HLIVE_PROMPT", expected: null },
  { name: "stale output below the cursor is ignored", screen: "LAST_OUTPUT\r\n$ \r\nSTALE_OUTPUT\x1b[2;3H", expected: "LAST_OUTPUT" },
]) {
  test(`shell latest line: ${name}`, async () => {
    const f = fixture();
    const tmux = new Tmux(f.env.WSD_TMUX_SOCKET);
    const script = join(f.root, "screen.ts");
    // A title marker after the screen confirms tmux parsed every output byte,
    // including cursor moves. It does not change the screen or cursor itself.
    writeFileSync(script, `process.stdout.write(${JSON.stringify(screen + "\x1b]2;shell-line-ready\x07")});\nawait Bun.sleep(600000);\n`);
    try {
      const created = Bun.spawnSync(["tmux", "-u", "-S", f.env.WSD_TMUX_SOCKET,
        "-f", "/dev/null", "new-session", "-d", "-x", "20", "-y", "6", "-s", "screen", process.execPath, script]);
      expect(created.exitCode).toBe(0);
      const deadline = Date.now() + 3000;
      while (Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "display-message", "-p", "-t", "=screen:", "#{pane_title}"]).stdout.toString().trim() !== "shell-line-ready") {
        if (Date.now() >= deadline) throw new Error("Timed out drawing screen");
        await Bun.sleep(20);
      }
      expect(latestLine(await tmux.captureShellScreen("=screen:"))).toBe(expected);
    } finally {
      Bun.spawnSync(["tmux", "-S", f.env.WSD_TMUX_SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
      f.cleanup();
    }
  });
}
