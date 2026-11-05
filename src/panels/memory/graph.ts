// Memory graph layout and drawing rules (CONTRACT.md "Memory graph"). Pure, no
// React: a small deterministic force layout into a 0..1 box, node sizes, the
// unresolved-link stubs and the filter match. The view is MemoryGraphView.tsx.
import type { MemoryGraph, MemoryGraphNode } from "../../lib/ipc";

export type Point = { x: number; y: number };
/** Node id -> position in the 0..1 box. */
export type Positions = Record<string, Point>;

/** A tiny xorshift32 PRNG in 0..1; the same seed always gives the same sequence. */
export function xorshift(seed: number): () => number {
  let s = seed | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// Force constants, tuned on the real data (249 notes) and the tests' fixtures.
/** Pull to the centre, per unit of distance. */
const GRAVITY = 4;
/** Pull to the node's project centroid, per unit of distance (lighter than gravity). */
const CLUSTER = 0.6;
/** Starting step limit; it cools linearly to zero over the iterations. */
const START_TEMP = 0.08;
/** Margin left inside the 0..1 box after the final fit. */
const MARGIN = 0.02;

/**
 * Force layout: repulsion between all pairs, springs along edges, a weak pull to
 * the centre and to each project's centroid, cooling over the iterations.
 * Deterministic from `seed` (nodes are placed in id order, so the input order
 * does not matter). Returns a position per node id inside 0..1 on both axes,
 * the layout scaled uniformly and centred.
 */
export function layout(graph: Pick<MemoryGraph, "nodes" | "edges">, seed: number, iterations = 300): Positions {
  const ids = graph.nodes.map((n) => n.id).sort();
  const n = ids.length;
  const out: Positions = {};
  if (n === 0) return out;
  if (n === 1) {
    out[ids[0]] = { x: 0.5, y: 0.5 };
    return out;
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const byId = new Map(graph.nodes.map((nd) => [nd.id, nd]));

  // Project groups (the home dir is a group of its own).
  const groupOf = new Map<string, number>();
  const group = new Int32Array(n);
  ids.forEach((id, i) => {
    const key = byId.get(id)?.project ?? "";
    if (!groupOf.has(key)) groupOf.set(key, groupOf.size);
    group[i] = groupOf.get(key)!;
  });
  const groups = groupOf.size;
  const groupSize = new Float64Array(groups);
  for (let i = 0; i < n; i++) groupSize[group[i]]++;

  const ea: number[] = [];
  const eb: number[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    ea.push(a);
    eb.push(b);
  }

  const rand = xorshift(seed);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = rand();
    y[i] = rand();
  }
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const cx = new Float64Array(groups);
  const cy = new Float64Array(groups);
  const k = Math.sqrt(1 / n);
  const k2 = k * k;

  for (let it = 0; it < iterations; it++) {
    const temp = START_TEMP * (1 - it / iterations) + 1e-4;
    dx.fill(0);
    dy.fill(0);

    // Repulsion k^2 / d, each pair once.
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      for (let j = i + 1; j < n; j++) {
        let ddx = xi - x[j];
        let ddy = yi - y[j];
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 1e-9) {
          // Coincident: nudge apart along a fixed direction.
          ddx = 1e-3 * ((i % 7) - 3 || 1);
          ddy = 1e-3 * ((j % 5) - 2 || 1);
          d2 = ddx * ddx + ddy * ddy;
        }
        const f = k2 / d2;
        dx[i] += ddx * f;
        dy[i] += ddy * f;
        dx[j] -= ddx * f;
        dy[j] -= ddy * f;
      }
    }

    // Springs d^2 / k along edges.
    for (let e = 0; e < ea.length; e++) {
      const a = ea[e];
      const b = eb[e];
      const ddx = x[a] - x[b];
      const ddy = y[a] - y[b];
      const f = Math.sqrt(ddx * ddx + ddy * ddy) / k;
      dx[a] -= ddx * f;
      dy[a] -= ddy * f;
      dx[b] += ddx * f;
      dy[b] += ddy * f;
    }

    // Project centroids.
    cx.fill(0);
    cy.fill(0);
    for (let i = 0; i < n; i++) {
      cx[group[i]] += x[i];
      cy[group[i]] += y[i];
    }
    for (let g = 0; g < groups; g++) {
      cx[g] /= groupSize[g];
      cy[g] /= groupSize[g];
    }

    for (let i = 0; i < n; i++) {
      const g = group[i];
      dx[i] += (0.5 - x[i]) * GRAVITY;
      dy[i] += (0.5 - y[i]) * GRAVITY;
      if (groupSize[g] > 1) {
        dx[i] += (cx[g] - x[i]) * CLUSTER;
        dy[i] += (cy[g] - y[i]) * CLUSTER;
      }
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (len > 0) {
        const step = Math.min(len, temp) / len;
        x[i] += dx[i] * step;
        y[i] += dy[i] * step;
      }
    }
  }

  // Fit uniformly into the box, centred.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]);
    maxY = Math.max(maxY, y[i]);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const scale = (1 - 2 * MARGIN) / span;
  const offX = (1 - (maxX - minX) * scale) / 2;
  const offY = (1 - (maxY - minY) * scale) / 2;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  for (let i = 0; i < n; i++) {
    out[ids[i]] = { x: clamp01((x[i] - minX) * scale + offX), y: clamp01((y[i] - minY) * scale + offY) };
  }
  return out;
}

