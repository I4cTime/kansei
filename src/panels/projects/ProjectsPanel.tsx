import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderPlus, History, Layers, Link2, Pencil, Pin, PinOff, Play, RotateCcw, Terminal } from "lucide-react";
import { memory, projects, sessions, type MemoryProject, type ProjectsInfo, type Session, type WorkspaceNode } from "../../lib/ipc";
import { prefsAtom, setPrefs } from "../../app/prefs";
import { projectAtom } from "../../app/project";
import { CLAUDE, SHELL_COMMAND, activeTabAtom, openTab } from "../../app/tabs";
import { store } from "../../app/store";
import { Badge, Button, IconButton, Select, cx } from "../ui";
import { getPaths, useToast } from "../shared/hooks";
import { EmptyState, Panel, SearchInput, SectionHeader } from "../shared/list";
import { openSheet } from "../shared/Sheet";
import { tildify } from "../shared/paths";
import { absoluteTime, plural, relativeTime } from "../shared/format";
import { sessionsProjectFilterAtom } from "../sessions/model";
import { addProjectWithPicker, hideProject, pinProject, unhideProject, unpinProject } from "./actions";
import { collectPaths, filterRows, groupRows, mergeProjects, normPath, NO_FLAGS, queryWords, type ProjectFilter, type ProjectRow } from "./model";
import { EditSheet, PickerSheet } from "./sheets";
import {
  EMPTY_ENTRY,
  countProjects,
  entryOf,
  filterTree,
  indexTree,
  pickItems,
  relatedName,
  rootParts,
  type ProjectStatus,
  type RegistryEntry,
  type TreeRef,
} from "./workspace";
import { registryAtom, saveEntry, saveRelated, scanWorkspaces, treeAtom } from "./workspaceStore";

const AUTO_REFRESH_MS = 15_000;
/** projects_info looks at no more than this many paths per call. */
const INFO_CHUNK = 500;

type Snapshot = { list: Session[]; mem: MemoryProject[]; home: string; info: Map<string, ProjectsInfo> };

async function fetchInfo(paths: string[]): Promise<Map<string, ProjectsInfo>> {
  const out = new Map<string, ProjectsInfo>();
  for (let i = 0; i < paths.length; i += INFO_CHUNK) {
    for (const x of await projects.info(paths.slice(i, i + INFO_CHUNK))) out.set(x.path, x);
  }
  // Never leave a requested path without facts, so it is not fetched again and again.
  for (const p of paths) if (!out.has(p)) out.set(p, { path: p, canonical: null, exists: false, flags: NO_FLAGS });
  return out;
}

/** Paths the tree adds as rows: every project and subproject, plus home. */
function treeRowPaths(tree: WorkspaceNode[], home: string | undefined): string[] {
  const out = [...indexTree(tree).keys()];
  if (home) out.push(normPath(home));
  return out;
}

/**
 * Sessions, memory projects, the workspace scan and folder facts. Manual loads
 * show the spinner and toast every error; background loads are silent and
 * toast only on a new failure. A failing scan does not block the rest.
 */
