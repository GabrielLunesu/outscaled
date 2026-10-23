import { basename } from "node:path";
import { runCli } from "./ws";
import { runDaemon } from "./wsd";

// argv0 preserves the invoked symlink name; execPath resolves to the real binary.
if (basename(process.argv0) === "ws") {
  process.exitCode = await runCli();
} else {
  runDaemon();
}
