// Board panel (CONTRACT.md "Board and Calendar", "Board configuration"): the
// connected GitHub Project as one collapsible section per lane (vertical, the
// sidebar is narrow), tasks grouped under their epic, with optimistic lane
// moves and scheduling. Without a connected project: a setup card.
import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRightLeft, CalendarClock, ChevronDown, ChevronRight, ExternalLink, Flag, Play, Plus, TriangleAlert } from "lucide-react";
import type { BoardItem, BoardStatus } from "../../lib/ipc";
import { openTab } from "../../app/tabs";
import { Badge, IconButton, cx } from "../ui";
import { EmptyState, Panel, SearchInput } from "../shared/list";
import { openSheet } from "../shared/Sheet";
import { usePaths, useToast } from "../shared/hooks";
import { absoluteTime, plural, relativeTime } from "../shared/format";
import { tildify } from "../shared/paths";
import { registryAtom, treeAtom } from "../projects/workspaceStore";
import { todayAtom } from "../calendar/model";
import { refreshBoard, setItemField } from "./actions";
import {
  DONE_LIMIT,
  LANES,
  areaOptions,
  boardConfigAtom,
  boardLoadingAtom,
  epicProgress,
  filterItems,
  ghStatusAtom,
  isEpic,
  isOverdue,
  itemChip,
  itemProject,
  laneGroups,
  laneItems,
  laneOf,
  laneOpenAtom,
  projectNames,
  snapshotAtom,
  type KindFilter,
} from "./model";
import { BoardConnectForm, RequiredFieldsNote } from "./BoardConnect";
import { MoveScheduleSheet, NewEpicSheet, NewTaskSheet } from "./sheets";
import { StatusDot } from "./StatusDot";

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "epics", label: "Epics" },
  { id: "all", label: "All" },
];

export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** "as of 3 min ago" for a snapshot's fetchedAt ("" = never). */
export function AsOf({ fetchedAt, now }: { fetchedAt: string | undefined; now: number }) {
  const ts = fetchedAt ? Date.parse(fetchedAt) : NaN;
  return (
    <span className="shrink-0 text-[11px] text-fg-muted tabular-nums" title={Number.isFinite(ts) ? `Board fetched ${absoluteTime(ts)}` : "Not fetched yet"}>
      {Number.isFinite(ts) ? `as of ${relativeTime(ts, now)}` : "not fetched"}
    </span>
  );
}

