import { describe, expect, it } from "vitest";
import type { TabActivity } from "../lib/ipc";
import { derive, dotFor, formatTokens, gaugeFor, isTerminalReport, newlyWaiting, stepTracks, TURN_FINISHED, type Track } from "./activity";

function act(pid: number, status: TabActivity["status"], extra: Partial<TabActivity> = {}): TabActivity {
  return { pid, sessionId: `s${pid}`, status, waitingFor: null, statusUpdatedAt: 1, context: null, ...extra };
}

/** Feed lists through the tracks and return the derived maps. */
function run(lists: TabActivity[][], seen: (pid: number) => boolean = () => false) {
  const tracks = new Map<number, Track>();
  return { tracks, out: lists.map((l) => (stepTracks(tracks, l, seen), derive(l, tracks))) };
}

describe("idle-after-busy rule", () => {
  it("a tab never busy in this process is idle", () => {
    const { out } = run([[act(1, "idle")], [act(1, "idle")]]);
    expect(out[1][1].status).toBe("idle");
  });

  it("busy then idle shows waiting (turn finished) until seen", () => {
    const { tracks, out } = run([[act(1, "busy")], [act(1, "idle")], [act(1, "idle")]]);
    expect(out[0][1].status).toBe("busy");
    expect(out[1][1]).toMatchObject({ status: "waiting", waitingFor: TURN_FINISHED });
    expect(out[2][1].status).toBe("waiting");
    tracks.get(1)!.unseen = false; // markTabSeen
    expect(derive([act(1, "idle")], tracks)[1].status).toBe("idle");
  });

  it("finishing while in view stays idle", () => {
    const { out } = run([[act(1, "busy")], [act(1, "idle")]], () => true);
    expect(out[1][1].status).toBe("idle");
  });

  it("agents waiting passes through, and waiting then idle counts as a finished turn", () => {
    const w = act(1, "waiting", { waitingFor: "permission prompt" });
    const { out } = run([[act(1, "busy")], [w], [act(1, "idle")]]);
    expect(out[1][1]).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });
    expect(out[2][1].waitingFor).toBe(TURN_FINISHED);
  });

  it("busy again clears it; a new session id on the pid starts fresh; gone pids are dropped", () => {
    const { tracks, out } = run([[act(1, "busy")], [act(1, "idle")], [act(1, "busy")], [act(1, "idle")], [act(1, "idle", { sessionId: "other" })], []]);
    expect(out[2][1].status).toBe("busy");
    expect(out[3][1].status).toBe("waiting");
    expect(out[4][1].status).toBe("idle");
    expect(tracks.size).toBe(0);
  });
});

describe("notifications", () => {
  const hiddenAll = () => true;
  it("fires once per transition into waiting, only while hidden", () => {
    const busy = { 1: act(1, "busy") };
    const waiting = { 1: act(1, "waiting", { waitingFor: "input needed" }) };
    expect(newlyWaiting(busy, waiting, hiddenAll)).toEqual([1]);
    expect(newlyWaiting(waiting, waiting, hiddenAll)).toEqual([]);
    expect(newlyWaiting(busy, waiting, () => false)).toEqual([]);
    expect(newlyWaiting({}, waiting, hiddenAll)).toEqual([1]);
    expect(newlyWaiting(waiting, busy, hiddenAll)).toEqual([]);
  });
});

describe("terminal reports are not input", () => {
  it("tells reports from keys", () => {
    for (const r of ["\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[I", "\x1b[O", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP>|xterm.js(5.5.0)\x1b\\", "\x1b[?2026;2$y", "\x1b[8;30;100t"])
      expect(isTerminalReport(r)).toBe(true);
    for (const k of ["a", "\r", "say hi\r", "\x1b", "\x1b[A", "\x03", "\x1b[<0;10;5M"]) expect(isTerminalReport(k)).toBe(false);
  });
});

describe("gauge", () => {
  it("formats tokens", () => {
    expect([formatTokens(950), formatTokens(123_456), formatTokens(200_000), formatTokens(999_600), formatTokens(1_000_000), formatTokens(1_500_000)]).toEqual([
      "950",
      "123k",
      "200k",
      "1M",
      "1M",
      "1.5M",
    ]);
  });

  it("is hidden without context and coloured by fill", () => {
    expect(gaugeFor(act(1, "idle"), 200_000, false)).toBeNull();
    expect(gaugeFor(null, 200_000, false)).toBeNull();
    const at = (tokens: number, extended = false, window = 200_000) => gaugeFor(act(1, "idle", { context: { tokens, model: "claude-fable-5-1" } }), window, extended)!;
    const g = at(123_000);
    expect(g).toMatchObject({ window: 200_000, percent: 62, tone: "ok", extended: false });
    expect(g.title.split("\n")[0]).toBe("123k of 200k tokens (62 %), claude-fable-5-1");
    expect(at(140_000).tone).toBe("warn");
    expect(at(180_000).tone).toBe("warn");
    expect(at(182_000).tone).toBe("danger");
    expect(at(250_000).fraction).toBe(1);
    const x = at(250_000, true);
    expect(x).toMatchObject({ window: 1_000_000, percent: 25, tone: "ok" });
    expect(x.title).toContain("went past 200k");
    expect(at(250_000, true, 2_000_000).window).toBe(2_000_000);
  });
});

describe("tab dot", () => {
  it("process state wins, then the session", () => {
    expect(dotFor({ status: "dead" }, act(1, "busy"))?.look).toBe("dead");
    expect(dotFor({ status: "spawning" }, null)?.look).toBe("spawning");
    expect(dotFor({ status: "alive" }, null)).toBeNull();
    expect(dotFor({ status: "alive" }, act(1, "busy"))).toEqual({ look: "busy", title: "Busy" });
    expect(dotFor({ status: "alive" }, act(1, "waiting", { waitingFor: "permission prompt" }))).toEqual({ look: "waiting", title: "Waiting: permission prompt" });
    expect(dotFor({ status: "alive" }, act(1, "idle"))?.look).toBe("idle");
  });
});
