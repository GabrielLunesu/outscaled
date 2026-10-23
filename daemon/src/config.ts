import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  name: string;
  configDir: string;
  stateDir: string;
  statePath: string;
  workspacesDir: string;
  port: number;
  tmuxSocket?: string;
}

export function defaultPaths(platform: string, home: string) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("wsd supports macOS and Linux only");
  }
  return platform === "darwin"
    ? { configDir: join(home, ".config/wsd"), stateDir: join(home, ".local/share/wsd"), workspacesDir: join(home, "workspaces") }
    : { configDir: "/etc/wsd", stateDir: "/var/lib/wsd", workspacesDir: "/workspaces" };
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return 7770;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("WSD_PORT must be an integer between 1 and 65535");
  }
  return Number(value);
}

export function loadConfig(options: {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
  hostname?: string;
} = {}): Config {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const defaults = defaultPaths(platform, home);
  const configDir = resolve(env.WSD_CONFIG_DIR ?? defaults.configDir);
  const stateDir = resolve(env.WSD_STATE_DIR ?? defaults.stateDir);
  let file: Record<string, unknown> = {};
  try {
    file = Bun.TOML.parse(readFileSync(join(configDir, "config.toml"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const key of ["name", "workspaces_dir"]) {
    if (file[key] !== undefined && (typeof file[key] !== "string" || file[key].trim() === "")) {
      throw new Error(`config.toml: ${key} must be a non-empty string`);
    }
  }
  return {
    name: file.name as string | undefined ?? (options.hostname ?? hostname()).split(".")[0]!,
    configDir,
    stateDir,
    statePath: join(stateDir, "state.db"),
    workspacesDir: resolve(env.WSD_WORKSPACES_DIR ?? file.workspaces_dir as string | undefined ?? defaults.workspacesDir),
    port: parsePort(env.WSD_PORT),
    tmuxSocket: env.WSD_TMUX_SOCKET || undefined,
  };
}
