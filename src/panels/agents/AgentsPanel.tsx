import { useCallback, useMemo, useState } from "react";
import { Plus, Trash } from "lucide-react";
import { files } from "../../lib/ipc";
import { Badge, IconButton } from "../ui";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, useLoad, useToast } from "../shared/hooks";
import { loadDocs, matches, type Doc } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { joinPath, slugify } from "../shared/paths";

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
  const openEditor = useOpenEditor();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const agents = useLoad(
    useCallback(async () => {
      const p = await getPaths();
      return { dir: p.agentsDir, docs: await loadDocs(p.agentsDir, [".md"]) };
    }, []),
    [],
  );

  const shown = useMemo(
    () => (agents.data?.docs ?? []).filter((d) => matches(q, d.meta.name, d.meta.description, d.meta.model, d.file)),
    [agents.data, q],
  );

  const create = (raw: string) => {
    if (!agents.data) return;
    const slug = slugify(raw);
    setCreating(false);
    openEditor({ path: joinPath(agents.data.dir, `${slug}.md`), create: agentTemplate(slug), onSaved: () => void agents.reload() });
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
      {creating && (
        <InlinePrompt
          label="New agent name (slug)"
          placeholder="code-reviewer"
          hint="Saved as ~/.claude/agents/<slug>.md"
          validate={(v) => {
            const s = slugify(v);
            if (!s) return "Use letters, numbers and hyphens";
            if (agents.data?.docs.some((d) => d.file === `${s}.md`)) return `${s}.md already exists`;
            return null;
          }}
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      )}
      {total > 0 && <SearchInput value={q} onChange={setQ} placeholder="Search agents" />}
      {agents.data && total === 0 && (
        <EmptyState title="No agents yet">
          Subagents live in ~/.claude/agents as Markdown files with a name, description, model and tools in their frontmatter.
        </EmptyState>
      )}
      {total > 0 && <SectionHeader title={q ? "Matching" : "User agents"} count={shown.length} />}
      {shown.map((d) => (
        <div key={d.path}>
          <Row
            title={d.meta.name || d.file.replace(/\.md$/, "")}
            badge={d.meta.model ? <Badge tone={modelTone(d.meta.model)}>{d.meta.model}</Badge> : undefined}
            subtitle={d.meta.description || d.firstLine}
            clamp={2}
            tooltip={[d.path, d.meta.tools && `tools: ${d.meta.tools}`].filter(Boolean).join("\n")}
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
