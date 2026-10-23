import { expect, test } from "bun:test";
import { CreateWorkspaceRequest, OpenTerminalRequest, Slug, Terminal, Workspace } from "@outscaled/protocol";
import { terminal, workspace } from "./helpers";

test("workspace and terminal names share the exact slug limits", () => {
  for (const name of ["a", "0", "a-1", "a".repeat(40)]) {
    expect(Slug.safeParse(name).success).toBe(true);
    expect(CreateWorkspaceRequest.safeParse({ slug: name }).success).toBe(true);
    expect(OpenTerminalRequest.safeParse({ name }).success).toBe(true);
  }
  for (const name of ["", "-a", "a_b", "a/b", "a b", "A", "a".repeat(41)]) {
    expect(Slug.safeParse(name).success).toBe(false);
  }
});

test("contracts preserve in-place registration and optional terminal host defaults", () => {
  expect(Workspace.parse({ ...workspace, inPlace: true }).inPlace).toBe(true);
  expect(OpenTerminalRequest.parse({ name: "shell" })).toEqual({ name: "shell" });
  expect(CreateWorkspaceRequest.safeParse({ slug: "demo", repo: "repo", path: "/example" }).success).toBe(false);
  for (const state of ["running", "restarting", "exited", "crashed"] as const) {
    expect(Terminal.parse({ ...terminal, state }).state).toBe(state);
  }
  expect(Terminal.safeParse({ ...terminal, session: "incorrect" }).success).toBe(false);
});
