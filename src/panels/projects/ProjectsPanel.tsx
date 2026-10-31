import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Eye, EyeOff, FolderPlus, History, Pin, PinOff, Play, RotateCcw, Terminal } from "lucide-react";
import { memory, projects, sessions, type MemoryProject, type ProjectsInfo, type Session } from "../../lib/ipc";
import { prefsAtom, setPrefs } from "../../app/prefs";
import { projectAtom } from "../../app/project";
import { SHELL_COMMAND, activeTabAtom, openTab } from "../../app/tabs";
import { store } from "../../app/store";
import { Badge, Button, IconButton, Select, cx } from "../ui";
import { getPaths, useToast } from "../shared/hooks";
import { EmptyState, Panel, SearchInput, SectionHeader } from "../shared/list";
import { tildify } from "../shared/paths";
import { absoluteTime, plural, relativeTime } from "../shared/format";
import { sessionsProjectFilterAtom } from "../sessions/model";
import { addProjectWithPicker, hideProject, pinProject, unhideProject, unpinProject } from "./actions";
import { collectPaths, filterRows, groupRows, mergeProjects, normPath, NO_FLAGS, type ProjectFilter, type ProjectRow } from "./model";

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

/**
 * Sessions, memory projects and folder facts. Manual loads show the spinner and
 * toast every error; background loads are silent and toast only on a new failure.
 */
