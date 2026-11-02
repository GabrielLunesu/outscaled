import { expect, test } from "bun:test";
import { CreateScheduleRequest, Schedule, ScheduleSummary, UpdateScheduleRequest } from "../src/index";

const input = { name: "review", runtime: "claude-code", every: "1m", prompt: '"quotes"\n$(touch pwned) `literal`' };
test("API schedules accept inline text, agent runtimes and the workspace interval/name rules", () => {
  for (const runtime of ["claude-code", "codex"]) expect(CreateScheduleRequest.parse({ ...input, runtime })).toEqual({ ...input, runtime });
  for (const patch of [{ runtime: "script" }, { name: "Bad" }, { name: "a".repeat(41) }, { every: "0m" }, { every: "1.5m" },
    { every: "999999999999999999d" }, { prompt: "" }, { prompt: "a\0b" }, { unexpected: true }]) {
    expect(CreateScheduleRequest.safeParse({ ...input, ...patch }).success).toBe(false);
  }
  expect(UpdateScheduleRequest.parse({ prompt: input.prompt })).toEqual({ prompt: input.prompt });
  expect(UpdateScheduleRequest.parse({ every: "2d" })).toEqual({ every: "2d" });
  for (const patch of [{}, { runtime: "codex" }, { name: "renamed" }, { every: "0s" }]) expect(UpdateScheduleRequest.safeParse(patch).success).toBe(false);
});

test("persisted workspace schedules have migration defaults and app schedules preserve arbitrary prompt text", () => {
  const old = { workspace: "demo", agent: "review", config: { ...input, mode: "scheduled", prompt: "prompts/review.md" },
    firstSeenAt: "2026-01-01T00:00:00.000Z", lastStartedAt: null, nextDueAt: "2026-01-01T00:01:00.000Z" };
  expect(Schedule.parse(old)).toMatchObject({ source: "workspace", paused: false });
  expect(Schedule.parse({ ...old, source: "app", paused: true, config: { ...input, mode: "scheduled" } }).config).toMatchObject({ prompt: input.prompt });
  const view = { workspace: "demo", ...input, source: "app", readOnly: false, command: null, paused: true, lastRun: null, nextRunAt: null };
  expect(ScheduleSummary.parse(view)).toEqual(view);
});
