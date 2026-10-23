import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function count(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid memory statistics");
  return value;
}

export function parseVmStat(text: string): number {
  const pageSize = count(text, /\(page size of (\d+) bytes\)/);
  const anonymous = count(text, /^Anonymous pages:\s+(\d+)\.\s*$/m);
  const purgeable = count(text, /^Pages purgeable:\s+(\d+)\.\s*$/m);
  const wired = count(text, /^Pages wired down:\s+(\d+)\.\s*$/m);
  const compressed = count(text, /^Pages occupied by compressor:\s+(\d+)\.\s*$/m);
  if (pageSize === 0 || purgeable > anonymous) throw new Error("Invalid vm_stat counters");

  // App memory is resident anonymous memory minus reclaimable purgeable pages.
  // Add wired memory and the compressor's physical footprint, not its logical
  // "Pages stored in compressor" count. File cache is already excluded.
  const usedBytes = (anonymous - purgeable + wired + compressed) * pageSize;
  if (!Number.isSafeInteger(usedBytes)) throw new Error("Invalid vm_stat byte count");
  return usedBytes;
}

export function parseMeminfo(text: string): number {
  const total = count(text, /^MemTotal:\s+(\d+)\s+kB\s*$/m);
  const available = count(text, /^MemAvailable:\s+(\d+)\s+kB\s*$/m);
  const usedBytes = (total - available) * 1024;
  if (total === 0 || usedBytes < 0 || !Number.isSafeInteger(usedBytes)) throw new Error("Invalid meminfo counters");
  return usedBytes;
}

async function readMemoryStats(platform: NodeJS.Platform): Promise<string> {
  if (platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000 });
    return stdout;
  }
  return readFile("/proc/meminfo", "utf8");
}

export async function memoryUsage({
  platform = process.platform,
  totalBytes = totalmem(),
  freeBytes = freemem(),
  read = readMemoryStats,
}: {
  platform?: NodeJS.Platform;
  totalBytes?: number;
  freeBytes?: number;
  read?: (platform: NodeJS.Platform) => Promise<string>;
} = {}): Promise<{ totalBytes: number; usedBytes: number }> {
  try {
    if (platform === "darwin" || platform === "linux") {
      const text = await read(platform);
      const usedBytes = platform === "darwin" ? parseVmStat(text) : parseMeminfo(text);
      if (usedBytes <= totalBytes) return { totalBytes, usedBytes };
    }
  } catch {
    // Missing commands/files, timeouts and malformed output must not fail health.
  }
  return { totalBytes, usedBytes: totalBytes - freeBytes };
}
