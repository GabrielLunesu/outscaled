import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  OpenTerminalRequest, Slug, Terminal, TerminalInputRequest, TerminalOutput,
  TerminalOutputLines, TerminalStatus,
} from "@outscaled/protocol";
import { createClient } from "./client";

export async function mcp(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { on: { type: "string", default: "local" } } });
  const client = createClient(values.on);
  const server = new McpServer({ name: "ws", version: "0.0.0" });
  const target = { workspace: Slug, name: Slug };
  const path = (workspace: string, name?: string) => `/v1/workspaces/${workspace}/terminals${name === undefined ? "" : `/${name}`}`;
  const onboarding = "A freshly opened agent may show folder-trust or onboarding screens. Use read_output to inspect them and send_input with keys (such as Enter or Down) to answer before sending its prompt.";
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
  const safely = async (action: () => Promise<unknown>) => {
    try { return result(await action()); }
    catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  const stopped = new AbortController();
  server.server.onclose = () => stopped.abort();

  server.registerTool("list_terminals", {
    description: "List terminals, including name, process state, agent status and command. Omit workspace to list all workspaces on the selected server.",
    inputSchema: z.object({ workspace: Slug.optional() }),
  }, ({ workspace }) => safely(async () => Terminal.array().parse(await client.request("GET", workspace ? path(workspace) : "/v1/terminals"))));

  server.registerTool("open_terminal", {
    description: `Open a terminal in a workspace. Set command to codex or claude to launch an interactive agent; omit it for a shell. alwaysOn restarts failed processes. ${onboarding}`,
    inputSchema: OpenTerminalRequest.extend({ workspace: Slug }),
  }, ({ workspace, ...body }) => safely(async () => Terminal.parse(await client.request("POST", path(workspace), body))));

  server.registerTool("send_input", {
    description: `Paste text as one bracketed paste, then send tmux keys (e.g. Enter, Escape, Down, C-c), then Enter if submit is true. submit defaults to true when text is supplied; use false to edit without submitting. Submission immediately marks an agent working, so wait_for_status can follow safely. ${onboarding}`,
    inputSchema: TerminalInputRequest.safeExtend(target),
  }, ({ workspace, name, ...body }) => safely(async () => Terminal.parse(await client.request("POST", `${path(workspace, name)}/input`, body))));

  server.registerTool("wait_for_status", {
    description: "Wait for an agent status (idle by default). Polls without blocking other tool calls. Returns a tool error if the terminal stops running or the timeout expires. After opening, inspect onboarding with read_output before sending a prompt.",
    inputSchema: z.object({
      ...target, status: TerminalStatus.default("idle"),
      timeoutSeconds: z.number().min(0).max(3600).default(600),
    }),
  }, ({ workspace, name, status, timeoutSeconds }) => safely(async () => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (!stopped.signal.aborted) {
      const rows = Terminal.array().parse(await client.request("GET", path(workspace)));
      const terminal = rows.find(terminal => terminal.name === name);
      if (!terminal) throw new Error(`Terminal ${name} not found`);
      if (terminal.state !== "running") throw new Error(`Terminal ${name} is no longer running (state: ${terminal.state})`);
      if (terminal.status === status) return terminal;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${name} to become ${status}`);
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); stopped.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.min(500, remaining));
        stopped.signal.addEventListener("abort", finish, { once: true });
      });
    }
    throw new Error("MCP connection closed");
  }));

  server.registerTool("read_output", {
    description: `Read recent terminal output including scrollback, with wrapped lines joined and trailing blank lines removed. Defaults to 200 lines, maximum 5000. ${onboarding}`,
    inputSchema: z.object({ ...target, lines: TerminalOutputLines }),
  }, ({ workspace, name, lines }) => safely(async () => TerminalOutput.parse(await client.request("GET", `${path(workspace, name)}/output?lines=${lines}`))));

  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => { void server.close(); });
}