function useProjects() {
  const toast = useToast();
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const failing = useRef(false);

  const load = useCallback(
    async (silent: boolean) => {
      const my = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const [list, mem, paths] = await Promise.all([sessions.list(), memory.projects(), getPaths()]);
        const prefs = store.get(prefsAtom);
        const info = await fetchInfo(collectPaths(list, mem, prefs.pinnedProjects, prefs.hiddenProjects));
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

const FILTERS: { id: ProjectFilter; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "recent", label: "Recent" },
  { id: "all", label: "All" },
];

export function ProjectsPanel() {
  const toast = useToast();
  const { data, setData, loading, reload } = useProjects();
  const prefs = useAtomValue(prefsAtom);
  const activeRoot = useAtomValue(projectAtom)?.root ?? null;
  const activeTab = useAtomValue(activeTabAtom);
  const setSessionsFilter = useSetAtom(sessionsProjectFilterAtom);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("recent");
  const [now, setNow] = useState(() => Date.now());

  const home = data?.home;
  useEffect(() => setNow(Date.now()), [data]);

  // A folder pinned or hidden since the last load (Add folder, prefs.json edits): fetch its facts.
  useEffect(() => {
    if (!data) return;
    const missing = [...new Set([...prefs.pinnedProjects, ...prefs.hiddenProjects].map(normPath))].filter((p) => p.startsWith("/") && !data.info.has(p));
    if (missing.length === 0) return;
    let live = true;
    fetchInfo(missing).then(
      (extra) => live && setData((d) => (d ? { ...d, info: new Map([...d.info, ...extra]) } : d)),
      (e) => live && toast.error(e, "Could not check folders"),
    );
    return () => {
      live = false;
    };
  }, [data, prefs.pinnedProjects, prefs.hiddenProjects, setData, toast]);

  const rows = useMemo(
    () =>
      data
        ? mergeProjects({ sessions: data.list, memory: data.mem, pinned: prefs.pinnedProjects, hidden: prefs.hiddenProjects, info: data.info, home: data.home })
        : [],
    [data, prefs.pinnedProjects, prefs.hiddenProjects],
  );
  const shown = useMemo(() => filterRows(rows, q, filter, home), [rows, q, filter, home]);
  const groups = useMemo(() => groupRows(shown), [shown]);
  const liveCount = rows.reduce((n, r) => n + (r.live > 0 ? 1 : 0), 0);
  const hiddenCount = rows.filter((r) => r.hidden).length;

  const run = (p: Promise<unknown>, what: string) => p.catch((e) => toast.error(e, what));

  const addFolder = async () => {
    try {
      const path = await addProjectWithPicker();
      if (path) toast.info(`Pinned ${tildify(path, home)}`);
    } catch (e) {
      toast.error(e, "Could not add the folder");
    }
  };

  const actions = {
    open: (r: ProjectRow) => r.exists && openTab({ cwd: r.path }),
    shell: (r: ProjectRow) => r.exists && openTab({ cwd: r.path, command: SHELL_COMMAND.command, args: [...SHELL_COMMAND.args] }),
    resume: (r: ProjectRow) => {
      if (!r.exists || !r.lastSessionId) return;
      openTab({ cwd: r.path, command: "claude", args: ["--resume", r.lastSessionId], title: `${r.label} (resumed)` });
    },
    sessions: (r: ProjectRow) => {
      if (!r.sessionsKey) return;
      setSessionsFilter(r.sessionsKey);
      setPrefs({ sidebarSection: "sessions", sidebarCollapsed: false });
    },
    pin: (r: ProjectRow) => void run(r.pinned ? unpinProject([r.path, ...r.aliases]) : pinProject(r.path), "Could not save prefs.json"),
    hide: (r: ProjectRow) => void run(r.hidden ? unhideProject([r.path, ...r.aliases]) : hideProject(r.path, r.aliases), "Could not save prefs.json"),
  };

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
        <Select value={filter} onChange={(e) => setFilter(e.target.value as ProjectFilter)} aria-label="Project filter" className="min-w-0 flex-1">
          {FILTERS.map((f) => (
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

      {data && rows.length === 0 && (
        <EmptyState title="No projects yet">
          Projects are the folders your Claude Code sessions ran in, the ones with memory under ~/.claude/projects, and folders you add here.
        </EmptyState>
      )}
      {rows.length > 0 && shown.length === 0 && (
        <EmptyState title={q ? "No projects match" : filter === "pinned" ? "Nothing pinned" : "Everything is hidden"}>
          {q ? (
            <>Nothing matches "{q}" in this view.</>
          ) : filter === "pinned" ? (
            "Pin a project from Recent, or use Add folder."
          ) : (
            "Switch the filter to All to unhide projects."
          )}
        </EmptyState>
      )}

      {groups.map((g) => (
        <div key={g.key}>
          <SectionHeader title={g.title} count={g.rows.length} />
          {g.rows.map((r) => (
            <ProjectRowView
              key={r.path}
              r={r}
              now={now}
              home={home}
              inTab={activeRoot !== null && normPath(activeRoot) === r.path ? (activeTab?.title ?? "") : null}
              actions={actions}
            />
          ))}
        </div>
      ))}
      <div className="h-3" />
    </Panel>
  );
}

function ProjectRowView({
  r,
  now,
  home,
  inTab,
  actions,
}: {
  r: ProjectRow;
  now: number;
  home?: string;
  /** Title of the active tab when this row is its project, else null. */
  inTab: string | null;
  actions: Record<"open" | "shell" | "resume" | "sessions" | "pin" | "hide", (r: ProjectRow) => unknown>;
}) {
  const gone = "Folder does not exist";
  const openTip = r.exists ? `New tab in ${r.path}` : gone;
  const shellTip = r.exists ? `Shell tab in ${r.path}` : gone;
  const resumeTip = !r.exists
    ? gone
    : r.lastSessionId
      ? `Resume last: ${r.lastSessionTitle ?? r.lastSessionId} (claude --resume ${r.lastSessionId})`
      : r.live > 0
        ? "Only running sessions here"
        : "No session to resume";
  const sessionsTip = r.sessionsKey ? `Show ${plural(r.sessions, "session")} in Sessions` : "No sessions here";
  const flagChips = [r.flags.claudeMd && "CLAUDE.md", r.flags.claudeDir && ".claude", r.flags.mcpJson && "mcp"].filter((x): x is string => !!x);
  return (
    <div className={cx("group relative px-3 py-1.5 hover:bg-bg-hover", r.hidden && "opacity-50 hover:opacity-100 focus-within:opacity-100")} data-project={r.path}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span title={r.aliases.length > 1 ? `${r.path}\nalso recorded as ${r.aliases.filter((a) => a !== r.path).join(", ")}` : r.path} className="min-w-0 truncate text-[13px] leading-6 text-fg">
          {r.label}
          {!r.exists && <span className="text-fg-muted"> (missing folder)</span>}
        </span>
        {r.pinned && <Pin size={11} strokeWidth={2.25} className="shrink-0 text-accent" aria-label="Pinned" />}
        {r.live > 0 && (
          <Badge tone="ok" title={`${plural(r.live, "running session")}`}>
            {r.live > 1 ? `${r.live} LIVE` : "LIVE"}
          </Badge>
        )}
      </div>
      {/* Actions float over the right end of the first lines on hover or focus, so labels and paths keep the full width. */}
      <div className="pointer-events-none absolute top-1 right-2 flex items-center rounded-ui bg-bg-hover opacity-0 shadow-sm group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <span title={openTip}>
          <IconButton icon={Play} title={openTip} onClick={() => actions.open(r)} disabled={!r.exists} />
        </span>
        <span title={shellTip}>
          <IconButton icon={Terminal} title={shellTip} onClick={() => actions.shell(r)} disabled={!r.exists} />
        </span>
        <span title={resumeTip}>
          <IconButton icon={RotateCcw} title={resumeTip} onClick={() => actions.resume(r)} disabled={!r.exists || !r.lastSessionId} />
        </span>
        <span title={sessionsTip}>
          <IconButton icon={History} title={sessionsTip} onClick={() => actions.sessions(r)} disabled={!r.sessionsKey} />
        </span>
        <IconButton icon={r.pinned ? PinOff : Pin} title={r.pinned ? "Unpin" : "Pin"} onClick={() => actions.pin(r)} />
        <IconButton icon={r.hidden ? Eye : EyeOff} title={r.hidden ? "Unhide" : "Hide"} onClick={() => actions.hide(r)} />
      </div>
      <div className="truncate font-mono text-[11px] leading-snug text-fg-muted" title={r.path}>
        {tildify(r.path, home)}
      </div>
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
              <Badge key={f} tone="accent">
                {f}
              </Badge>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
