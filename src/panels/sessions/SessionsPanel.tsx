import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Play, Trash } from "lucide-react";
import { files, pty, sessions, type Session } from "../../lib/ipc";
import { CLAUDE, activateTab, openTab, tabsAtom } from "../../app/tabs";
import { activityAtom } from "../../app/activity";
import { Badge, Button, IconButton, Select } from "../ui";
import { getPaths, useToast } from "../shared/hooks";
import { ConfirmBar, EmptyState, Panel, SearchInput, SectionHeader } from "../shared/list";
import {
  absoluteTime,
  filterSessions,
  formatSize,
  groupByProject,
  plural,
  projectLabel,
  projectOptions,
  relativeTime,
  sessionsProjectFilterAtom,
  type SessionGroup,
} from "./model";

const AUTO_REFRESH_MS = 15_000;

type Snapshot = { list: Session[]; ptyPids: Map<string, number>; home: string };

/**
 * Load sessions plus the pty pid map. Manual loads show the spinner and toast
 * every error; background loads are silent and toast only on a new failure.
 */
function useSessions() {
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
        const [list, ptys, paths] = await Promise.all([sessions.list(), pty.list(), getPaths()]);
        const ptyPids = new Map<string, number>();
        for (const p of ptys) if (p.alive && typeof p.pid === "number") ptyPids.set(p.id, p.pid);
        if (my === seq.current) setData({ list, ptyPids, home: paths.home });
        failing.current = false;
      } catch (e) {
        if (my === seq.current && (!silent || !failing.current)) toast.error(e, "Could not list sessions");
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

  return { data, loading, reload: load };
}

