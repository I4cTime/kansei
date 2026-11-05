import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { BookOpen, List, Network, Plus, Trash } from "lucide-react";
import { files, memory, type MemoryProject } from "../../lib/ipc";
import { projectAtom } from "../../app/project";
import { prefsAtom, savePrefs, type MemoryView } from "../../app/prefs";
import { Button, IconButton, Select, cx } from "../ui";
import { useOpenEditorTracked } from "../shared/EditorSheet";
import { getPaths, useLoad, usePaths, useToast } from "../shared/hooks";
import { loadDocs, matches, type Doc } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { basename, joinPath, slugify, tildify } from "../shared/paths";
import { MemoryGraphView } from "./MemoryGraphView";
import { graphAtom, graphLoadingAtom, reload as reloadGraph } from "./graphState";
import { nodeMatches } from "./graph";

const TYPES = ["user", "feedback", "project", "reference"] as const;
const TYPE_LABEL: Record<string, string> = { user: "User", feedback: "Feedback", project: "Project", reference: "Reference", other: "Untyped" };

function projectLabel(p: MemoryProject, home?: string): string {
  if (p.guessedPath) return home && p.guessedPath === home ? "~ (home)" : basename(p.guessedPath);
  return `${p.encoded} (missing folder)`;
}

/** Resolved projects first by label, then the ones whose folder no longer exists. */
function compareProjects(a: MemoryProject, b: MemoryProject, home?: string): number {
  const ra = a.guessedPath ? 0 : 1;
  const rb = b.guessedPath ? 0 : 1;
  return ra - rb || projectLabel(a, home).localeCompare(projectLabel(b, home));
}

const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function memoryTemplate(slug: string): string {
  return `---
name: ${slug}
description: One line that says what this memory is and when it matters
metadata:
  node_type: memory
  type: feedback
---

The rule or fact, stated plainly.

**Why:** what happened or what the user said that makes this true.

**How to apply:** when this kicks in and what to do differently.
`;
}

