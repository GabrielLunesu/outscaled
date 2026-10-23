import { expect, test } from "bun:test";
import { memoryUsage, parseMeminfo, parseVmStat } from "../src/memory";

// Synthetic snapshots: no machine-specific data.
const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            150000.
Pages inactive:                          120000.
Pages speculative:                       20000.
Pages throttled:                              0.
Pages wired down:                         80000.
Pages purgeable:                          15000.
"Translation faults":                1234567890.
Pages copy-on-write:                   12345678.
Pages zero filled:                    234567890.
Pages reactivated:                     34567890.
Pages purged:                          45678901.
File-backed pages:                       110000.
Anonymous pages:                         180000.
Pages stored in compressor:              600000.
Pages occupied by compressor:            100000.
Decompressions:                       56789012.
Compressions:                         67890123.
Pageins:                               7890123.
Pageouts:                               890123.
Swapins:                                90123.
Swapouts:                               12345.
`;

const meminfo = `MemTotal:        8192000 kB
MemFree:          128000 kB
MemAvailable:    3072000 kB
Buffers:          256000 kB
Cached:          2048000 kB
SwapCached:        16000 kB
Active:          4096000 kB
Inactive:        2048000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
SReclaimable:     640000 kB
`;

for (const pageSize of [4096, 16384]) {
  test(`vm_stat uses ${pageSize}-byte pages for app + wired + compressed memory`, () => {
    // (180000 - 15000) app + 80000 wired + 100000 physically compressed pages.
    expect(parseVmStat(vmStat.replace("16384 bytes", `${pageSize} bytes`))).toBe(345000 * pageSize);
  });
}

test("vm_stat accepts zero purgeable and compressor pages", () => {
  const text = vmStat.replace("15000.", "0.").replace(/(Pages occupied by compressor:\s+)100000\./, "$10.");
  expect(parseVmStat(text)).toBe(260000 * 16384);
});

test("meminfo subtracts MemAvailable, not MemFree or cache counters, and converts KiB", () => {
  expect(parseMeminfo(meminfo)).toBe(5242880000);
  expect(parseMeminfo(meminfo.replace("3072000 kB", "0 kB"))).toBe(8388608000);
  expect(parseMeminfo(meminfo.replace("3072000 kB", "8192000 kB"))).toBe(0);
});

test("parsers reject missing, malformed and impossible counters", () => {
  for (const text of ["", vmStat.replace("Anonymous pages:", "Unknown:"), vmStat.replace("16384 bytes", "0 bytes"),
    vmStat.replace("180000.", "invalid."), vmStat.replace("15000.", "999999."),
    vmStat.replace("16384 bytes", "99999999999999999999 bytes")]) {
    expect(() => parseVmStat(text)).toThrow();
  }
  for (const text of ["", meminfo.replace("MemAvailable:", "Unknown:"), meminfo.replace("3072000 kB", "9000000 kB"),
    meminfo.replace("3072000 kB", "-1 kB"), meminfo.replaceAll("kB", "MB")]) {
    expect(() => parseMeminfo(text)).toThrow();
  }
});

const totals = { totalBytes: 8 * 1024 ** 3, freeBytes: 128 * 1024 ** 2 };

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} uses parsed memory while retaining the OS total`, async () => {
    const ram = await memoryUsage({ ...totals, platform, read: async requested => {
      expect(requested).toBe(platform);
      return platform === "darwin" ? vmStat : meminfo;
    } });
    expect(ram).toEqual({ totalBytes: totals.totalBytes, usedBytes: platform === "darwin" ? 5652480000 : 5242880000 });
  });

  test(`${platform} falls back when the command or file read fails`, async () => {
    expect(await memoryUsage({ ...totals, platform, read: async () => { throw new Error("Read failed"); } }))
      .toEqual({ totalBytes: totals.totalBytes, usedBytes: totals.totalBytes - totals.freeBytes });
  });

  test(`${platform} falls back on malformed output or a result exceeding physical RAM`, async () => {
    for (const text of ["invalid output", platform === "darwin" ? vmStat.replace("180000.", "1800000.") : meminfo.replace("8192000 kB", "81920000 kB")]) {
      expect(await memoryUsage({ ...totals, platform, read: async () => text }))
        .toEqual({ totalBytes: totals.totalBytes, usedBytes: totals.totalBytes - totals.freeBytes });
    }
  });
}

test("unsupported platforms use the fallback without reading platform statistics", async () => {
  let reads = 0;
  expect(await memoryUsage({ ...totals, platform: "win32", read: async () => { reads++; return ""; } }))
    .toEqual({ totalBytes: totals.totalBytes, usedBytes: totals.totalBytes - totals.freeBytes });
  expect(reads).toBe(0);
});
