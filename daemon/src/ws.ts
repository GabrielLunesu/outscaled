import { health } from "./cli/health";
import { newWorkspace } from "./cli/new";
import { term } from "./cli/term";
import { hook } from "./cli/hook";
import { status } from "./cli/status";
import { run } from "./cli/run";
import { attach } from "./cli/attach";

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const [command, ...options] = args;
  if (command === "hook") {
    // Even unexpected hook failures must never affect Claude's turn or stdout.
    await hook(options).catch(() => {});
    return 0;
  }
  try {
    switch (command) {
      case "health": await health(options); break;
      case "new": await newWorkspace(options); break;
      case "term": await term(options); break;
      case "attach": return await attach(options);
      case "status": return await status(options);
      case "run": await run(options); break;
      // Keep SDK startup out of the short-lived, best-effort hook command.
      case "mcp": await (await import("./cli/mcp")).mcp(options); break;
      default:
        console.error("usage: ws <health | new | term open | term ls | attach | status | run ls | run log | hook | mcp> [options]; ws attach <workspace> <name> [--on <server>]; ws status [--json] covers every server (no --on)");
        return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ws: ${message.replace(/[\r\n]+/g, " ")}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli();
