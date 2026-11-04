import { describe, expect, it } from "vitest";
import { contrast, isHex, PALETTE_KEYS } from "./palette";
import { PRESETS } from "./presets";

const IDS = ["night-city", "grid", "phosphor", "replicant", "mother", "nerv", "outrun"];

describe("PRESETS", () => {
  it("ships the seven contract presets with unique ids", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(IDS);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) expect(p.id).toMatch(/^[a-z0-9-]+$/);
  });

  it("has names and one-line taglines without em dashes", () => {
    for (const p of PRESETS) {
      expect(p.name.trim(), p.id).not.toBe("");
      expect(p.tagline.trim(), p.id).not.toBe("");
      expect(p.tagline, p.id).not.toMatch(/[\u2014\n]/);
    }
  });

  for (const preset of PRESETS) {
    describe(preset.id, () => {
      const p = preset.palette;
      it("has every key as #rrggbb and a mode", () => {
        expect(["dark", "light"]).toContain(p.mode);
        for (const k of PALETTE_KEYS) expect(isHex(p[k]), k).toBe(true);
        expect(Object.keys(p).sort()).toEqual(["mode", ...PALETTE_KEYS].sort());
      });
      it("passes the contrast gates", () => {
        expect(contrast(p.foreground, p.background)).toBeGreaterThanOrEqual(7);
        expect(contrast(p.accent, p.background)).toBeGreaterThanOrEqual(3);
        expect(contrast(p.dark_foreground, p.background)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("uses the effects the contract lists", () => {
    const fx = Object.fromEntries(PRESETS.map((p) => [p.id, p.effects ?? {}]));
    expect(fx).toEqual({
      "night-city": { glow: true, scanlines: true },
      grid: { glow: true, square: true },
      phosphor: { scanlines: true },
      replicant: { glow: true, scanlines: true },
      mother: { square: true },
      nerv: { glow: true },
      outrun: { glow: true },
    });
  });
});
