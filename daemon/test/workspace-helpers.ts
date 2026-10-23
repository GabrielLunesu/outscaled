import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function localRepository(root: string): string {
  const path = join(root, "source repo");
  mkdirSync(path);
  writeFileSync(join(path, "README.md"), "workspace fixture\n");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Workspace Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Workspace Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  for (const args of [["init"], ["add", "README.md"], ["-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: path, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  return pathToFileURL(path).href;
}
