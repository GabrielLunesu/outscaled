import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateSshTarget } from "./ssh";

export function readServers(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = join(env.OUTSCALED_CONFIG_DIR ?? join(homedir(), ".config/outscaled"), "servers.toml");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["local"];
    throw new Error(`servers.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const file = Bun.TOML.parse(source) as Record<string, unknown>;
    if (Object.keys(file).some(key => key !== "server") || (file.server !== undefined && !Array.isArray(file.server))) {
      throw new Error("expected [[server]] entries with a host");
    }
    const servers = ["local"];
    for (const [index, entry] of ((file.server ?? []) as unknown[]).entries()) {
      if (typeof entry !== "object" || entry === null || !("host" in entry) || typeof entry.host !== "string"
        || Object.keys(entry).some(key => key !== "host")) {
        throw new Error(`server ${index + 1}: expected a host string`);
      }
      try { validateSshTarget(entry.host); } catch {
        throw new Error(`server ${index + 1}: host must be an SSH host alias or a [user@]host target`);
      }
      if (entry.host === "local") throw new Error("local is always included; remove it from the file");
      if (servers.includes(entry.host)) throw new Error(`duplicate host: ${entry.host}`);
      servers.push(entry.host);
    }
    return servers;
  } catch (error) {
    throw new Error(`servers.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
}
