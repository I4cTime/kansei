import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNode } from "../lib/ipc";
import {
  clampScratchHeight,
  createSaver,
  draftPath,
  draftProject,
  droppedPaths,
  encodeKey,
  frameDraft,
  refFor,
  refsText,
  SAVE_DELAY,
  SCRATCH_DEFAULT,
  SCRATCH_MIN,
  sendBlocker,
  spliceRefs,
} from "./scratch";

const node = (path: string, kind: WorkspaceNode["kind"], children: WorkspaceNode[] = []): WorkspaceNode =>
  ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, children }) as WorkspaceNode;

describe("encodeKey", () => {
  it("encodes like Claude Code's project dirs", () => {
    expect(encodeKey("/home/me/Develop/lab/kansei")).toBe("-home-me-Develop-lab-kansei");
    expect(encodeKey("/home/me/Develop/sites/i4c-sites/")).toBe("-home-me-Develop-sites-i4c-sites");
    expect(encodeKey("/home/me/.config")).toBe("-home-me--config");
    expect(encodeKey("/srv/flatpak.i4c.studio")).toBe("-srv-flatpak-i4c-studio");
    expect(encodeKey("/x/my app/ü")).toBe("-x-my-app--");
  });

  it("puts the draft under <appData>/scratch", () => {
    expect(draftPath("/data/kansei/", "-a-b")).toBe("/data/kansei/scratch/-a-b.md");
  });

  it("keys a tab by its workspace project, else by its cwd", () => {
    const tree = [node("/dev", "root", [node("/dev/lab", "group", [node("/dev/lab/kansei", "project", [node("/dev/lab/kansei/site", "subproject")])])])];
    expect(draftProject("/dev/lab/kansei/src/app", tree)).toBe("/dev/lab/kansei");
    expect(draftProject("/dev/lab/kansei/site/", tree)).toBe("/dev/lab/kansei/site");
    expect(draftProject("/tmp/elsewhere/", tree)).toBe("/tmp/elsewhere");
    expect(draftProject("/dev/lab/kansei", null)).toBe("/dev/lab/kansei");
  });
});

describe("references", () => {
  it("makes paths inside the project relative", () => {
    expect(refFor("/dev/lab/kansei/src/app/App.tsx", "/dev/lab/kansei")).toBe("src/app/App.tsx");
    expect(refFor("/dev/lab/kansei/src/", "/dev/lab/kansei/")).toBe("src");
    expect(refFor("/dev/lab/kansei", "/dev/lab/kansei")).toBe(".");
  });

  it("keeps paths outside the project (and lookalike prefixes) absolute", () => {
    expect(refFor("/dev/lab/kansei-old/a.ts", "/dev/lab/kansei")).toBe("/dev/lab/kansei-old/a.ts");
    expect(refFor("/dev/products/aibou", "/dev/lab/kansei")).toBe("/dev/products/aibou");
    expect(refFor("/dev/a.ts", null)).toBe("/dev/a.ts");
  });

  it("writes one @reference per line", () => {
    expect(refsText(["/p/a.ts", "/q/b.md", " "], "/p")).toBe("@a.ts\n@/q/b.md");
    expect(refsText([], "/p")).toBe("");
  });

  it("spaces a reference from the words around it", () => {
    expect(spliceRefs("look at", 7, "@a.ts")).toEqual({ insert: " @a.ts", cursor: 13 });
    expect(spliceRefs("look at ", 8, "@a.ts")).toEqual({ insert: "@a.ts", cursor: 13 });
    expect(spliceRefs("ab", 1, "@x")).toEqual({ insert: " @x ", cursor: 4 });
    expect(spliceRefs("", 0, "@x")).toEqual({ insert: "@x", cursor: 2 });
  });

  it("reads absolute paths from a text/plain drop", () => {
    expect(droppedPaths("/dev/lab/kansei")).toEqual(["/dev/lab/kansei"]);
    expect(droppedPaths("/a\r\n/b\n")).toEqual(["/a", "/b"]);
    expect(droppedPaths("some words")).toBeNull();
    expect(droppedPaths("/a\nnot a path")).toBeNull();
    expect(droppedPaths("")).toBeNull();
  });
});

describe("frameDraft", () => {
  it("submits a bracketed paste with a carriage return", () => {
    expect(frameDraft("echo one\necho two\n", "submit")).toBe("\x1b[200~echo one\necho two\x1b[201~\r");
  });

  it("pastes without submitting", () => {
    expect(frameDraft("echo one\necho two", "paste")).toBe("\x1b[200~echo one\necho two\x1b[201~");
  });

  it("removes one trailing newline only, and paste markers inside the text", () => {
    expect(frameDraft("a\n\n", "paste")).toBe("\x1b[200~a\n\x1b[201~");
    expect(frameDraft("a\r\n", "paste")).toBe("\x1b[200~a\x1b[201~");
    expect(frameDraft("x\x1b[201~rm -rf\x1b[200~", "paste")).toBe("\x1b[200~xrm -rf\x1b[201~");
  });
});

describe("clampScratchHeight", () => {
  it("keeps 120 px to 60 % of the column", () => {
    expect(clampScratchHeight(220, 800)).toBe(220);
    expect(clampScratchHeight(50, 800)).toBe(SCRATCH_MIN);
    expect(clampScratchHeight(700, 800)).toBe(480);
    expect(clampScratchHeight(300.4, 800)).toBe(300);
  });

  it("never goes under the minimum in a short column, and waits for a measure", () => {
    expect(clampScratchHeight(220, 150)).toBe(SCRATCH_MIN);
    expect(clampScratchHeight(900, 0)).toBe(900);
    expect(clampScratchHeight(Number.NaN, 800)).toBe(SCRATCH_DEFAULT);
  });
});

describe("sendBlocker", () => {
  it("lets only a live tab with a pty receive", () => {
    expect(sendBlocker({ status: "alive", id: "p1" })).toBeNull();
    expect(sendBlocker(null)).toBe("No tab open");
    expect(sendBlocker({ status: "spawning", id: null })).toBe("The tab is still starting");
    expect(sendBlocker({ status: "dead", id: null })).toBe("The tab has exited");
    expect(sendBlocker({ status: "alive", id: null })).toBe("The tab is not running");
  });
});

describe("createSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes 400 ms after the last edit", () => {
    const write = vi.fn();
    const s = createSaver(write);
    s.schedule("k", "a");
    vi.advanceTimersByTime(300);
    s.schedule("k", "ab");
    vi.advanceTimersByTime(SAVE_DELAY - 1);
    expect(write).not.toHaveBeenCalled();
    expect(s.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("k", "ab");
    expect(s.pending()).toBe(false);
  });

  it("flushes now, once", async () => {
    const write = vi.fn();
    const s = createSaver(write);
    s.schedule("k", "x");
    await s.flush();
    expect(write).toHaveBeenCalledWith("k", "x");
    vi.advanceTimersByTime(SAVE_DELAY * 2);
    await s.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes the previous key's draft before scheduling another key", () => {
    const write = vi.fn();
    const s = createSaver(write);
    s.schedule("a", "one");
    s.schedule("b", "two");
    expect(write).toHaveBeenCalledWith("a", "one");
    vi.advanceTimersByTime(SAVE_DELAY);
    expect(write).toHaveBeenLastCalledWith("b", "two");
    expect(write).toHaveBeenCalledTimes(2);
  });
});