function useProjects() {
  const toast = useToast();
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const failing = useRef(false);
  const scanFailing = useRef(false);

  const load = useCallback(
    async (silent: boolean) => {
      const my = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const scan = scanWorkspaces().then(
          (tree) => {
            scanFailing.current = false;
            return tree;
          },
          (e) => {
            if (!silent || !scanFailing.current) toast.error(e, "Could not scan workspace roots");
            scanFailing.current = true;
            return store.get(treeAtom) ?? [];
          },
        );
        const [list, mem, paths, tree] = await Promise.all([sessions.list(), memory.projects(), getPaths(), scan]);
        const prefs = store.get(prefsAtom);
        const info = await fetchInfo(collectPaths(list, mem, prefs.pinnedProjects, prefs.hiddenProjects, treeRowPaths(tree, paths.home)));
        if (my === seq.current) setData({ list, mem, home: paths.home, info });
        failing.current = false;
      } catch (e) {
        if (my === seq.current && (!silent || !failing.current)) toast.error(e, "Could not list projects");
        failing.current = true;
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(false);
    const t = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  return { data, setData, loading, reload: load };
}

const VIEWS: { id: ProjectFilter; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "recent", label: "Recent" },
  { id: "all", label: "All" },
];

const STATUS_TONE: Record<ProjectStatus, "muted" | "accent" | "ok" | "warn"> = {
  idea: "muted",
  active: "accent",
  live: "ok",
  parked: "warn",
  archived: "muted",
};

const NOT_IN_WORKSPACE = "Only for projects under a workspace root (Settings, This app, Projects)";

type RowMeta = {
  ref: TreeRef | null;
  entry: RegistryEntry;
  related: { path: string; name: string }[];
};

type ActionName = "open" | "shell" | "openWith" | "resume" | "sessions" | "related" | "edit" | "pin" | "hide";
type Actions = Record<ActionName, (r: ProjectRow, m: RowMeta) => unknown>;

export function ProjectsPanel() {
  const toast = useToast();
  const { data, setData, loading, reload } = useProjects();
  const prefs = useAtomValue(prefsAtom);
  const tree = useAtomValue(treeAtom);
  const registry = useAtomValue(registryAtom);
  const activeRoot = useAtomValue(projectAtom)?.root ?? null;
  const activeTab = useAtomValue(activeTabAtom);
  const setSessionsFilter = useSetAtom(sessionsProjectFilterAtom);
  const [q, setQ] = useState("");
  const [view, setView] = useState<ProjectFilter>("tree");
  const [now, setNow] = useState(() => Date.now());

  const home = data?.home;
  useEffect(() => setNow(Date.now()), [data]);

  const trees = useMemo(() => tree ?? [], [tree]);
  const index = useMemo(() => indexTree(trees), [trees]);
  const treePaths = useMemo(() => treeRowPaths(trees, home), [trees, home]);

  // A folder pinned, hidden or scanned since the last load: fetch its facts.
  useEffect(() => {
    if (!data) return;
    const missing = [...new Set([...prefs.pinnedProjects, ...prefs.hiddenProjects, ...treePaths].map(normPath))].filter((p) => p.startsWith("/") && !data.info.has(p));
    if (missing.length === 0) return;
    let live = true;
    fetchInfo(missing).then(
      (extra) => live && setData((d) => (d ? { ...d, info: new Map([...d.info, ...extra]) } : d)),
      (e) => live && toast.error(e, "Could not check folders"),
    );
    return () => {
      live = false;
    };
  }, [data, prefs.pinnedProjects, prefs.hiddenProjects, treePaths, setData, toast]);

  const keyOf = useCallback(
    (p: string) => {
      const c = data?.info.get(p)?.canonical;
      return c ? normPath(c) : p;
    },
    [data],
  );

  const rows = useMemo(
    () =>
      data
        ? mergeProjects({
            sessions: data.list,
            memory: data.mem,
            pinned: prefs.pinnedProjects,
            hidden: prefs.hiddenProjects,
            info: data.info,
            tree: treePaths,
            home: data.home,
          })
        : [],
    [data, prefs.pinnedProjects, prefs.hiddenProjects, treePaths],
  );
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const refByKey = useMemo(() => {
    const m = new Map<string, TreeRef>();
    for (const ref of index.values()) m.set(keyOf(ref.node.path), ref);
    return m;
  }, [index, keyOf]);

  const metaFor = useCallback(
    (r: ProjectRow): RowMeta => {
      const ref = refByKey.get(r.path) ?? null;
      const entry = ref ? entryOf(registry, ref.root, ref.node.path) : EMPTY_ENTRY;
      return { ref, entry, related: entry.related.map((p) => ({ path: p, name: relatedName(p, index, ref?.root ?? null, home) })) };
    },
    [refByKey, registry, index, home],
  );
  const describe = useCallback((r: ProjectRow) => {
    const m = metaFor(r);
    return [m.entry.description, m.entry.status ?? "", m.ref?.rel ?? ""].join("\n");
  }, [metaFor]);

  const flat = useMemo(() => filterRows(rows, q, view, home, describe), [rows, q, view, home, describe]);
  const groups = useMemo(() => groupRows(flat, view === "all" ? "All" : "Recent"), [flat, view]);
  const liveCount = rows.reduce((n, r) => n + (r.live > 0 ? 1 : 0), 0);
  const hiddenCount = rows.filter((r) => r.hidden).length;
  const homeRow = home ? rowByKey.get(keyOf(normPath(home))) : undefined;

  const run = (p: Promise<unknown>, what: string) => p.catch((e) => toast.error(e, what));

  const addFolder = async () => {
    try {
      const path = await addProjectWithPicker();
      if (path) toast.info(`Pinned ${tildify(path, home)}`);
    } catch (e) {
      toast.error(e, "Could not add the folder");
    }
  };

  const labelFor = (r: ProjectRow, m: RowMeta) => (m.ref ? m.ref.node.name : r.label === "~" ? "home" : r.label);
  const items = useMemo(() => pickItems(trees, home), [trees, home]);

  const actions: Actions = {
    open: (r) => r.exists && openTab({ cwd: r.path }),
    shell: (r) => r.exists && openTab({ cwd: r.path, command: SHELL_COMMAND.command, args: [...SHELL_COMMAND.args] }),
    openWith: (r, m) => {
      if (!r.exists) return;
      const label = labelFor(r, m);
      const own = new Set([r.path, ...r.aliases, m.ref?.node.path]);
      const choices = items.filter((it) => !own.has(it.path));
      openSheet((close) => (
        <PickerSheet
          title={`Open ${label} with...`}
          subtitle={`claude --add-dir for each checked project, in ${tildify(r.path, home)}`}
          items={choices}
          initial={m.entry.related.filter((p) => choices.some((c) => c.path === p))}
          confirmLabel="Open"
          note="Related projects start checked. The new tab runs claude even when new tabs default to a shell."
          onConfirm={(paths) => {
            openTab({ cwd: r.path, command: CLAUDE, args: paths.flatMap((p) => ["--add-dir", p]), title: label });
          }}
          close={close}
        />
      ));
    },
    resume: (r, m) => {
      if (!r.exists || !r.lastSessionId) return;
      openTab({ cwd: r.path, command: CLAUDE, args: ["--resume", r.lastSessionId], title: `${labelFor(r, m)} (resumed)` });
    },
    sessions: (r) => {
      if (!r.sessionsKey) return;
      setSessionsFilter(r.sessionsKey);
      setPrefs({ sidebarSection: "sessions", sidebarCollapsed: false });
    },
    related: (_r, m) => {
      const ref = m.ref;
      if (!ref) return;
      const choices = items.filter((it) => it.path !== ref.node.path);
      openSheet((close) => (
        <PickerSheet
          title={`Projects related to ${ref.node.name}`}
          subtitle={tildify(ref.node.path, home)}
          items={choices}
          initial={m.entry.related}
          confirmLabel="Save"
          requireChange
          note="Saved in the registry (PROJECTS.md) and as permissions.additionalDirectories in this project's .claude/settings.json, so its sessions may read them. Entries you added there by hand stay."
          onConfirm={async (paths) => {
            await saveRelated(ref, paths);
            toast.info(`Saved ${plural(paths.length, "related project")} for ${ref.node.name}`);
          }}
          close={close}
        />
      ));
    },
    edit: (_r, m) => {
      const ref = m.ref;
      if (!ref) return;
      openSheet((close) => (
        <EditSheet
          title={ref.node.name}
          subtitle={tildify(ref.node.path, home)}
          entry={m.entry}
          onSave={(patch) => saveEntry(ref.root, ref.node.path, patch)}
          close={close}
        />
      ));
    },
    pin: (r) => void run(r.pinned ? unpinProject([r.path, ...r.aliases]) : pinProject(r.path), "Could not save prefs.json"),
    hide: (r) => void run(r.hidden ? unhideProject([r.path, ...r.aliases]) : hideProject(r.path, r.aliases), "Could not save prefs.json"),
  };

  const inTabFor = (r: ProjectRow) => (activeRoot !== null && normPath(activeRoot) === r.path ? (activeTab?.title ?? "") : null);
  const rowView = (r: ProjectRow, opts: { label?: string; sub?: string; indent?: number; toggle?: Toggle } = {}) => {
    const m = metaFor(r);
    return (
      <ProjectRowView
        key={r.path}
        r={r}
        meta={m}
        label={opts.label ?? labelFor(r, m)}
        sub={opts.sub ?? tildify(r.path, home)}
        indent={opts.indent ?? 0}
        toggle={opts.toggle}
        now={now}
        inTab={inTabFor(r)}
        actions={actions}
      />
    );
  };

  const flatGroups = view === "tree" ? groups.filter((g) => g.key === "pinned") : groups;
  const words = useMemo(() => queryWords(q), [q]);
  const rowFor = useCallback((p: string) => rowByKey.get(keyOf(p)), [rowByKey, keyOf]);
  const describeNode = useCallback(
    (n: WorkspaceNode) => {
      const ref = index.get(n.path);
      const e = ref ? entryOf(registry, ref.root, n.path) : EMPTY_ENTRY;
      return [n.name, ref?.rel ?? "", n.path, e.description, e.status ?? ""].join("\n").toLowerCase();
    },
    [index, registry],
  );
  const homeMatches = words.every((w) => `home\n~\n${home ?? ""}`.toLowerCase().includes(w));

  return (
    <Panel
      title="Projects"
      loading={loading}
      onRefresh={() => void reload(false)}
      actions={
        data && (
          <span className="shrink-0 text-[11px] text-fg-muted tabular-nums" title={`${plural(rows.length, "project")}, ${liveCount} live, ${hiddenCount} hidden`}>
            {rows.length} projects, {liveCount} live
          </span>
        )
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Search projects" />
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <Select value={view} onChange={(e) => setView(e.target.value as ProjectFilter)} aria-label="Project view" className="min-w-0 flex-1">
          {VIEWS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
        <span title="Pick a folder and pin it">
          <Button icon={FolderPlus} onClick={() => void addFolder()}>
            Add folder
          </Button>
        </span>
      </div>

      {view !== "tree" && data && rows.length === 0 && (
        <EmptyState title="No projects yet">
          Projects are the folders your Claude Code sessions ran in, the ones with memory under ~/.claude/projects, and folders you add here.
        </EmptyState>
      )}
      {view !== "tree" && rows.length > 0 && flat.length === 0 && (
        <EmptyState title={q ? "No projects match" : "Everything is hidden"}>{q ? <>Nothing matches "{q}" in this view.</> : "Switch the view to All to unhide projects."}</EmptyState>
      )}

      {flatGroups.map((g) => (
        <div key={g.key}>
          <SectionHeader title={g.title} count={g.rows.length} />
          {g.rows.map((r) => rowView(r))}
        </div>
      ))}

      {view === "tree" && data && (
        <TreeView
          trees={trees}
          scanned={tree !== null}
          words={words}
          home={home}
          index={index}
          rowFor={rowFor}
          describe={describeNode}
          collapsed={prefs.collapsedPaths}
          expanded={prefs.expandedPaths}
          rowView={rowView}
        />
      )}

      {view === "tree" && homeRow && !homeRow.hidden && homeMatches && (
        <div>
          <SectionHeader title="Home" />
          {rowView(homeRow, { label: "home", sub: "~" })}
        </div>
      )}
      <div className="h-3" />
    </Panel>
  );
}

type Toggle = { open: boolean; count: number; onToggle: () => void };

const toggled = (list: string[], path: string) => (list.includes(path) ? list.filter((p) => p !== path) : [...list, path]);

function TreeView({
  trees,
  scanned,
  words,
  home,
  index,
  rowFor,
  describe,
  collapsed,
  expanded,
  rowView,
}: {
  trees: WorkspaceNode[];
  scanned: boolean;
  words: string[];
  home?: string;
  index: Map<string, TreeRef>;
  rowFor: (path: string) => ProjectRow | undefined;
  describe: (n: WorkspaceNode) => string;
  collapsed: string[];
  expanded: string[];
  rowView: (r: ProjectRow, opts: { label?: string; sub?: string; indent?: number; toggle?: Toggle }) => ReactNode;
}) {
  const searching = words.length > 0;
  const shown = useMemo(
    () => filterTree(trees, (p) => !rowFor(p)?.hidden, searching ? (n) => words.every((w) => describe(n).includes(w)) : null),
    [trees, rowFor, searching, words, describe],
  );
  const roots = useAtomValue(prefsAtom).workspaceRoots;

  if (!scanned) return null;
  if (roots.length === 0)
    return <EmptyState title="No workspace roots">Add a folder that holds your projects (like ~/Develop) under Settings, This app, Projects.</EmptyState>;
  if (trees.length === 0) return <EmptyState title="Workspace roots not found">None of the configured workspace roots exist. Check Settings, This app, Projects.</EmptyState>;
  if (searching && shown.length === 0) return <EmptyState title="No projects match">Nothing in the tree matches the search.</EmptyState>;

  const isCollapsed = (p: string) => !searching && collapsed.includes(p);
  const flip = (key: "collapsedPaths" | "expandedPaths", p: string) => setPrefs({ [key]: toggled(store.get(prefsAtom)[key], p) });

  const project = (n: WorkspaceNode, indent: number): ReactNode => {
    const r = rowFor(n.path);
    if (!r) return null;
    const ref = index.get(n.path);
    const subs = n.children;
    const open = searching ? subs.length > 0 : expanded.includes(n.path);
    const toggle = subs.length > 0 ? { open, count: subs.length, onToggle: () => flip("expandedPaths", n.path) } : undefined;
    return (
      <div key={n.path}>
        {rowView(r, { label: n.name, sub: ref?.rel ?? n.path, indent, toggle })}
        {open && subs.map((s) => {
          const sr = rowFor(s.path);
          return sr ? rowView(sr, { label: s.name, sub: index.get(s.path)?.rel ?? s.path, indent: indent + 1 }) : null;
        })}
      </div>
    );
  };

  const group = (g: WorkspaceNode, depth: number): ReactNode => {
    const closed = isCollapsed(g.path);
    return (
      <div key={g.path}>
        <TreeHeader name={g.name} title={g.path} count={countProjects(g)} open={!closed} depth={depth} onToggle={() => flip("collapsedPaths", g.path)} />
        {!closed && g.children.map((c) => (c.kind === "group" ? group(c, depth + 1) : project(c, depth + 1)))}
      </div>
    );
  };

  return (
    <>
      {shown.map((root) => {
        const closed = isCollapsed(root.path);
        return (
          <div key={root.path} data-workspace={root.path}>
            {/* Like SectionHeader, but keeps the path's case. */}
            <button
              type="button"
              onClick={() => flip("collapsedPaths", root.path)}
              aria-expanded={!closed}
              title={root.path}
              className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 bg-bg px-3 pt-3 pb-1 text-left text-fg-muted hover:text-fg"
            >
              <span className="min-w-0 truncate font-mono text-[11px] font-semibold">{tildify(root.path, home)}</span>
              <span className="text-[11px] tabular-nums">{countProjects(root)}</span>
              <span className="flex-1" />
              {closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
            {/* Projects directly under the root (a depth-1 repo) first, then the groups. */}
            {!closed && rootParts(root).top.map((p) => project(p, 0))}
            {!closed && rootParts(root).groups.map((g) => group(g, 0))}
          </div>
        );
      })}
    </>
  );
}

function TreeHeader({ name, title, count, open, depth, onToggle }: { name: string; title: string; count: number; open: boolean; depth: number; onToggle: () => void }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-expanded={open}
      data-group={title}
      className="flex w-full cursor-pointer items-center gap-1 py-1 pr-3 text-left text-[12px] font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <Icon size={13} strokeWidth={2} className="shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="text-[11px] font-normal tabular-nums">{count}</span>
    </button>
  );
}

function ProjectRowView({
  r,
  meta,
  label,
  sub,
  indent,
  toggle,
  now,
  inTab,
  actions,
}: {
  r: ProjectRow;
  meta: RowMeta;
  label: string;
  sub: string;
  indent: number;
  toggle?: Toggle;
  now: number;
  /** Title of the active tab when this row is its project, else null. */
  inTab: string | null;
  actions: Actions;
}) {
  const gone = "Folder does not exist";
  const openTip = r.exists ? `New tab in ${r.path}` : gone;
  const shellTip = r.exists ? `Shell tab in ${r.path}` : gone;
  const withTip = r.exists ? "Open with... (claude --add-dir other projects)" : gone;
  const resumeTip = !r.exists
    ? gone
    : r.lastSessionId
      ? `Resume last: ${r.lastSessionTitle ?? r.lastSessionId} (claude --resume ${r.lastSessionId})`
      : r.live > 0
        ? "Only running sessions here"
        : "No session to resume";
  const sessionsTip = r.sessionsKey ? `Show ${plural(r.sessions, "session")} in Sessions` : "No sessions here";
  const relatedTip = meta.ref ? "Related projects..." : NOT_IN_WORKSPACE;
  const editTip = meta.ref ? "Edit description and status" : NOT_IN_WORKSPACE;
  const flagChips = [r.flags.claudeMd && "CLAUDE.md", r.flags.claudeDir && ".claude", r.flags.mcpJson && "mcp", r.flags.worktree && "worktree"].filter(
    (x): x is string => !!x,
  );
  const { entry } = meta;
  const act = (name: ActionName) => () => actions[name](r, meta);
  return (
    <div
      className={cx("group relative py-1.5 pr-3 hover:bg-bg-hover", r.hidden && "opacity-50 hover:opacity-100 focus-within:opacity-100")}
      style={{ paddingLeft: 12 + indent * 14 }}
      data-project={r.path}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {toggle && (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.open}
            title={`${toggle.open ? "Hide" : "Show"} ${plural(toggle.count, "subproject")}`}
            className="-ml-1 inline-flex shrink-0 cursor-pointer items-center rounded-ui text-fg-muted hover:text-fg"
          >
            {toggle.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
        <span title={r.aliases.length > 1 ? `${r.path}\nalso recorded as ${r.aliases.filter((a) => a !== r.path).join(", ")}` : r.path} className="min-w-0 truncate text-[13px] leading-6 text-fg">
          {label}
          {!r.exists && <span className="text-fg-muted"> (missing folder)</span>}
        </span>
        {entry.status && <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>}
        {r.pinned && <Pin size={11} strokeWidth={2.25} className="shrink-0 text-accent" aria-label="Pinned" />}
        {r.live > 0 && (
          <Badge tone="ok" title={`${plural(r.live, "running session")}`}>
            {r.live > 1 ? `${r.live} LIVE` : "LIVE"}
          </Badge>
        )}
        {toggle && !toggle.open && <span className="shrink-0 text-[11px] text-fg-muted tabular-nums">+{toggle.count}</span>}
      </div>
      {/* Actions float over the right end of the first lines on hover or focus, so labels and paths keep the full width. */}
      <div className="pointer-events-none absolute top-1 right-2 flex items-center rounded-ui bg-bg-hover opacity-0 shadow-sm group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <span title={openTip}>
          <IconButton icon={Play} title={openTip} onClick={act("open")} disabled={!r.exists} />
        </span>
        <span title={shellTip}>
          <IconButton icon={Terminal} title={shellTip} onClick={act("shell")} disabled={!r.exists} />
        </span>
        <span title={withTip}>
          <IconButton icon={Layers} title={withTip} onClick={act("openWith")} disabled={!r.exists} />
        </span>
        <span title={resumeTip}>
          <IconButton icon={RotateCcw} title={resumeTip} onClick={act("resume")} disabled={!r.exists || !r.lastSessionId} />
        </span>
        <span title={sessionsTip}>
          <IconButton icon={History} title={sessionsTip} onClick={act("sessions")} disabled={!r.sessionsKey} />
        </span>
        <span title={relatedTip}>
          <IconButton icon={Link2} title={relatedTip} onClick={act("related")} disabled={!meta.ref} />
        </span>
        <span title={editTip}>
          <IconButton icon={Pencil} title={editTip} onClick={act("edit")} disabled={!meta.ref} />
        </span>
        <IconButton icon={r.pinned ? PinOff : Pin} title={r.pinned ? "Unpin" : "Pin"} onClick={act("pin")} />
        <IconButton icon={r.hidden ? Eye : EyeOff} title={r.hidden ? "Unhide" : "Hide"} onClick={act("hide")} />
      </div>
      <div className="truncate font-mono text-[11px] leading-snug text-fg-muted" title={r.path}>
        {sub}
      </div>
      {entry.description && (
        <div className="line-clamp-2 text-[11px] leading-snug break-words text-fg-muted" title={entry.description}>
          {entry.description}
        </div>
      )}
      {(r.lastTs > 0 || inTab !== null || r.sessions > 0 || r.memory > 0 || flagChips.length > 0) && (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug text-fg-muted tabular-nums">
          {r.lastTs > 0 && <span title={absoluteTime(r.lastTs)}>{relativeTime(r.lastTs, now)}</span>}
          {inTab !== null && (
            <span className="min-w-0 max-w-full truncate text-ok" title="The active tab's project">
              in tab {inTab}
            </span>
          )}
          {(r.sessions > 0 || r.memory > 0 || flagChips.length > 0) && (
            <span className="flex flex-wrap items-center gap-1">
              {r.sessions > 0 && <Badge>{plural(r.sessions, "session")}</Badge>}
              {r.memory > 0 && <Badge title={`${plural(r.memory, "memory file")} in ~/.claude/projects`}>{r.memory} memory</Badge>}
              {flagChips.map((f) => (
                <Badge key={f} tone={f === "worktree" ? "warn" : "accent"} title={f === "worktree" ? "A git worktree (.git is a gitdir: file); its subprojects are not listed" : undefined}>
                  {f}
                </Badge>
              ))}
            </span>
          )}
        </div>
      )}
      {meta.related.length > 0 && (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1" data-related={r.path}>
          <Link2 size={10} strokeWidth={2.25} className="shrink-0 text-fg-muted" aria-label="Related" />
          {meta.related.map((x) => (
            <Badge key={x.path} title={`Related: ${x.path}`}>
              {x.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
