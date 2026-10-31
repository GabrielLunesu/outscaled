import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServers } from "../src/cli/servers";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ws-servers-test-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function read(source?: string) {
  if (source !== undefined) writeFileSync(join(root, "servers.toml"), source);
  return readServers({ OUTSCALED_CONFIG_DIR: root });
}

test("missing and empty server lists include only local", () => {
  expect(read()).toEqual(["local"]);
  expect(read("")).toEqual(["local"]);
});

test("server list keeps file order after local and accepts SSH targets", () => {
  expect(read('[[server]]\nhost = "example-b"\n[[server]]\nhost = "user@[2001:db8::1]"\n[[server]]\nhost = "example-a"'))
    .toEqual(["local", "example-b", "user@[2001:db8::1]", "example-a"]);
});

for (const [source, detail] of [
  ['[[server]]\nhost = "example"\n[[server]]\nhost = "example"', "duplicate host: example"],
  ['[[server]]\nhost = "local"', "local is always included"],
  ['[[server]]\nhost = "-invalid"', "host must be an SSH"],
  ['[[server]]\nhost = "host command"', "host must be an SSH"],
  ['[[server]]\nhost = ""', "host must be an SSH"],
  ['[[server]]\nhost = 12', "expected a host string"],
  ['[[server]]\nname = "example"', "expected a host string"],
  ['[server]\nhost = "example"', "expected [[server]]"],
  ['[[servers]]\nhost = "example"', "expected [[server]]"],
  ['[[server', "servers.toml:"],
]) {
  test(`invalid server list: ${source}`, () => {
    expect(() => read(source)).toThrow(detail);
    expect(() => read(source)).toThrow("servers.toml:");
  });
}
