import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../lib/ipc";
import { projectKey } from "./model";
import { INDEX_MAX_AGE_MS, filterHits, indexIsStale, snippetParts, snippetText, wantsTranscripts } from "./search";

const hit = (sessionId: string, project: string | null): SearchHit => ({
  sessionId,
  project,
  title: sessionId,
  ts: 1,
  role: "user",
  snippet: "x",
  hits: 1,
  transcriptPath: `/t/${sessionId}.jsonl`,
});

describe("session search helpers", () => {
  it("splits a snippet at its marks", () => {
    expect(snippetParts("a \u0001hidden\u0002 b \u0001ws\u0002")).toEqual([
      { text: "a ", mark: false },
      { text: "hidden", mark: true },
      { text: " b ", mark: false },
      { text: "ws", mark: true },
    ]);
    expect(snippetParts("\u0001open to the end")).toEqual([{ text: "open to the end", mark: true }]);
    expect(snippetParts("")).toEqual([]);
  });

  it("plain snippet text, cut with an ellipsis", () => {
    expect(snippetText("a \u0001b\u0002  c")).toBe("a b c");
    expect(snippetText("abcdef", 3)).toBe("abc...");
    expect(snippetText("abc", 3)).toBe("abc");
  });

  it("searches transcripts from three characters", () => {
    expect(wantsTranscripts("ab")).toBe(false);
    expect(wantsTranscripts("  ab  ")).toBe(false);
    expect(wantsTranscripts("abc")).toBe(true);
  });

  it("index age", () => {
    expect(indexIsStale(null, 0)).toBe(true);
    expect(indexIsStale({ at: 1000 }, 1000 + INDEX_MAX_AGE_MS)).toBe(false);
    expect(indexIsStale({ at: 1000 }, 1001 + INDEX_MAX_AGE_MS)).toBe(true);
  });

  it("filters hits by project key", () => {
    const hits = [hit("a", "/p"), hit("b", null), hit("c", "/q")];
    expect(filterHits(hits, projectKey, "").map((h) => h.sessionId)).toEqual(["a", "b", "c"]);
    expect(filterHits(hits, projectKey, "/q").map((h) => h.sessionId)).toEqual(["c"]);
    expect(filterHits(hits, projectKey, projectKey(null)).map((h) => h.sessionId)).toEqual(["b"]);
  });
});
