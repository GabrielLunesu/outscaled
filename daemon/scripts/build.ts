import { mkdir, rm, symlink } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile: { outfile: "dist/wsd" },
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
await rm("dist/ws", { force: true });
await symlink("wsd", "dist/ws");