/** The header's List / Graph switch (prefs.memoryView). */
function ViewSwitch({ value, onChange }: { value: MemoryView; onChange: (v: MemoryView) => void }) {
  const items = [
    { id: "list", label: "List", icon: List, title: "List view: one project's memories by type" },
    { id: "graph", label: "Graph", icon: Network, title: "Graph view: every memory note and the [[links]] between them" },
  ] as const;
  return (
    <div role="radiogroup" aria-label="Memory view" data-memory-view={value} className="flex rounded-ui border border-border bg-bg-sunken p-0.5">
      {items.map((it) => {
        const on = value === it.id;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={it.title}
            onClick={() => onChange(it.id)}
            className={cx(
              "inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5 text-[11px] font-medium cursor-pointer",
              on ? "bg-bg-raised text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            <it.icon size={12} strokeWidth={2} />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

export function MemoryPanel() {
  const paths = usePaths();
  const toast = useToast();
  const { openEditor, openPath } = useOpenEditorTracked();
  const activeProject = useAtomValue(projectAtom);
  const [selected, setSelected] = useState<string | null>(null);
  /** Set once the user picks a project; until then the selection follows the active tab. */
  const [manual, setManual] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const view = useAtomValue(prefsAtom).memoryView;
  const graph = useAtomValue(graphAtom);
  const graphLoading = useAtomValue(graphLoadingAtom);
  /** A note "Reveal in list" picked from the graph: highlighted and scrolled to in the list. */
  const [revealed, setRevealed] = useState<string | null>(null);

  const projects = useLoad(
    useCallback(async () => {
      const [list, p] = await Promise.all([memory.projects(), getPaths()]);
      const sorted = [...list].sort((a, b) => compareProjects(a, b, p.home));
      setSelected((cur) => {
        if (cur && sorted.some((x) => x.encoded === cur)) return cur;
        return (sorted.find((x) => x.guessedPath === p.home) ?? sorted[0])?.encoded ?? null;
      });
      return sorted;
    }, []),
    [],
  );

  // Follow the active tab's project root (falling back to home) until a manual pick.
  const activeRoot = activeProject?.root ?? null;
  const home = paths?.home ?? null;
  useEffect(() => {
    if (manual || !projects.data) return;
    const list = projects.data;
    const target = list.find((x) => samePath(x.guessedPath, activeRoot)) ?? list.find((x) => samePath(x.guessedPath, home));
    if (target) setSelected(target.encoded);
  }, [manual, projects.data, activeRoot, home]);

  const project = projects.data?.find((p) => p.encoded === selected) ?? null;

  const docs = useLoad(
    useMemo(() => (project ? () => loadDocs(project.dir, [".md"], ["MEMORY.md"]) : null), [project?.dir]),
    [project?.dir],
  );

  // The graph loads the first time the graph view shows.
  useEffect(() => {
    if (view === "graph" && !graph) void reloadGraph();
  }, [view, graph]);

  // Scroll a revealed note into view once its project's list is loaded.
  useEffect(() => {
    if (!revealed || view !== "list" || !docs.data?.some((d) => d.path === revealed)) return;
    document.querySelector(`[data-memory-path="${CSS.escape(revealed)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [revealed, view, docs.data]);

  const refresh = () => {
    void projects.reload();
    void docs.reload();
    if (view === "graph" || graph) void reloadGraph();
  };

  const labelFor = (noteId: string) => {
    const dir = dirOf(noteId);
    const p = projects.data?.find((x) => x.dir === dir);
    return p ? projectLabel(p, paths?.home) : basename(dir.replace(/\/memory$/, ""));
  };

  const openNote = (path: string) =>
    openEditor({
      path,
      onSaved: () => {
        void docs.reload();
        void reloadGraph();
      },
    });

  const reveal = (path: string) => {
    const p = projects.data?.find((x) => x.dir === dirOf(path));
    if (!p) return;
    const node = graph?.nodes.find((n) => n.id === path);
    if (q && node && !nodeMatches(q, node)) setQ("");
    setManual(true);
    setSelected(p.encoded);
    setRevealed(path);
    void savePrefs({ memoryView: "list" });
  };

  const groups = useMemo(() => {
    const out = new Map<string, Doc[]>();
    for (const d of docs.data ?? []) {
      if (!matches(q, d.meta.name, d.meta.description, d.file)) continue;
      const t = (TYPES as readonly string[]).includes(d.meta["metadata.type"]) ? d.meta["metadata.type"] : "other";
      out.set(t, [...(out.get(t) ?? []), d]);
    }
    return [...TYPES, "other"].filter((t) => out.has(t)).map((t) => [t, out.get(t)!] as const);
  }, [docs.data, q]);

  const openIndex = () => {
    if (!project) return;
    openEditor({
      path: joinPath(project.dir, "MEMORY.md"),
      title: "MEMORY.md",
      create: "# Memory index\n\n",
      onSaved: () => void projects.reload(),
    });
  };

  const create = (raw: string) => {
    if (!project) return;
    const slug = slugify(raw);
    setCreating(false);
    openEditor({
      path: joinPath(project.dir, `${slug}.md`),
      create: memoryTemplate(slug),
      note: (
        <>
          After saving, add a line to MEMORY.md: <code className="font-mono">- [Title]({slug}.md) - one-line hook</code>
        </>
      ),
      onSaved: () => {
        void docs.reload();
        toast.info("Remember to add a line for it to MEMORY.md");
      },
    });
  };

  const remove = async (d: Doc) => {
    try {
      await files.remove(d.path);
      toast.info(`Deleted ${d.file}. Remove its MEMORY.md line too.`);
      setConfirmDelete(null);
      void docs.reload();
    } catch (e) {
      toast.error(e, "Delete failed");
    }
  };

  const total = docs.data?.length ?? 0;

  const viewSwitch = <ViewSwitch value={view} onChange={(v) => void savePrefs({ memoryView: v })} />;

  if (view === "graph") {
    return (
      <Panel title="Memory" loading={projects.loading || graphLoading} onRefresh={refresh} actions={viewSwitch}>
        <div className="flex h-full min-h-0 flex-col">
          <SearchInput value={q} onChange={setQ} placeholder="Filter memories" />
          <div className="min-h-0 flex-1 pt-2">
            {graph ? (
              <MemoryGraphView graph={graph} q={q} projectLabel={labelFor} onOpen={openNote} onReveal={reveal} />
            ) : (
              <Note>{graphLoading ? "Reading every memory folder..." : "No graph yet."}</Note>
            )}
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Memory"
      loading={projects.loading || docs.loading}
      onRefresh={refresh}
      actions={
        <>
          {viewSwitch}
          <IconButton icon={Plus} title="New memory" onClick={() => setCreating(true)} disabled={!project} />
        </>
      }
    >
      <div className="flex flex-col gap-2 px-3 pt-3">
        <Select
          value={selected ?? ""}
          onChange={(e) => {
            setManual(true);
            setRevealed(null);
            setSelected(e.target.value || null);
          }}
          title={project?.guessedPath ?? project?.encoded ?? ""}
          aria-label="Project"
        >
          {(projects.data ?? []).map((p) => (
            <option key={p.encoded} value={p.encoded} title={p.guessedPath ?? p.encoded}>
              {projectLabel(p, paths?.home)} ({p.fileCount - (p.hasIndex ? 1 : 0)})
            </option>
          ))}
          {projects.data && projects.data.length === 0 && <option value="">No projects with memory</option>}
        </Select>
        {project && (
          <div className="truncate font-mono text-[11px] text-fg-muted" title={project.guessedPath ?? project.encoded}>
            {project.guessedPath ? tildify(project.guessedPath, paths?.home) : `${project.encoded} (missing folder)`}
          </div>
        )}
        <Button icon={BookOpen} onClick={openIndex} disabled={!project} className="justify-center">
          {project?.hasIndex === false ? "Create MEMORY.md index" : "Open MEMORY.md index"}
        </Button>
      </div>

      {creating && (
        <InlinePrompt
          label="New memory file name (slug)"
          placeholder="feedback-short-topic"
          validate={(v) => {
            const s = slugify(v);
            if (!s) return "Use letters, numbers and hyphens";
            if (docs.data?.some((d) => d.file === `${s}.md`)) return `${s}.md already exists`;
            return null;
          }}
          hint="Saved as <slug>.md in this project's memory folder"
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      )}

      {(total > 6 || q) && <SearchInput value={q} onChange={setQ} placeholder="Filter memories" />}

      {project && docs.data && total === 0 && (
        <EmptyState title="No memories yet">Claude Code writes one file per memory here, indexed by MEMORY.md. Use + to add one by hand.</EmptyState>
      )}

      {groups.map(([type, list]) => (
        <div key={type}>
          <SectionHeader title={TYPE_LABEL[type]} count={list.length} />
          {list.map((d) => (
            <div key={d.path} data-memory-path={d.path}>
              <Row
                title={d.meta.name || d.file}
                subtitle={d.meta.description || d.firstLine}
                clamp={2}
                tooltip={d.path}
                active={openPath === d.path || revealed === d.path}
                onClick={() => {
                  setRevealed(null);
                  openEditor({ path: d.path, onSaved: () => void docs.reload() });
                }}
                actions={<IconButton icon={Trash} title={`Delete ${d.file}`} danger onClick={() => setConfirmDelete(d.path)} />}
              />
              {confirmDelete === d.path && (
                <ConfirmBar text={<>Delete <span className="font-mono">{d.file}</span>?</>} onConfirm={() => void remove(d)} onCancel={() => setConfirmDelete(null)} />
              )}
            </div>
          ))}
        </div>
      ))}
      {q && groups.length === 0 && total > 0 && <Note>No memories match "{q}".</Note>}
      {groups.some(([t]) => t === "other") && <Note>Untyped files have no metadata.type in their frontmatter.</Note>}
      <div className="h-3" />
    </Panel>
  );
}