export function SessionsPanel() {
  const toast = useToast();
  const { data, loading, reload } = useSessions();
  const tabs = useAtomValue(tabsAtom);
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [preset, setPreset] = useAtom(sessionsProjectFilterAtom);

  // Another panel (Projects) asked for this project's sessions.
  useEffect(() => {
    if (preset === null) return;
    setProject(preset);
    setQ("");
    setPreset(null);
  }, [preset, setPreset]);

  const list = data?.list ?? [];
  const home = data?.home;

  // Keep relative times fresh between loads.
  useEffect(() => setNow(Date.now()), [data]);

  // A tab opened or closed changes which pids are ours; refresh quietly.
  const tabIds = tabs.map((t) => t.id ?? "").join(",");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload(true);
  }, [tabIds, reload]);

  /** live pid -> the tab whose pty child it is. */
  const tabByPid = useMemo(() => {
    const m = new Map<number, { key: string; title: string }>();
    if (!data) return m;
    for (const t of tabs) {
      const pid = t.id ? data.ptyPids.get(t.id) : undefined;
      if (pid !== undefined) m.set(pid, { key: t.key, title: t.title });
    }
    return m;
  }, [data, tabs]);

  const options = useMemo(() => projectOptions(list, home), [list, home]);
  // Drop a filter whose project no longer has sessions.
  useEffect(() => {
    if (project && data && !options.some((o) => o.key === project)) setProject("");
  }, [project, options, data]);

  const shown = useMemo(() => filterSessions(list, q, project), [list, q, project]);
  const groups: SessionGroup[] = useMemo(
    () => (project ? [{ key: project, project: shown[0]?.project ?? null, sessions: shown }] : groupByProject(shown)),
    [shown, project],
  );
  const liveCount = list.filter((s) => s.live).length;
  const selected = options.find((o) => o.key === project);

  const resume = (s: Session) => {
    if (s.live || !home) return;
    const cwd = s.project ?? home;
    openTab({ cwd, command: CLAUDE, args: ["--resume", s.id], title: `${projectLabel(cwd, home)} (resumed)` });
  };

  const remove = async (s: Session) => {
    if (s.live || !s.transcriptPath) return;
    setBusy(true);
    try {
      await files.remove(s.transcriptPath);
      toast.info("Deleted transcript");
      setConfirmDelete(null);
      await reload(false);
    } catch (e) {
      toast.error(e, "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Sessions"
      loading={loading}
      onRefresh={() => void reload(false)}
      actions={
        data && (
          <span className="shrink-0 text-[11px] text-fg-muted tabular-nums" title={`${plural(list.length, "session")}, ${liveCount} live`}>
            {list.length} sessions, {liveCount} live
          </span>
        )
      }
    >
      {list.length > 0 && (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="Search sessions" />
          <div className="px-3 pt-2">
            <Select value={project} onChange={(e) => setProject(e.target.value)} title={selected ? (selected.project ?? "(unknown project)") : "All projects"} aria-label="Project filter">
              <option value="">All projects</option>
              {options.map((o) => (
                <option key={o.key} value={o.key} title={o.project ?? "Project folder could not be resolved"}>
                  {o.label} ({o.count})
                </option>
              ))}
            </Select>
          </div>
        </>
      )}

      {data && list.length === 0 && (
        <EmptyState title="No sessions yet">
          Sessions come from ~/.claude/history.jsonl, the transcripts under ~/.claude/projects and the running Claude processes.
        </EmptyState>
      )}
      {list.length > 0 && shown.length === 0 && (
        <EmptyState title="No sessions match">{q ? <>Nothing matches "{q}" in this view.</> : "This project has no sessions."}</EmptyState>
      )}

      {groups.map((g) =>
        g.sessions.length === 0 ? null : (
          <div key={g.key}>
            <div title={g.project ?? "Project folder could not be resolved"}>
              <SectionHeader title={project ? "Sessions" : projectLabel(g.project, home)} count={g.sessions.length} />
            </div>
            {g.sessions.map((s) => (
              <div key={s.id}>
                <SessionRow
                  s={s}
                  now={now}
                  tab={s.live ? tabByPid.get(s.live.pid) : undefined}
                  onResume={() => resume(s)}
                  onDelete={() => setConfirmDelete(s.id)}
                />
                {confirmDelete === s.id && (
                  <ConfirmBar
                    text={<>Delete this transcript ({formatSize(s.transcriptBytes)})? It cannot be resumed afterwards.</>}
                    busy={busy}
                    onConfirm={() => void remove(s)}
                    onCancel={() => setConfirmDelete(null)}
                  />
                )}
              </div>
            ))}
          </div>
        ),
      )}
      <div className="h-3" />
    </Panel>
  );
}

function SessionRow({
  s,
  now,
  tab,
  onResume,
  onDelete,
}: {
  s: Session;
  now: number;
  tab?: { key: string; title: string };
  onResume: () => void;
  onDelete: () => void;
}) {
  const resumeTip = s.live ? "Already running" + (tab ? `, open in tab ${tab.title}` : "") : `claude --resume ${s.id}`;
  const deleteTip = s.live ? "Cannot delete while the session is running" : s.transcriptPath ? `Delete ${s.transcriptPath}` : "No transcript on disk";
  const liveTip = s.live ? [`pid ${s.live.pid}`, s.live.status, s.live.name].filter(Boolean).join(", ") : undefined;
  // A session open in a tab shows the tab's status (with waiting); others the session file's.
  const tabStatus = Object.values(useAtomValue(activityAtom)).find((a) => a.sessionId === s.id)?.status;
  const liveStatus = tabStatus ?? s.live?.status ?? null;
  return (
    <div className="group px-3 py-1.5 hover:bg-bg-hover">
      <div className="flex min-w-0 items-start gap-1.5">
        <span title={s.title} className="min-w-0 flex-1 break-words text-[13px] leading-snug text-fg line-clamp-2">
          {s.title}
        </span>
        {s.live && (
          <Badge tone={liveStatus === "waiting" ? "warn" : "ok"} title={liveTip}>
            {liveStatus ? `LIVE ${liveStatus}` : "LIVE"}
          </Badge>
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-[11px] leading-snug text-fg-muted tabular-nums">
          <span title={absoluteTime(s.lastTs)}>{relativeTime(s.lastTs, now)}</span>
          <span>{plural(s.prompts, "prompt")}</span>
          {s.transcriptPath && <span title={s.transcriptPath}>{formatSize(s.transcriptBytes)}</span>}
          {tab && (
            <button
              type="button"
              className="min-w-0 max-w-full cursor-pointer truncate text-ok hover:underline"
              title={`Switch to tab ${tab.title}`}
              onClick={() => activateTab(tab.key)}
            >
              in tab {tab.title}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <span title={resumeTip}>
            <Button variant="primary" icon={Play} onClick={onResume} disabled={!!s.live} className="px-1.5 py-0.5">
              Resume
            </Button>
          </span>
          <span title={deleteTip}>
            <IconButton icon={Trash} title={deleteTip} danger onClick={onDelete} disabled={!!s.live || !s.transcriptPath} />
          </span>
        </div>
      </div>
    </div>
  );
}
