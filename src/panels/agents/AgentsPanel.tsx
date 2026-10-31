import { useCallback, useMemo, useState } from "react";
import { Plus, Trash } from "lucide-react";
import { files } from "../../lib/ipc";
import { Badge, IconButton } from "../ui";
import { useOpenEditorTracked } from "../shared/EditorSheet";
import { refreshProject } from "../../app/project";
import { getPaths, useLoad, usePaths, useToast } from "../shared/hooks";
import { loadDocs, matches, type Doc } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { joinPath, slugify, tildify } from "../shared/paths";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";

function agentTemplate(slug: string): string {
  return `---
name: ${slug}
description: What this agent is for and when to use it. Claude reads this to decide when to delegate.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are the ${slug} agent. Describe the job, the inputs you expect, and exactly
what to return to the caller.
`;
}

export function modelTone(model: string | undefined): "accent" | "ok" | "warn" | "muted" {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "warn";
  if (m.includes("sonnet")) return "accent";
  if (m.includes("haiku")) return "ok";
  return "muted";
}

export function AgentsPanel() {
  const toast = useToast();
  const paths = usePaths();
  const { openEditor, openPath } = useOpenEditorTracked();
  const { scope, choice, setScope, project } = useScope();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const projectRoot = scope === "project" ? (project?.root ?? null) : null;

  const agents = useLoad(
    useCallback(async () => {
      const dir = projectRoot ? joinPath(projectRoot, ".claude", "agents") : (await getPaths()).agentsDir;
      const exists = await files.exists(dir);
      return { dir, exists, docs: exists ? await loadDocs(dir, [".md"]) : [] };
    }, [projectRoot]),
    [projectRoot],
  );
  const dirShown = agents.data ? tildify(agents.data.dir, paths?.home) : projectRoot ? "<project>/.claude/agents" : "~/.claude/agents";

  const shown = useMemo(
    () => (agents.data?.docs ?? []).filter((d) => matches(q, d.meta.name, d.meta.description, d.meta.model, d.file)),
    [agents.data, q],
  );

  const create = async (raw: string) => {
    if (!agents.data) return;
    const { dir } = agents.data;
    const slug = slugify(raw);
    setCreating(false);
    if (projectRoot) {
      try {
        await files.mkdir(dir);
      } catch (e) {
        toast.error(e, "Could not create the agents folder");
        return;
      }
    }
    openEditor({
      path: joinPath(dir, `${slug}.md`),
      create: agentTemplate(slug),
      onSaved: () => {
        void agents.reload();
        if (projectRoot) void refreshProject();
      },
    });
  };

  const remove = async (d: Doc) => {
    try {
      await files.remove(d.path);
      toast.info(`Deleted ${d.file}`);
      setConfirmDelete(null);
      void agents.reload();
    } catch (e) {
      toast.error(e, "Delete failed");
    }
  };

  const total = agents.data?.docs.length ?? 0;

  return (
    <Panel
      title="Agents"
      loading={agents.loading}
      onRefresh={() => void agents.reload()}
      actions={<IconButton icon={Plus} title="New agent" onClick={() => setCreating(true)} disabled={!agents.data} />}
    >
      <ScopeSwitch
        value={choice}
        project={project}
        onChange={(s) => {
          setScope(s);
          setCreating(false);
          setConfirmDelete(null);
          setQ("");
        }}
      />
      {creating && (
        <InlinePrompt
          label="New agent name (slug)"
          placeholder="code-reviewer"
          hint={`Saved as ${dirShown}/<slug>.md`}
          validate={(v) => {
            const s = slugify(v);
            if (!s) return "Use letters, numbers and hyphens";
            if (agents.data?.docs.some((d) => d.file === `${s}.md`)) return `${s}.md already exists`;
            return null;
          }}
          onSubmit={(v) => void create(v)}
          onCancel={() => setCreating(false)}
        />
      )}
      {total > 0 && <SearchInput value={q} onChange={setQ} placeholder="Search agents" />}
      {agents.data && total === 0 && !projectRoot && (
        <EmptyState title="No agents yet">
          Subagents live in ~/.claude/agents as Markdown files with a name, description, model and tools in their frontmatter.
        </EmptyState>
      )}
      {agents.data && total === 0 && projectRoot && (
        <EmptyState title="No project agents">
          {agents.data.exists ? (
            <>
              <span className="font-mono">{dirShown}</span> has no agents yet. Use + to add one.
            </>
          ) : (
            <>
              <span className="font-mono">{dirShown}</span> does not exist yet. New (+) will create it.
            </>
          )}
        </EmptyState>
      )}
      {total > 0 && <SectionHeader title={q ? "Matching" : projectRoot ? "Project agents" : "User agents"} count={shown.length} />}
      {shown.map((d) => (
        <div key={d.path}>
          <Row
            title={d.meta.name || d.file.replace(/\.md$/, "")}
            badge={d.meta.model ? <Badge tone={modelTone(d.meta.model)}>{d.meta.model}</Badge> : undefined}
            subtitle={d.meta.description || d.firstLine}
            clamp={2}
            tooltip={[d.path, d.meta.tools && `tools: ${d.meta.tools}`].filter(Boolean).join("\n")}
            active={openPath === d.path}
            onClick={() => openEditor({ path: d.path, onSaved: () => void agents.reload() })}
            actions={<IconButton icon={Trash} title={`Delete ${d.file}`} danger onClick={() => setConfirmDelete(d.path)} />}
          />
          {confirmDelete === d.path && (
            <ConfirmBar text={<>Delete agent <span className="font-mono">{d.file}</span>?</>} onConfirm={() => void remove(d)} onCancel={() => setConfirmDelete(null)} />
          )}
        </div>
      ))}
      {q && shown.length === 0 && total > 0 && <Note>No agents match "{q}".</Note>}
      <div className="h-3" />
    </Panel>
  );
}
