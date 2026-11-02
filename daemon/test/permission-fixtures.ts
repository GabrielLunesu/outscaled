import { readFileSync } from "node:fs";
import { join } from "node:path";

// Full 110-column captures. Only model/plan text and local paths are replaced
// with equal-width neutral values; preserve whitespace, hints and blank rows.
const screens = {
  edit: "1-edit.txt", bash: "3-bash.txt", trust: "0-trust.txt",
  "after-no": "2-after-no.txt", "after-esc": "4-after-esc.txt",
} as const;

export function permissionFixture(name: keyof typeof screens): string {
  return readFileSync(join(import.meta.dir, "fixtures/permissions", screens[name]), "utf8");
}