/** FNV-1a over the strings, as 8 hex digits. */
function fnv(parts: string[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A hash of what the layout depends on: node ids, their projects and the edges. */
export function graphHash(graph: Pick<MemoryGraph, "nodes" | "edges">): string {
  const nodes = graph.nodes.map((n) => `${n.id}\u0000${n.project ?? ""}`).sort();
  const edges = graph.edges.map((e) => `${e.from}\u0000${e.to}`).sort();
  return `${fnv(nodes)}${fnv(edges)}-${nodes.length}-${edges.length}`;
}

/** The seed the panel lays out with. */
export const LAYOUT_SEED = 1;

export type LaidOut = { hash: string; positions: Positions; ms: number };

const cache = new Map<string, LaidOut>();

/** layout() once per graph content (and seed); later calls return the cached result. */
export function layoutCached(graph: Pick<MemoryGraph, "nodes" | "edges">, seed = LAYOUT_SEED): LaidOut {
  const hash = graphHash(graph);
  const key = `${hash}:${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t0 = performance.now();
  const positions = layout(graph, seed);
  const result = { hash, positions, ms: Math.round((performance.now() - t0) * 10) / 10 };
  // A few entries are plenty: the graph changes only when notes do.
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

/** Circle radius in px: 4 + 1.5 per backlink, at most 14. */
export function nodeRadius(backlinks: number): number {
  return Math.min(14, 4 + 1.5 * Math.max(0, backlinks));
}

/** Length of an unresolved link's stub, in px. */
export const STUB_PX = 12;

/** Direction of an unresolved link's stub: a stable angle from the target name. */
export function stubAngle(target: string): number {
  const h = parseInt(fnv([target.toLowerCase()]), 16);
  return (h / 4294967296) * Math.PI * 2;
}

/** A name label is always shown from this many backlinks; below it only when zoomed in. */
export const LABEL_BACKLINKS = 3;
/** Zoom above which every node gets its label. */
export const LABEL_ZOOM = 1.2;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

/** The panel's search box: the name, title or description contains the query (case-insensitive). */
export function nodeMatches(q: string, n: Pick<MemoryGraphNode, "name" | "title" | "description">): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [n.name, n.title, n.description].some((f) => f?.toLowerCase().includes(s));
}

/** The tooltip's count line. */
export function countLine(n: Pick<MemoryGraphNode, "links" | "backlinks">): string {
  return `${n.links} ${n.links === 1 ? "link" : "links"}, ${n.backlinks} ${n.backlinks === 1 ? "backlink" : "backlinks"}`;
}

/** True for a MEMORY.md index node (not a note; not in the list view). */
export function isIndexNode(id: string): boolean {
  return id.endsWith("/MEMORY.md");
}
