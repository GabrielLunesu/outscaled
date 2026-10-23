import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { defaultPaths, loadConfig } from "../src/config";
import { fixture } from "./helpers";

let f: ReturnType<typeof fixture> | undefined;
afterEach(() => f?.cleanup());

test("OS defaults and short hostname, without reading real user paths", () => {
  f = fixture();
  expect(defaultPaths("linux", f.root)).toEqual({ configDir: "/etc/wsd", stateDir: "/var/lib/wsd", workspacesDir: "/workspaces" });
  const config = loadConfig({ platform: "darwin", home: f.root, hostname: "test-host.example", env: {} });
  expect(config).toMatchObject({
    configDir: join(f.root, ".config/wsd"), statePath: join(f.root, ".local/share/wsd/state.db"),
    workspacesDir: join(f.root, "workspaces"), name: "test-host", port: 7770, tmuxSocket: undefined,
  });
});

test("config.toml overrides defaults; env overrides config and OS paths", () => {
  f = fixture();
  const configured = join(f.root, "configured-workspaces");
  writeFileSync(join(f.env.WSD_CONFIG_DIR, "config.toml"), `name = "fixture"\nworkspaces_dir = ${JSON.stringify(configured)}\n`);
  const env: NodeJS.ProcessEnv = { ...f.env };
  delete env.WSD_WORKSPACES_DIR;
  delete env.WSD_PORT;
  expect(loadConfig({ env, platform: "linux" })).toMatchObject({ name: "fixture", workspacesDir: configured, port: 7770 });
  expect(loadConfig({ env: { ...f.env, WSD_PORT: "8123" }, platform: "linux" })).toMatchObject({
    name: "fixture", configDir: f.env.WSD_CONFIG_DIR, stateDir: f.env.WSD_STATE_DIR,
    statePath: join(f.env.WSD_STATE_DIR, "state.db"), workspacesDir: f.env.WSD_WORKSPACES_DIR,
    port: 8123, tmuxSocket: f.env.WSD_TMUX_SOCKET,
  });
});

test("macOS default config location is read beneath a temporary home", () => {
  f = fixture();
  const dir = join(f.root, ".config/wsd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), 'name = "mac-fixture"');
  expect(loadConfig({ env: {}, platform: "darwin", home: f.root }).name).toBe("mac-fixture");
});

test("invalid config and ports fail clearly", () => {
  f = fixture();
  for (const port of ["0", "65536", "abc", "7770oops", "1.5", ""]) {
    expect(() => loadConfig({ env: { ...f!.env, WSD_PORT: port } })).toThrow("WSD_PORT");
  }
  writeFileSync(join(f.env.WSD_CONFIG_DIR, "config.toml"), "name = 12");
  expect(() => loadConfig({ env: f!.env })).toThrow("name must be a non-empty string");
  writeFileSync(join(f.env.WSD_CONFIG_DIR, "config.toml"), "this is not TOML");
  expect(() => loadConfig({ env: f!.env })).toThrow();
});
