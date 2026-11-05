// The Memory panel's graph view (CONTRACT.md "Memory graph"): every memory note
// as a circle, the [[links]] between them as lines, unresolved links as short
// dashed stubs. The layout is computed once per graph (graph.ts); pan and zoom
// only rewrite the transform of one group, hover and selection only redraw a
// small overlay, and nothing animates. Read only: opening a note goes through
// the panel's editor sheet.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Maximize } from "lucide-react";
import type { MemoryGraph, MemoryGraphNode } from "../../lib/ipc";
import { accentFor, accentVar } from "../../app/accents";
import { registryAtom } from "../projects/workspaceStore";
import { Button } from "../ui";
import { ContextMenu } from "../shared/ContextMenu";
import { EmptyState } from "../shared/list";
import { useToast } from "../shared/hooks";
import {
  countLine,
  isIndexNode,
  LABEL_BACKLINKS,
  LABEL_ZOOM,
  layoutCached,
  nodeMatches,
  nodeRadius,
  STUB_PX,
  stubAngle,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./graph";

/** Space kept around the laid out box at zoom 1, in px. */
const PAD = 20;
const LABEL_PX = 10;
const LABEL_HALO_PX = 2.5;

type View = { k: number; tx: number; ty: number };
type Item = { node: MemoryGraphNode; x: number; y: number; r: number; fill: string };

export function MemoryGraphView({
  graph,
  q,
  projectLabel,
  onOpen,
  onReveal,
}: {
  graph: MemoryGraph;
  /** The panel's search box: non-matching nodes fade. */
  q: string;
  /** The label of a note's memory dir (project basename, "~ (home)", ...). */
  projectLabel: (noteId: string) => string;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
}) {
  const toast = useToast();
  const registry = useAtomValue(registryAtom);
  const laid = useMemo(() => layoutCached(graph), [graph]);

  // Measure the drawing area; the base mapping (zoom 1) fits the 0..1 box into it.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((cur) => (cur && cur.w === Math.round(r.width) && cur.h === Math.round(r.height) ? cur : { w: Math.round(r.width), h: Math.round(r.height) }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items = useMemo<Item[]>(() => {
    if (!size) return [];
    const side = Math.max(40, Math.min(size.w, size.h) - 2 * PAD);
    const ox = (size.w - side) / 2;
    const oy = (size.h - side) / 2;
    return graph.nodes.map((node) => {
      const p = laid.positions[node.id] ?? { x: 0.5, y: 0.5 };
      return {
        node,
        x: ox + p.x * side,
        y: oy + p.y * side,
        r: nodeRadius(node.backlinks),
        fill: node.project ? accentVar(accentFor(node.project, registry)) : "var(--fg-muted)",
      };
    });
  }, [graph, laid, size, registry]);
  const byId = useMemo(() => new Map(items.map((it) => [it.node.id, it])), [items]);

  const matched = useMemo(() => (q.trim() ? new Set(graph.nodes.filter((n) => nodeMatches(q, n)).map((n) => n.id)) : null), [graph, q]);
  const isOn = useCallback((id: string) => !matched || matched.has(id), [matched]);

  // Edges as two paths (full and faded) and the stubs as one: a few elements, not hundreds.
  const paths = useMemo(() => {
    let full = "";
    let faded = "";
    for (const e of graph.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const seg = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      if (isOn(e.from) && isOn(e.to)) full += seg;
      else faded += seg;
    }
    let stubs = "";
    let stubsFaded = "";
    for (const u of graph.unresolved) {
      const a = byId.get(u.from);
      if (!a) continue;
      const t = stubAngle(u.target);
      const c = Math.cos(t);
      const s = Math.sin(t);
      const seg = `M${(a.x + c * a.r).toFixed(1)} ${(a.y + s * a.r).toFixed(1)}l${(c * STUB_PX).toFixed(1)} ${(s * STUB_PX).toFixed(1)}`;
      if (isOn(u.from)) stubs += seg;
      else stubsFaded += seg;
    }
    return { full, faded, stubs, stubsFaded };
  }, [graph, byId, isOn]);

  const neighbours = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (a: string, b: string) => m.set(a, [...(m.get(a) ?? []), b]);
    for (const e of graph.edges) {
      add(e.from, e.to);
      add(e.to, e.from);
    }
    return m;
  }, [graph]);

  // Pan and zoom: a transform on one group, written directly (no re-render).
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const view = useRef<View>({ k: 1, tx: 0, ty: 0 });
  const [showAll, setShowAll] = useState(false);
  const applyView = useCallback(() => {
    const { k, tx, ty } = view.current;
    const g = world.current;
    if (!g) return;
    g.setAttribute("transform", `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})`);
    // Labels keep their on-screen size.
    const labels = g.querySelector("[data-graph-labels]");
    labels?.setAttribute("font-size", (LABEL_PX / k).toFixed(3));
    labels?.setAttribute("stroke-width", (LABEL_HALO_PX / k).toFixed(3));
    svg.current?.setAttribute("data-zoom", k.toFixed(3));
    setShowAll(k > LABEL_ZOOM);
  }, []);
  useLayoutEffect(applyView, [applyView, items]);

  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const fit = () => {
    view.current = { k: 1, tx: 0, ty: 0 };
    applyView();
  };

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = view.current;
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * Math.exp(-e.deltaY * 0.0015)));
      if (k === v.k) return;
      // Keep the world point under the cursor where it is.
      const wx = (mx - v.tx) / v.k;
      const wy = (my - v.ty) / v.k;
      view.current = { k, tx: mx - wx * k, ty: my - wy * k };
      setHover(null);
      applyView();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyView, size]);

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; id: number } | null>(null);
  const nodeOf = (t: EventTarget | null): string | null => (t instanceof Element ? (t.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null) : null);

  const copyName = (name: string) => {
    const text = `[[${name}]]`;
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.info(`Copied ${text}`))
      .catch((e) => toast.error(e, "Copy failed"));
  };

  if (graph.nodes.length === 0) {
    return <EmptyState title="No memory notes">Claude Code writes one file per memory under ~/.claude/projects/*/memory. Links between them are written as [[note-name]].</EmptyState>;
  }

  const tip = hover ? byId.get(hover) : undefined;
  const focus = [selected, hover].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  const menuNode = menu ? byId.get(menu.id)?.node : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        {size && (
          <svg
            ref={svg}
            data-memory-graph=""
            width={size.w}
            height={size.h}
            className="block cursor-grab select-none active:cursor-grabbing"
            role="img"
            aria-label={`Memory graph: ${graph.nodes.length} notes, ${graph.edges.length} links`}
            onPointerDown={(e) => {
              if (e.button !== 0 || nodeOf(e.target)) return;
              drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, id: e.pointerId };
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setHover(null);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              view.current = { ...view.current, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y };
              applyView();
            }}
            onPointerUp={(e) => {
              if (drag.current?.id === e.pointerId) drag.current = null;
            }}
            onPointerCancel={() => (drag.current = null)}
            onMouseOver={(e) => {
              if (drag.current) return;
              const id = nodeOf(e.target);
              if (id) setHover(id);
            }}
            onMouseOut={(e) => {
              const from = nodeOf(e.target);
              if (from && nodeOf(e.relatedTarget) !== from) setHover((cur) => (cur === from ? null : cur));
            }}
            onClick={(e) => {
              const id = nodeOf(e.target);
              if (!id) return;
              setSelected(id);
              onOpen(id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const id = nodeOf(e.target);
              if (id) setMenu({ id, x: e.clientX, y: e.clientY });
            }}
          >
            <g ref={world}>
              <path d={paths.faded} fill="none" stroke="var(--fg-muted)" strokeOpacity={0.35 * 0.25} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path data-graph-edges="" d={paths.full} fill="none" stroke="var(--fg-muted)" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={paths.stubsFaded} fill="none" stroke="var(--warn)" strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              <path data-graph-stubs="" d={paths.stubs} fill="none" stroke="var(--warn)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              <Highlight focus={focus} byId={byId} neighbours={neighbours} />
              <Nodes items={items} matched={matched} showAll={showAll} />
            </g>
          </svg>
        )}
        {tip && size && <Tooltip item={tip} view={view.current} size={size} project={projectLabel(tip.node.id)} />}
      </div>
      <div data-graph-legend="" className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] text-fg-muted tabular-nums">
        <span className="min-w-0 flex-1 truncate" title={`${laid.ms} ms layout`}>
          {graph.nodes.length} notes, {graph.edges.length} links, {graph.unresolved.length} unresolved
          {matched && `, ${matched.size} match`}
        </span>
        <Button variant="ghost" icon={Maximize} onClick={fit} title="Reset pan and zoom">
          Fit
        </Button>
      </div>
      {menu && menuNode && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menuNode.name}
          onClose={closeMenu}
          items={[
            {
              label: "Open",
              run: () => {
                setSelected(menuNode.id);
                onOpen(menuNode.id);
              },
            },
            { label: "Reveal in list", run: () => onReveal(menuNode.id), disabled: isIndexNode(menuNode.id) },
            { label: `Copy [[${menuNode.name}]]`, run: () => copyName(menuNode.name) },
          ]}
        />
      )}
    </div>
  );
}

/** Circles and labels. Memoised: hover, selection and pan never re-render it. */
const Nodes = memo(function Nodes({ items, matched, showAll }: { items: Item[]; matched: Set<string> | null; showAll: boolean }) {
  return (
    <>
      <g data-graph-nodes="">
        {items.map((it) => {
          const faded = !!matched && !matched.has(it.node.id);
          return (
            <circle
              key={it.node.id}
              data-node-id={it.node.id}
              data-faded={faded ? "" : undefined}
              cx={it.x.toFixed(1)}
              cy={it.y.toFixed(1)}
              r={it.r}
              fill={it.fill}
              opacity={faded ? 0.25 : 1}
              stroke="var(--bg)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              className="cursor-pointer"
            />
          );
        })}
      </g>
      <g data-graph-labels="" fill="var(--fg)" stroke="var(--bg)" paintOrder="stroke" strokeLinejoin="round" pointerEvents="none">
        {items.map((it) => {
          if (!showAll && it.node.backlinks < LABEL_BACKLINKS) return null;
          const faded = !!matched && !matched.has(it.node.id);
          return (
            <text key={it.node.id} x={(it.x + it.r + 2).toFixed(1)} y={(it.y + 3).toFixed(1)} opacity={faded ? 0.25 : 1}>
              {it.node.name}
            </text>
          );
        })}
      </g>
    </>
  );
});

/** The hovered and the selected node: their edges in the accent, and a ring. */
function Highlight({ focus, byId, neighbours }: { focus: string[]; byId: Map<string, Item>; neighbours: Map<string, string[]> }) {
  if (focus.length === 0) return null;
  let d = "";
  for (const id of focus) {
    const a = byId.get(id);
    if (!a) continue;
    for (const other of neighbours.get(id) ?? []) {
      const b = byId.get(other);
      if (b) d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    }
  }
  return (
    <g data-graph-highlight="" pointerEvents="none">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {focus.map((id) => {
        const it = byId.get(id);
        return it ? <circle key={id} data-ring-for={id} cx={it.x} cy={it.y} r={it.r + 2.5} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /> : null;
      })}
    </g>
  );
}

const TIP_W = 240;

function Tooltip({ item, view, size, project }: { item: Item; view: View; size: { w: number; h: number }; project: string }) {
  const sx = view.tx + item.x * view.k;
  const sy = view.ty + item.y * view.k;
  const off = item.r * view.k + 10;
  const left = sx + off + TIP_W <= size.w ? sx + off : Math.max(4, sx - off - TIP_W);
  const top = Math.min(Math.max(4, sy - 12), Math.max(4, size.h - 96));
  const n = item.node;
  return (
    <div
      data-graph-tooltip=""
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-ui border border-border bg-bg-raised px-2 py-1.5 shadow-lg shadow-black/30"
      style={{ left, top, width: TIP_W }}
    >
      <div className="truncate text-xs font-medium text-fg">{n.title}</div>
      {n.description && <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-fg-muted">{n.description}</div>}
      <div className="mt-1 flex gap-2 text-[11px] text-fg-muted">
        <span className="min-w-0 flex-1 truncate">{project}</span>
        <span className="shrink-0 tabular-nums">{countLine(n)}</span>
      </div>
    </div>
  );
}
