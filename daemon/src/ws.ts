import { health } from "./cli/health";
import { newWorkspace } from "./cli/new";
import { term } from "./cli/term";

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const [command, ...options] = args;
  try {
    switch (command) {
      case "health": await health(options); break;
      case "new": await newWorkspace(options); break;
      case "term": await term(options); break;
      default:
        console.error("usage: ws <health | new | term open | term ls> [--on local] [--json]");
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