/** gh unavailable, missing project scope, or a failed refresh (only with a connected project). */
export function BoardNotice() {
  const gh = useAtomValue(ghStatusAtom);
  const snap = useAtomValue(snapshotAtom);
  const config = useAtomValue(boardConfigAtom);
  let text: string | null = null;
  if (gh && !gh.available)
    text = config
      ? `gh is not available (${gh.error ?? "not logged in"}). Showing the cached board; run gh auth login in a shell.`
      : `gh is not available (${gh.error ?? "not logged in"}). Connecting needs it; run gh auth login in a shell.`;
  else if (gh && gh.available && !gh.scopes.includes("project")) text = "The gh login lacks the project scope, so changes will fail. Run gh auth refresh -s project.";
  else if (config && snap?.error) text = `Last refresh failed: ${snap.error}`;
  if (!text) return null;
  return (
    <div className="mx-3 mt-2 flex items-start gap-1.5 rounded-ui border border-warn/60 bg-bg-raised px-2 py-1.5 text-[11px] leading-snug text-warn" role="status">
      <TriangleAlert size={12} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/** Shown instead of the lanes while no project is connected. */
function BoardSetupCard() {
  return (
    <div className="mx-3 my-3 flex flex-col gap-2.5 rounded-ui border border-border bg-bg-raised p-3" data-board-setup="">
      <div>
        <div className="text-xs font-medium text-fg">Connect a GitHub Project</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
          The Board shows a Project v2 of yours (user or organisation) through the gh CLI: epics in a hub repo, tasks as their sub-issues.
        </p>
      </div>
      <BoardConnectForm config={null} />
      <RequiredFieldsNote />
    </div>
  );
}

export function BoardPanel() {
  const config = useAtomValue(boardConfigAtom);
  if (!config) {
    return (
      <Panel title="Board">
        <BoardNotice />
        <BoardSetupCard />
      </Panel>
    );
  }
  return <ConnectedBoard hubRepo={config.hubRepo} title={config.title} />;
}

function ConnectedBoard({ hubRepo, title }: { hubRepo: string; title: string }) {
  const toast = useToast();
  const snap = useAtomValue(snapshotAtom);
  const loading = useAtomValue(boardLoadingAtom);
  const today = useAtomValue(todayAtom);
  const tree = useAtomValue(treeAtom);
  const registry = useAtomValue(registryAtom);
  const [laneOpen, setLaneOpen] = useAtom(laneOpenAtom);
  const [filter, setFilter] = useState<KindFilter>("tasks");
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const now = useNow();
  const home = usePaths()?.home;

  // Opening the panel refreshes unless the snapshot is under a minute old.
  useEffect(() => {
    void refreshBoard(false, false);
  }, []);

  // A click outside the lane menu closes it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-lane-menu]")) setMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [menu]);

  const items = useMemo(() => snap?.items ?? [], [snap]);
  const shown = useMemo(() => filterItems(items, filter, q), [items, filter, q]);
  const searching = q.trim() !== "";
  const trees = useMemo(() => tree ?? [], [tree]);
  const projectOf = useMemo(() => {
    const cache = new Map<string, string | null>();
    return (i: BoardItem) => {
      if (!cache.has(i.itemId)) cache.set(i.itemId, itemProject(i, trees, registry, hubRepo));
      return cache.get(i.itemId) ?? null;
    };
  }, [trees, registry, hubRepo]);

  const newTask = () => openSheet((close) => <NewTaskSheet items={items} hubRepo={hubRepo} close={close} />);
  const newEpic = () => openSheet((close) => <NewEpicSheet areas={areaOptions(snap, [], projectNames(trees))} hubRepo={hubRepo} close={close} />);

  const act = {
    move: (i: BoardItem, to: BoardStatus) => {
      setMenu(null);
      void setItemField(i.itemId, "status", to);
    },
    schedule: (i: BoardItem) => openSheet((close) => <MoveScheduleSheet item={i} close={close} />),
    github: (i: BoardItem) => openUrl(i.url).catch((e) => toast.error(e, "Could not open the browser")),
    project: (path: string) => openTab({ cwd: path }),
  };

  const open = (lane: BoardStatus) => searching || (laneOpen[lane] ?? lane !== "Done");

  return (
    <Panel
      title="Board"
      loading={loading}
      onRefresh={() => void refreshBoard(true)}
      actions={
        <>
          <AsOf fetchedAt={snap?.fetchedAt} now={now} />
          <IconButton icon={Plus} title="New task" onClick={newTask} />
          <IconButton icon={Flag} title="New epic" onClick={newEpic} />
        </>
      }
    >
      <BoardNotice />
      <div className="flex items-center gap-1 px-3 pt-2" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx(
              "cursor-pointer rounded-full border px-2 py-0.5 text-[11px] font-medium",
              filter === f.id ? "border-accent bg-accent/15 text-accent" : "border-border text-fg-muted hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="text-[11px] text-fg-muted tabular-nums">{plural(shown.length, filter === "epics" ? "epic" : filter === "tasks" ? "task" : "item")}</span>
      </div>
      <SearchInput value={q} onChange={setQ} placeholder="Search title, repo, area, #n" />

      {!snap && <EmptyState title="Loading the board">Reading the cached board, then GitHub.</EmptyState>}
      {snap && items.length === 0 && (
        <EmptyState title={snap.fetchedAt ? "The board is empty" : "No board yet"}>
          {snap.fetchedAt ? `Nothing is on the ${title} board.` : `The ${title} board has not been fetched yet. It needs gh logged in with the project scope.`}
        </EmptyState>
      )}
      {snap && items.length > 0 && shown.length === 0 && (
        <EmptyState title="Nothing matches">{searching ? <>No {filter === "all" ? "item" : filter.slice(0, -1)} matches "{q}".</> : `No ${filter} on the board.`}</EmptyState>
      )}

      {shown.length > 0 &&
        LANES.map((lane) => {
          const all = laneItems(shown, lane, false);
          const list = lane === "Done" ? all.slice(0, DONE_LIMIT) : all;
          const isOpen = open(lane);
          const groups = laneGroups(list, items);
          return (
            <section key={lane} data-lane={lane}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setLaneOpen((s) => ({ ...s, [lane]: !isOpen }))}
                className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 bg-bg px-3 pt-3 pb-1 text-left text-fg-muted hover:text-fg"
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="text-[11px] font-semibold uppercase tracking-wide">{lane}</span>
                <span className="text-[11px] tabular-nums">{lane === "Done" && all.length > list.length ? `${list.length} of ${all.length}` : all.length}</span>
              </button>
              {isOpen && list.length === 0 && <p className="px-3 pb-1 text-[11px] text-fg-muted">Empty</p>}
              {isOpen &&
                groups.map((g) => (
                  <div key={g.key}>
                    {g.title !== null && (
                      <div className="truncate px-3 pt-1.5 pb-0.5 text-[11px] text-fg-muted" title={g.epic ? `${g.epic.repo}#${g.epic.number} ${g.epic.title}` : "Tasks without an epic on the board"}>
                        {g.epic ? <span className="font-medium">#{g.epic.number} </span> : null}
                        {g.title}
                      </div>
                    )}
                    {g.items.map((i) => (
                      <BoardRow
                        key={i.itemId}
                        item={i}
                        hubRepo={hubRepo}
                        today={today}
                        project={projectOf(i)}
                        home={home}
                        menuOpen={menu === i.itemId}
                        onMenu={() => setMenu(menu === i.itemId ? null : i.itemId)}
                        act={act}
                      />
                    ))}
                  </div>
                ))}
            </section>
          );
        })}
      <div className="h-3" />
    </Panel>
  );
}

type RowActs = {
  move: (i: BoardItem, to: BoardStatus) => void;
  schedule: (i: BoardItem) => unknown;
  github: (i: BoardItem) => unknown;
  project: (path: string) => unknown;
};

function BoardRow({
  item,
  hubRepo,
  today,
  project,
  home,
  menuOpen,
  onMenu,
  act,
}: {
  item: BoardItem;
  hubRepo: string;
  today: string;
  project: string | null;
  home?: string;
  menuOpen: boolean;
  onMenu: () => void;
  act: RowActs;
}) {
  const lane = laneOf(item);
  const chip = itemChip(item, hubRepo);
  const overdue = isOverdue(item, today);
  const projectTip = project ? `Open a tab in ${tildify(project, home)}` : "No workspace project matches its area or repo";
  return (
    <div className={cx("group relative py-1.5 pr-3 pl-3 hover:bg-bg-hover", menuOpen && "bg-bg-hover")} data-item={item.itemId}>
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot item={item} />
        <span className={cx("min-w-0 truncate text-[13px] leading-5", item.state === "closed" ? "text-fg-muted" : "text-fg")} title={item.title}>
          {item.title}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 pl-3.5">
        {chip && <Badge title={item.repo}>{chip}</Badge>}
        <Badge title={`${item.repo}#${item.number}`}>#{item.number}</Badge>
        {isEpic(item) && item.subIssues.total > 0 && (
          <Badge tone={item.subIssues.completed === item.subIssues.total ? "ok" : "accent"} title={`${item.subIssues.completed} of ${item.subIssues.total} sub-issues done`}>
            {epicProgress(item)}
          </Badge>
        )}
        {item.scheduled && (
          <Badge tone={overdue ? "danger" : item.scheduled === today ? "accent" : "muted"} title={overdue ? `Scheduled ${item.scheduled}, past and not done` : `Scheduled ${item.scheduled}`}>
            {item.scheduled === today ? "today" : item.scheduled}
          </Badge>
        )}
        {item.isPr && <Badge title="Pull request">PR</Badge>}
      </div>
      <div className="pointer-events-none absolute top-1 right-2 flex items-center rounded-ui bg-bg-hover opacity-0 shadow-sm group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <IconButton icon={ArrowRightLeft} title="Move to lane" onClick={onMenu} aria-expanded={menuOpen} data-lane-menu="" />
        <IconButton icon={CalendarClock} title={item.scheduled ? `Scheduled ${item.scheduled}; change or clear` : "Schedule"} onClick={() => act.schedule(item)} />
        <IconButton icon={ExternalLink} title="Open on GitHub" onClick={() => act.github(item)} />
        <span title={projectTip}>
          <IconButton icon={Play} title={projectTip} disabled={!project} onClick={() => project && act.project(project)} />
        </span>
      </div>
      {menuOpen && (
        <div data-lane-menu="" role="menu" className="absolute top-7 right-2 z-20 flex min-w-[9rem] flex-col rounded-ui border border-border bg-bg-raised py-1 shadow-lg shadow-black/30">
          {LANES.filter((l) => l !== lane).map((l) => (
            <button key={l} type="button" role="menuitem" onClick={() => act.move(item, l)} className="cursor-pointer px-3 py-1 text-left text-xs text-fg hover:bg-bg-hover">
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
