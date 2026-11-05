import { describe, expect, it } from "vitest";
import {
  afterClose,
  clampRatio,
  effectiveRight,
  nextActiveAfterClose,
  nextInOrder,
  splitFromFile,
  splitToFile,
  splitWithState,
  swapIntoLeft,
  toggleState,
  type Split,
} from "./split";

const S = (right: string | null, ratio = 0.5): Split => ({ right, ratio });

describe("swapIntoLeft", () => {
  it("swaps the right tab into the left and the active tab to the right", () => {
    expect(swapIntoLeft(S("b", 0.4), "a", "b")).toEqual(S("a", 0.4));
  });

  it("replaces the left pane only for a third tab", () => {
    const s = S("b");
    expect(swapIntoLeft(s, "a", "c")).toBe(s);
    expect(swapIntoLeft(S(null), "a", "b")).toEqual(S(null));
  });

  it("unsplits when there was no previous active tab", () => {
    expect(swapIntoLeft(S("b"), null, "b")).toEqual(S(null));
  });
});

describe("closing tabs", () => {
  it("unsplits on closing the right tab", () => {
    expect(afterClose(S("b", 0.6), "b")).toEqual(S(null, 0.6));
  });

  it("keeps the split on closing the left tab, activating a neighbour that is not the right tab", () => {
    // tabs a b c, active b (idx 1), right c: rest = a c; today's rule would pick c.
    expect(nextActiveAfterClose(["a", "c"], 1, S("c"))).toEqual({ active: "a", split: S("c") });
    // tabs a b c d, active b, right a: rest = a c d -> c, right stays a.
    expect(nextActiveAfterClose(["a", "c", "d"], 1, S("a"))).toEqual({ active: "c", split: S("a") });
    expect(afterClose(S("c"), "b")).toEqual(S("c"));
  });

  it("makes the right tab active when it is the only one left", () => {
    expect(nextActiveAfterClose(["b"], 0, S("b", 0.3))).toEqual({ active: "b", split: S(null, 0.3) });
    expect(nextActiveAfterClose([], 0, S(null))).toEqual({ active: null, split: S(null) });
  });

  it("matches the unsplit rule without a split", () => {
    expect(nextActiveAfterClose(["a", "c"], 1, S(null)).active).toBe("c");
    expect(nextActiveAfterClose(["a", "c"], 2, S(null)).active).toBe("c");
  });
});

describe("commands", () => {
  const keys = ["a", "b", "c"];

  it("clamps the ratio", () => {
    expect(clampRatio(0.1)).toBe(0.3);
    expect(clampRatio(0.9)).toBe(0.7);
    expect(clampRatio(0.45)).toBe(0.45);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });

  it("toggles with the next tab in rail order", () => {
    expect(toggleState(keys, "b", S(null))).toEqual(S("c"));
    expect(toggleState(keys, "c", S(null))).toEqual(S("a"));
    expect(toggleState(keys, "a", S("c"))).toEqual(S(null));
    expect(toggleState(["a"], "a", S(null))).toEqual(S(null));
    expect(nextInOrder(["a"], "a")).toBeNull();
  });

  it("splits with a tab, or for the active tab moves it to the right", () => {
    expect(splitWithState(keys, "a", S(null), "c")).toEqual({ active: "a", split: S("c") });
    expect(splitWithState(keys, "a", S(null), "a")).toEqual({ active: "b", split: S("a") });
    expect(splitWithState(keys, "a", S("c"), "a")).toEqual({ active: "c", split: S("a") });
    expect(splitWithState(keys, "a", S(null), "x")).toEqual({ active: "a", split: S(null) });
  });

  it("ignores a right tab that is gone or active", () => {
    expect(effectiveRight(S("x"), keys, "a")).toBeNull();
    expect(effectiveRight(S("a"), keys, "a")).toBeNull();
    expect(effectiveRight(S("b"), keys, "a")).toBe("b");
  });
});

describe("tabs.json", () => {
  const keys = ["a", "b", "c"];

  it("writes the right tab as an index and restores it with new keys", () => {
    const file = splitToFile(S("c", 0.35), keys, "a");
    expect(file).toEqual({ right: 2, ratio: 0.35 });
    const restored = splitFromFile(JSON.parse(JSON.stringify(file)), ["x", "y", "z"], 0);
    expect(restored).toEqual(S("z", 0.35));
    expect(splitToFile(S(null, 0.6), keys, "a")).toEqual({ right: null, ratio: 0.6 });
  });

  it("restores no split for a missing, out of range or active index", () => {
    expect(splitFromFile(undefined, keys, 0)).toEqual(S(null));
    expect(splitFromFile({ right: null, ratio: 0.4 }, keys, 0)).toEqual(S(null, 0.4));
    expect(splitFromFile({ right: 3, ratio: 0.5 }, keys, 0)).toEqual(S(null));
    expect(splitFromFile({ right: -1 }, keys, 0)).toEqual(S(null));
    expect(splitFromFile({ right: 1.5 }, keys, 0)).toEqual(S(null));
    expect(splitFromFile({ right: 1, ratio: 0.9 }, keys, 1)).toEqual(S(null, 0.7));
  });
});
