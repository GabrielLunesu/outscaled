import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PermissionPrompt } from "@outscaled/protocol";

export function latestLine(text: string): string | null {
  const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const line = clean.split(/[\r\n]/).map(line => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()).findLast(Boolean);
  return line ? line.slice(0, 200).replace(/[\ud800-\udbff]$/, "") : null;
}

// A bounded tail may start or end inside a JSONL record. Neither fragment is
// evidence of a completed assistant message. Tool/thinking/user entries aren't text.
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export async function transcriptLatestLine(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const rows = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start) rows.shift();
    rows.pop();
    for (const row of rows.reverse()) {
      try {
        const entry = JSON.parse(row);
        if (entry?.type !== "assistant") continue;
        const content = entry.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
        const line = latestLine(text);
        if (line) return line;
      } catch { /* Incomplete or future transcript records are ignored. */ }
    }
  } catch { /* Hooks must still work if the transcript is missing or unreadable. */ }
  finally { await file?.close(); }
  return null;
}

export function permissionPrompt(screen: string): { prompt: PermissionPrompt; fingerprint: string } | null {
  const rows = screen.split("\n").map(row => row.trimEnd());
  const questions = rows.map((row, index) => /^\s*Do you want .+\?$/.test(row) ? index : -1).filter(index => index >= 0);
  if (questions.length !== 1) return null;
  const start = questions[0]!;
  const end = rows.findIndex((row, index) => index > start && row.trim() === "Esc to cancel");
  if (end < 0 || rows.slice(end + 1).some(row => row.trim())) return null;
  // Claude shortcuts are single keystrokes. Never send a multi-digit number:
  // its first digit could select an entirely different option.
  const options: PermissionPrompt["options"] = [];
  let selected = 0;
  for (const row of rows.slice(start + 1, end)) {
    if (!row.trim()) continue;
    const option = /^\s*(❯\s*)?([1-9])\. (\S.*)$/.exec(row);
    if (option) {
      if (option[1] && ++selected > 1) return null;
      const number = Number(option[2]);
      if (number !== options.length + 1) return null;
      options.push({ number, label: option[3]! });
    } else if (/^\s{6,}\S/.test(row) && options.length && !/^\s*\d+\./.test(row)) {
      options.at(-1)!.label += ` ${row.trim()}`;
    } else return null;
  }
  if (options.filter(option => option.label === "Yes").length !== 1 || options.filter(option => option.label === "No").length !== 1) return null;
  const prompt = { question: rows[start]!.trim(), options };
  // Include the tool's context above the question: two Bash commands can have
  // identical questions and options. Retain only a hash outside the public API.
  const fingerprint = createHash("sha256").update(rows.join("\n").trim()).digest("hex");
  return { prompt, fingerprint };
}
