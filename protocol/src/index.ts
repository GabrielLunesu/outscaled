import { z } from "zod";

export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime();

export const Health = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  uptimeSec: z.number().nonnegative(),
  cpu: z.object({
    cores: z.number().int().positive(),
    load1: z.number().nonnegative(),
    usagePct: z.number().min(0).max(100),
  }),
  ram: z.object({ totalBytes: count, usedBytes: count }),
  disk: z.object({ path: z.string(), totalBytes: count, usedBytes: count }),
  terminals: z.object({ total: count, running: count }),
});
export type Health = z.infer<typeof Health>;

export const Workspace = z.object({
  slug: Slug,
  path: z.string().min(1),
  repo: z.string().nullable(),
  inPlace: z.boolean(),
  createdAt: timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

export const CreateWorkspaceRequest = z.object({
  slug: Slug,
  repo: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).refine(value => value.repo === undefined || value.path === undefined, {
  message: "repo and path are mutually exclusive",
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const TerminalState = z.enum(["running", "restarting", "exited", "crashed"]);
export type TerminalState = z.infer<typeof TerminalState>;
export const TerminalRuntime = z.enum(["claude-code", "codex"]);
export type TerminalRuntime = z.infer<typeof TerminalRuntime>;
export const TerminalStatus = z.enum(["starting", "working", "needs_input", "idle"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;
export const Terminal = z.object({
  id: z.string().min(1),
  workspace: Slug,
  name: Slug,
  command: z.string().min(1),
  session: z.string(),
  alwaysOn: z.boolean(),
  state: TerminalState,
  runtime: TerminalRuntime.nullable(),
  status: TerminalStatus.nullable(),
  statusChangedAt: timestamp.nullable(),
  restarts: count,
  pid: z.number().int().positive().nullable(),
  createdAt: timestamp,
}).refine(value => value.session === `ws-${value.workspace}-${value.name}`, {
  path: ["session"],
  message: "session must be ws-<workspace>-<name>",
}).refine(value => (value.runtime !== null || value.status === null) &&
  (value.status === null) === (value.statusChangedAt === null), {
  path: ["status"],
  message: "agent status requires a runtime and a status change time",
});
export type Terminal = z.infer<typeof Terminal>;

// The host resolves an omitted command to the user's login shell when opening it.
export const OpenTerminalRequest = z.object({
  name: Slug,
  command: z.string().min(1).optional(),
  alwaysOn: z.boolean().optional(),
});
export type OpenTerminalRequest = z.infer<typeof OpenTerminalRequest>;

// Preserve Claude's raw JSON, including fields added by newer versions.
export const ClaudeCodeHookPayload = z.looseObject({
  hook_event_name: z.string().min(1),
  notification_type: z.string().optional(),
});
export type ClaudeCodeHookPayload = z.infer<typeof ClaudeCodeHookPayload>;
export const ClaudeCodeHookRequest = z.object({
  terminal: z.string().min(1),
  payload: ClaudeCodeHookPayload,
});

// Codex appends one JSON argument to its notify argv; preserve future fields.
export const CodexHookPayload = z.looseObject({
  type: z.string().min(1),
});
export type CodexHookPayload = z.infer<typeof CodexHookPayload>;
export const CodexHookRequest = z.object({
  terminal: z.string().min(1),
  payload: CodexHookPayload,
});

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Event = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  workspace: Slug.nullable(),
  terminal: z.string().nullable(),
  payload: z.json(),
  time: timestamp,
  acked: z.boolean(),
});
export type Event = z.infer<typeof Event>;
