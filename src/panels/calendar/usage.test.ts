import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus, UsageBucket, UsageDay } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<IndexStatus>>(),
  days: vi.fn<(from: string, to: string) => Promise<UsageDay[]>>(),
}));
vi.mock("../../lib/ipc", () => ({ usage: ipc }));

import { store } from "../../app/store";
import {
  EMPTY_BUCKET,
  USAGE_STRIP_DAYS,
  cacheShare,
  formatTokens,
  inputTokens,
  loadUsage,
  mergeUsage,
  modelTurns,
  stripDays,
  sumBuckets,
  topProjects,
  usageDaysAtom,
  usageIsStale,
  usageLine,
  usageRange,
  usageStatusAtom,
} from "./usage";

const b = (turns: number, input: number, cacheCreate: number, cacheRead: number, output: number): UsageBucket => ({ turns, input, cacheCreate, cacheRead, output });
const day = (date: string, projects: Record<string, UsageBucket>, models: Record<string, UsageBucket> = {}): UsageDay => ({
  date,
  total: sumBuckets(Object.values(projects)),
  projects,
  models,
});
const STATUS: IndexStatus = { files: 3, indexed: 1, skipped: 2, bytes: 100, tookMs: 5, sessions: 2 };

describe("usage helpers", () => {
  it("sums buckets", () => {
    expect(sumBuckets([])).toEqual(EMPTY_BUCKET);
    expect(sumBuckets([b(1, 2, 3, 4, 5), b(10, 20, 30, 40, 50)])).toEqual(b(11, 22, 33, 44, 55));
  });

  it("computes the cache hit share over all input", () => {
    expect(inputTokens(b(1, 2, 66, 351_216, 1219))).toBe(351_284);
    expect(cacheShare(b(1, 2, 4, 94, 0))).toBe(94);
    expect(cacheShare(b(1, 1, 0, 2, 0))).toBe(67);
    expect(cacheShare(EMPTY_BUCKET)).toBeNull();
  });

  it("formats tokens with k, M and B", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(86_400)).toBe("86k");
    expect(formatTokens(999_600)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(86_000_000)).toBe("86M");
    expect(formatTokens(1_200_000_000)).toBe("1.2B");
    expect(formatTokens(-5)).toBe("0");
  });

  it("writes the day line", () => {
    expect(usageLine(b(41, 1000, 71_000, 1_128_000, 86_000))).toBe("1.2M in · 86k out · 94 % cache · 41 turns");
    expect(usageLine(b(1, 0, 0, 0, 5))).toBe("0 in · 5 out · 1 turn");
  });

  it("ranks projects by tokens in and models by turns", () => {
    const d = day(
      "2026-11-03",
      { "/a": b(1, 10, 0, 0, 0), "/b": b(5, 1, 0, 100, 0), "": b(1, 0, 0, 0, 1), "/c": b(1, 10, 0, 0, 0) },
      { fable: b(3, 0, 0, 0, 0), sonnet: b(5, 0, 0, 0, 0), opus: b(3, 0, 0, 0, 0) },
    );
    expect(topProjects(d, 5).map((p) => p.project)).toEqual(["/b", "/a", "/c", ""]);
    expect(topProjects(d, 2).map((p) => p.project)).toEqual(["/b", "/a"]);
    expect(topProjects(undefined, 5)).toEqual([]);
    expect(modelTurns(d)).toEqual([
      { model: "sonnet", turns: 5 },
      { model: "fable", turns: 3 },
      { model: "opus", turns: 3 },
    ]);
  });

  it("places the 14-day strip and the load range", () => {
    // A week containing today: the strip ends today.
    const s = stripDays("2026-11-02", "2026-11-08", "2026-11-04");
    expect(s).toHaveLength(USAGE_STRIP_DAYS);
    expect([s[0], s[13]]).toEqual(["2026-10-22", "2026-11-04"]);
    // A past week: the strip ends on its Sunday, across a month boundary.
    expect(stripDays("2026-10-26", "2026-11-01", "2026-11-04")[0]).toBe("2026-10-19");
    // A month: the load range only grows when the strip starts before it.
    expect(usageRange("2026-10-26", "2026-12-06", "2026-11-04")).toEqual({ from: "2026-10-22", to: "2026-12-06" });
    expect(usageRange("2025-12-29", "2026-01-04", "2026-11-04")).toEqual({ from: "2025-12-22", to: "2026-01-04" });
  });

  it("merges a range, dropping days that lost their usage", () => {
    const prev = new Map([
      ["2026-11-01", day("2026-11-01", { "/a": b(1, 1, 0, 0, 0) })],
      ["2026-11-03", day("2026-11-03", { "/a": b(1, 1, 0, 0, 0) })],
    ]);
    const next = mergeUsage(prev, "2026-11-02", "2026-11-04", [day("2026-11-04", { "/b": b(2, 1, 0, 0, 0) })]);
    expect([...next.keys()].sort()).toEqual(["2026-11-01", "2026-11-04"]);
  });
});

describe("loadUsage", () => {
  beforeEach(() => {
    ipc.refresh.mockReset().mockResolvedValue(STATUS);
    ipc.days.mockReset().mockImplementation(async (from) => [day(from, { "/a": b(1, 5, 0, 0, 1) })]);
    store.set(usageDaysAtom, new Map());
  });

  it("refreshes, reads and collapses calls within the debounce", async () => {
    vi.useFakeTimers();
    const first = loadUsage("2026-11-01", "2026-11-07");
    const second = loadUsage("2026-11-02", "2026-11-08");
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    const [r1, r2] = await Promise.all([first, second]);
    expect(ipc.refresh).toHaveBeenCalledTimes(1);
    expect(ipc.days).toHaveBeenCalledWith("2026-11-02", "2026-11-08");
    expect(r1).toEqual(r2);
    expect(r1.status).toEqual(STATUS);
    expect([...store.get(usageDaysAtom).keys()]).toEqual(["2026-11-02"]);
    expect(store.get(usageStatusAtom)?.status).toEqual(STATUS);
    expect(usageIsStale("2026-11-05")).toBe(false);
    expect(usageIsStale("2026-11-09")).toBe(true);
    expect(usageIsStale("2026-11-05", Date.now() + 10 * 60_000)).toBe(true);
  });

  it("rejects when the refresh fails and keeps the loaded days", async () => {
    store.set(usageDaysAtom, new Map([["2026-11-01", day("2026-11-01", { "/a": b(1, 1, 0, 0, 0) })]]));
    ipc.refresh.mockRejectedValueOnce(new Error("disk full"));
    await expect(loadUsage("2026-11-01", "2026-11-07", 0)).rejects.toThrow("disk full");
    expect(store.get(usageDaysAtom).size).toBe(1);
    // The next load still runs.
    await expect(loadUsage("2026-11-01", "2026-11-07", 0)).resolves.toMatchObject({ status: STATUS });
  });
});
