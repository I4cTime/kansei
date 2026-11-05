import { describe, expect, it } from "vitest";
import type { Command, CommandGroup } from "./commands";
import { EMPTY_GROUP_ROWS, MAX_ROWS, PREFIX_SCORE, RECENT_MAX, commandScore, pushRecent, rank, score } from "./fuzzy";

const cmd = (id: string, group: CommandGroup, title: string, keywords?: string[]): Command => ({ id, group, title, keywords, run: () => {} });

describe("score", () => {
  it("gives an exact prefix 100, case-insensitively", () => {
    expect(score("set", "Settings")).toBe(PREFIX_SCORE);
    expect(score("OPEN b", "Open Board")).toBe(PREFIX_SCORE);
    expect(score("", "anything")).toBe(0);
  });

  it("ranks a prefix above a scattered match", () => {
    // o and b at word starts (+3 each), a gap of four costs the capped 2.
    expect(score("ob", "Open Board")).toBe(4);
    expect(score("op", "Open Board")!).toBeGreaterThanOrEqual(score("ob", "Open Board")!);
    // Two word starts in a short command beat a mid-word run in a long title.
    expect(score("ob", "Open Board")!).toBeGreaterThan(score("ob", "fix the job runner that keeps restarting after the nightly build")!);
  });

  it("ranks word starts above mid-word characters", () => {
    expect(score("b", "Open Board")).toBe(3);
    expect(score("b", "Rename tab")).toBe(1);
    // t (word start) and b one character later: 3 + 1 - 1.
    expect(score("tb", "Rename tab")).toBe(3);
    expect(score("tb", "Rename tab")!).toBeGreaterThan(score("tb", "Toggle sidebar")!);
    // camelCase humps count as word starts.
    expect(score("ws", "openWithSheet")!).toBeGreaterThan(score("ws", "openwithsheet")!);
  });

  it("rewards adjacent characters and picks the best placement", () => {
    // s mid-word (+1), e adjacent (+2).
    expect(score("se", "Close tab")).toBe(3);
    // "re" could start at "Rename" (prefix) or later; prefix wins.
    expect(score("re", "Rename tab")).toBe(PREFIX_SCORE);
    // the word-start t of "tab" beats the earlier mid-word t of "Restart".
    expect(score("ta", "Restart tab")).toBe(5);
  });

  it("is null when a query character is missing", () => {
    expect(score("xyz", "Open Board")).toBeNull();
    expect(score("boards", "Open Board")).toBeNull();
  });

  it("takes the best of the title and each keyword", () => {
    expect(commandScore("sett", { title: "Open Settings", keywords: ["Settings"] })).toBe(PREFIX_SCORE);
    expect(commandScore("sett", { title: "Open Settings" })).toBe(3 + 2 + 2 + 2);
    expect(commandScore("zz", { title: "Open Settings", keywords: ["Settings"] })).toBeNull();
  });
});

describe("rank", () => {
  const set = [
    cmd("theme:effects", "Themes", "Toggle visual effects"),
    cmd("tab:close", "Tabs", "Close tab"),
    cmd("project:/d/sentinel", "Projects", "Open sentinel", ["sentinel"]),
    cmd("panel:settings", "Panels", "Open Settings", ["Settings"]),
    cmd("panel:sessions", "Panels", "Open Sessions", ["Sessions"]),
    cmd("theme:dark", "Themes", "Theme: Dark", ["Dark"]),
  ];

  it("orders by score, then group, then title, dropping non-matches", () => {
    expect(rank(set, "se").map((c) => c.id)).toEqual(["panel:sessions", "panel:settings", "project:/d/sentinel", "tab:close", "theme:effects"]);
  });

  it("shows at most 40 rows for a query", () => {
    const many = Array.from({ length: 60 }, (_, i) => cmd(`project:/p${i}`, "Projects", `Open p${i}`));
    expect(rank(many, "open")).toHaveLength(MAX_ROWS);
  });

  it("lists recent first for the empty query, then groups, Tabs and Panels complete", () => {
    const tabs = Array.from({ length: 9 }, (_, i) => cmd(`tab:${i}`, "Tabs", `Switch to t${i}`));
    const projects = Array.from({ length: 9 }, (_, i) => cmd(`project:/p${i}`, "Projects", `Open p${i}`));
    const themes = Array.from({ length: 9 }, (_, i) => cmd(`theme:${i}`, "Themes", `Theme: ${i}`));
    const all = [...themes, ...projects, ...tabs];
    const rows = rank(all, "  ", ["theme:3", "gone", "project:/p8"]);
    expect(rows.slice(0, 2).map((c) => c.id)).toEqual(["theme:3", "project:/p8"]);
    expect(rows.filter((c) => c.group === "Tabs")).toHaveLength(9);
    expect(rows.slice(2, 11).every((c) => c.group === "Tabs")).toBe(true);
    // Projects cut to 6 (p8 is already listed as recent and not repeated).
    expect(rows.slice(11, 17).map((c) => c.id)).toEqual(["project:/p0", "project:/p1", "project:/p2", "project:/p3", "project:/p4", "project:/p5"]);
    expect(rows.filter((c) => c.group === "Themes" && c.id !== "theme:3")).toHaveLength(EMPTY_GROUP_ROWS);
    expect(rows.filter((c) => c.id === "theme:3")).toHaveLength(1);
  });

  it("caps the recent rows at 8", () => {
    const list = Array.from({ length: 12 }, (_, i) => cmd(`theme:${i}`, "Themes", `Theme: ${i}`));
    const recent = list.map((c) => c.id).reverse();
    const rows = rank(list, "", recent);
    expect(rows.slice(0, RECENT_MAX).map((c) => c.id)).toEqual(recent.slice(0, RECENT_MAX));
    // The four left over follow in group order; nothing is repeated.
    expect(rows.slice(RECENT_MAX).map((c) => c.id)).toEqual(["theme:0", "theme:1", "theme:2", "theme:3"]);
  });
});

describe("pushRecent", () => {
  it("moves the id to the front without duplicates and keeps 8", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    const eight = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(pushRecent(eight, "new")).toEqual(["new", "1", "2", "3", "4", "5", "6", "7"]);
  });
});
