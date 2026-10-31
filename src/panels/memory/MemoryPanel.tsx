import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { BookOpen, Plus, Trash } from "lucide-react";
import { files, memory, type MemoryProject } from "../../lib/ipc";
import { projectAtom } from "../../app/project";
import { Button, IconButton, Select } from "../ui";
import { useOpenEditorTracked } from "../shared/EditorSheet";
import { getPaths, useLoad, usePaths, useToast } from "../shared/hooks";
import { loadDocs, matches, type Doc } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { basename, joinPath, slugify, tildify } from "../shared/paths";

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

  const refresh = () => {
    void projects.reload();
    void docs.reload();
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

  return (
    <Panel
      title="Memory"
      loading={projects.loading || docs.loading}
      onRefresh={refresh}
      actions={<IconButton icon={Plus} title="New memory" onClick={() => setCreating(true)} disabled={!project} />}
    >
      <div className="flex flex-col gap-2 px-3 pt-3">
        <Select
          value={selected ?? ""}
          onChange={(e) => {
            setManual(true);
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

      {total > 6 && <SearchInput value={q} onChange={setQ} placeholder="Filter memories" />}

      {project && docs.data && total === 0 && (
        <EmptyState title="No memories yet">Claude Code writes one file per memory here, indexed by MEMORY.md. Use + to add one by hand.</EmptyState>
      )}

      {groups.map(([type, list]) => (
        <div key={type}>
          <SectionHeader title={TYPE_LABEL[type]} count={list.length} />
          {list.map((d) => (
            <div key={d.path}>
              <Row
                title={d.meta.name || d.file}
                subtitle={d.meta.description || d.firstLine}
                clamp={2}
                tooltip={d.path}
                active={openPath === d.path}
                onClick={() => openEditor({ path: d.path, onSaved: () => void docs.reload() })}
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
