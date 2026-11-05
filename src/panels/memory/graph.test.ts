import { describe, expect, it } from "vitest";
import type { MemoryGraph, MemoryGraphNode } from "../../lib/ipc";
import { countLine, graphHash, layout, layoutCached, nodeMatches, nodeRadius, stubAngle, xorshift } from "./graph";

function node(id: string, project: string | null = "/p"): MemoryGraphNode {
  return { id, name: id, title: id, description: null, type: null, project, bytes: 1, links: 0, backlinks: 0 };
}

function graph(ids: string[], edges: [string, string][], project: string | null = "/p"): MemoryGraph {
  return { nodes: ids.map((id) => node(id, project)), edges: edges.map(([from, to]) => ({ from, to })), unresolved: [] };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** n nodes over a few projects with about 1.5 edges per node, from a fixed seed. */
function randomGraph(n: number, seed = 42): MemoryGraph {
  const rand = xorshift(seed);
  const nodes = Array.from({ length: n }, (_, i) => node(`/m/${String(i).padStart(4, "0")}.md`, i % 9 === 0 ? null : `/p/${i % 7}`));
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < n * 1.5; i++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b) edges.push({ from: nodes[a].id, to: nodes[b].id });
  }
  return { nodes, edges, unresolved: [] };
}

describe("layout", () => {
  it("is deterministic from the seed and independent of node order", () => {
    const g = randomGraph(40);
    const a = layout(g, 7);
    expect(layout(g, 7)).toEqual(a);
    const shuffled = { ...g, nodes: [...g.nodes].reverse() };
    expect(layout(shuffled, 7)).toEqual(a);
    expect(layout(g, 8)).not.toEqual(a);
  });

  it("keeps every node inside the 0..1 box", () => {
    for (const g of [randomGraph(120), graph(["a", "b"], []), graph(["a", "b", "c"], [["a", "b"], ["b", "c"]])]) {
      const pos = layout(g, 3);
      expect(Object.keys(pos)).toHaveLength(g.nodes.length);
      for (const p of Object.values(pos)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it("puts a lone node in the centre and handles an empty graph", () => {
    expect(layout(graph(["a"], []), 1)).toEqual({ a: { x: 0.5, y: 0.5 } });
    expect(layout(graph([], []), 1)).toEqual({});
  });

  it("ends connected nodes closer than unconnected ones", () => {
    // Two 4-cliques and four loners, all in one project so clustering does not help.
    const left = ["l1", "l2", "l3", "l4"];
    const right = ["r1", "r2", "r3", "r4"];
    const clique = (xs: string[]) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as [string, string]));
    const g = graph([...left, ...right, "s1", "s2", "s3", "s4"], [...clique(left), ...clique(right)]);
    const pos = layout(g, 11);
    const linked = g.edges.map((e) => dist(pos[e.from], pos[e.to]));
    const ids = g.nodes.map((n) => n.id);
    const isEdge = (a: string, b: string) => g.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    const unlinked: number[] = [];
    ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => !isEdge(a, b) && unlinked.push(dist(pos[a], pos[b]))));
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean(linked)).toBeLessThan(mean(unlinked) * 0.6);
    // Every edge is shorter than the average unconnected pair.
    expect(Math.max(...linked)).toBeLessThan(mean(unlinked));
  });

  it("lays out 300 nodes in under 100 ms", () => {
    const g = randomGraph(300);
    layout(randomGraph(30), 1); // warm up the JIT
    const t0 = performance.now();
    layout(g, 1);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("layoutCached", () => {
  it("runs once per graph content", () => {
    const g = randomGraph(20, 5);
    const a = layoutCached(g);
    const b = layoutCached({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() });
    expect(b).toBe(a);
    const c = layoutCached({ ...g, edges: g.edges.slice(1) });
    expect(c).not.toBe(a);
    expect(c.hash).not.toBe(a.hash);
  });

  it("hashes ids, projects and edges", () => {
    const g = graph(["a", "b"], [["a", "b"]]);
    expect(graphHash(g)).toBe(graphHash(graph(["b", "a"], [["a", "b"]])));
    expect(graphHash(g)).not.toBe(graphHash(graph(["a", "b"], [["b", "a"]])));
    expect(graphHash(g)).not.toBe(graphHash(graph(["a", "b"], [["a", "b"]], null)));
  });
});

describe("drawing rules", () => {
  it("sizes nodes by backlinks, capped", () => {
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(2)).toBe(7);
    expect(nodeRadius(6)).toBe(13);
    expect(nodeRadius(7)).toBe(14);
    expect(nodeRadius(40)).toBe(14);
  });

  it("gives stubs a stable angle", () => {
    expect(stubAngle("ghost")).toBe(stubAngle("Ghost"));
    expect(stubAngle("ghost")).toBeGreaterThanOrEqual(0);
    expect(stubAngle("ghost")).toBeLessThan(Math.PI * 2);
    expect(stubAngle("ghost")).not.toBe(stubAngle("other"));
  });

  it("matches the filter on name, title and description", () => {
    const n = { name: "q-ring-flagship", title: "Q-ring", description: "The flagship product" };
    expect(nodeMatches("", n)).toBe(true);
    expect(nodeMatches("FLAGSHIP", n)).toBe(true);
    expect(nodeMatches("product", n)).toBe(true);
    expect(nodeMatches("aibou", n)).toBe(false);
    expect(nodeMatches("x", { name: "a", title: "b", description: null })).toBe(false);
  });

  it("writes the count line", () => {
    expect(countLine({ links: 1, backlinks: 0 })).toBe("1 link, 0 backlinks");
    expect(countLine({ links: 2, backlinks: 1 })).toBe("2 links, 1 backlink");
  });
});
