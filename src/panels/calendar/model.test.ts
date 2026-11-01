import { describe, expect, it } from "vitest";
import type { BoardItem } from "../../lib/ipc";
import {
  addDays,
  addMonths,
  dayPlan,
  dayTasks,
  emptySchedule,
  inMonth,
  isYmd,
  mergeActivity,
  monthGrid,
  sanitizeSchedule,
  startOfWeek,
  todayPlan,
  todayYmd,
  weekGrid,
  weekLabel,
  weekdayIndex,
  withOverride,
} from "./model";

describe("dates", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    // DST change in Europe and the US (no hour arithmetic, no drift).
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-11-01", 7)).toBe("2026-11-08");
  });

  it("knows weekdays (Monday = 0)", () => {
    expect(weekdayIndex("2026-11-01")).toBe(6);
    expect(weekdayIndex("2026-10-26")).toBe(0);
    expect(weekdayIndex("2024-02-29")).toBe(3);
    expect(startOfWeek("2026-11-01")).toBe("2026-10-26");
    expect(startOfWeek("2026-10-26")).toBe("2026-10-26");
  });

  it("validates dates and formats local today", () => {
    expect(isYmd("2026-11-01")).toBe(true);
    expect(isYmd("2026-02-29")).toBe(false);
    expect(isYmd("2026-1-01")).toBe(false);
    expect(todayYmd(new Date(2026, 10, 1, 23, 59))).toBe("2026-11-01");
    expect(todayYmd(new Date(2027, 0, 1, 0, 0))).toBe("2027-01-01");
  });
});

describe("week grid", () => {
  it("is Monday to Sunday and crosses month and year ends", () => {
    expect(weekGrid("2026-11-01")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(weekGrid("2026-12-30")).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
    expect(weekLabel("2026-12-30")).toBe("28 Dec to 3 Jan 2027");
  });
});

describe("month grid", () => {
  it("covers the month in whole Monday-first weeks", () => {
    const nov = monthGrid({ year: 2026, month: 11 });
    // 1 Nov 2026 is a Sunday: the first row starts on 26 Oct; 30 Nov is a Monday.
    expect(nov[0][0]).toBe("2026-10-26");
    expect(nov[0][6]).toBe("2026-11-01");
    expect(nov[nov.length - 1][0]).toBe("2026-11-30");
    expect(nov[nov.length - 1][6]).toBe("2026-12-06");
    expect(nov).toHaveLength(6);
    for (const row of nov) expect(row).toHaveLength(7);
  });

  it("handles February in leap and common years and the year end", () => {
    // Feb 2021 starts on a Monday and has 28 days: exactly four rows.
    const feb21 = monthGrid({ year: 2021, month: 2 });
    expect(feb21).toHaveLength(4);
    expect(feb21[0][0]).toBe("2021-02-01");
    expect(feb21[3][6]).toBe("2021-02-28");
    const feb24 = monthGrid({ year: 2024, month: 2 });
    expect(feb24.flat()).toContain("2024-02-29");
    const dec = monthGrid({ year: 2026, month: 12 });
    expect(dec[0][0]).toBe("2026-11-30");
    expect(dec[dec.length - 1][6]).toBe("2027-01-03");
    expect(inMonth("2027-01-03", { year: 2026, month: 12 })).toBe(false);
  });

  it("steps months across years", () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 11 }, -23)).toEqual({ year: 2024, month: 12 });
  });
});

describe("today's plan", () => {
  const schedule = sanitizeSchedule({
    rhythm: { sun: { area: "niwa", note: "rhythm note" }, mon: { area: "aibou", note: "" } },
    overrides: { "2026-11-01": { area: "tsukue", note: "board day" }, "2026-11-08": { area: null, note: "" }, junk: { area: "x" } },
  });

  it("prefers the override over the rhythm", () => {
    expect(todayPlan(schedule, "2026-11-01")).toEqual({ area: "tsukue", note: "board day", source: "override" });
    // An override can also clear the day.
    expect(todayPlan(schedule, "2026-11-08")).toEqual({ area: null, note: "", source: "override" });
    // Otherwise the weekday's rhythm (its note stays in the rhythm).
    expect(todayPlan(schedule, "2026-11-15")).toEqual({ area: "niwa", note: "", source: "rhythm" });
    expect(dayPlan(schedule, "2026-11-02").area).toBe("aibou");
    expect(dayPlan(null, "2026-11-02")).toEqual({ area: null, note: "", source: "rhythm" });
    expect(schedule.overrides.junk).toBeUndefined();
  });

  it("drops an override that repeats the rhythm", () => {
    const s = withOverride(schedule, "2026-11-01", { area: "niwa", note: "" });
    expect(s.overrides["2026-11-01"]).toBeUndefined();
    const t = withOverride(emptySchedule(), "2026-11-03", { area: "cryo", note: "  two\nlines " });
    expect(t.overrides["2026-11-03"]).toEqual({ area: "cryo", note: "two lines" });
    expect(withOverride(t, "2026-11-03", null).overrides).toEqual({});
  });
});

describe("tasks and activity per day", () => {
  const item = (n: number, status: BoardItem["status"], scheduled: string | null, title = `t${n}`): BoardItem => ({
    itemId: `I${n}`, number: n, repo: "I4cTime/aibou", title, url: "", state: "open", closedAt: null, isPr: false, status, kind: "Task",
    area: null, scheduled, started: null, target: null, order: null, doneWhen: null, outcome: null, parent: null, subIssues: { total: 0, completed: 0 },
  });

  it("lists a day's tasks by lane then title", () => {
    const items = [item(1, "Done", "2026-11-01"), item(2, "Ready", "2026-11-01", "b"), item(3, "Ready", "2026-11-01", "a"), item(4, "Backlog", "2026-11-02")];
    expect(dayTasks(items, "2026-11-01").map((i) => i.number)).toEqual([3, 2, 1]);
  });

  it("merges activity, most prompts first", () => {
    const m = mergeActivity([
      { date: "2026-11-01", projects: { "/d/aibou": 2, "/d/niwa": 5, "/d/none": 0 } },
      { date: "2026-11-02", projects: {} },
    ]);
    expect(m.get("2026-11-01")).toEqual([
      { project: "/d/niwa", count: 5 },
      { project: "/d/aibou", count: 2 },
    ]);
    expect(m.get("2026-11-02")).toEqual([]);
  });
});
