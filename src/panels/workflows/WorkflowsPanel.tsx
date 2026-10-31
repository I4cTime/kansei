import { useCallback, useState } from "react";
import { Plus, Trash } from "lucide-react";
import { files } from "../../lib/ipc";
import { IconButton } from "../ui";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, useLoad, useToast } from "../shared/hooks";
import { listDir } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SectionHeader } from "../shared/list";
import { joinPath, slugify } from "../shared/paths";
import { readMeta, workflowTemplate } from "./model";

type Workflow = { path: string; file: string; name: string; description: string };

async function loadWorkflows(dir: string): Promise<Workflow[]> {
  const entries = (await listDir(dir)).filter((e) => !e.isDir && /\.(m?js)$/.test(e.name));
  const out = await Promise.all(
    entries.map(async (e): Promise<Workflow> => {
      let meta: { name?: string; description?: string } = {};
      try {
        meta = readMeta(await files.readText(e.path));
      } catch {
        // unreadable: listed by file name only
      }
      return { path: e.path, file: e.name, name: meta.name ?? e.name.replace(/\.m?js$/, ""), description: meta.description ?? "" };
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function WorkflowsPanel() {
  const toast = useToast();
  const openEditor = useOpenEditor();
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const wf = useLoad(
    useCallback(async () => {
      const p = await getPaths();
      return { dir: p.workflowsDir, list: await loadWorkflows(p.workflowsDir) };
    }, []),
    [],
  );
  const total = wf.data?.list.length ?? 0;

  const create = (raw: string) => {
    if (!wf.data) return;
    const name = slugify(raw);
    setCreating(false);
    openEditor({ path: joinPath(wf.data.dir, `${name}.js`), create: workflowTemplate(name), onSaved: () => void wf.reload() });
  };

  const remove = async (w: Workflow) => {
    try {
      await files.remove(w.path);
      toast.info(`Deleted ${w.file}`);
      setConfirmDelete(null);
      void wf.reload();
    } catch (e) {
      toast.error(e, "Delete failed");
    }
  };

  return (
    <Panel
      title="Workflows"
      loading={wf.loading}
      onRefresh={() => void wf.reload()}
      actions={<IconButton icon={Plus} title="New workflow" onClick={() => setCreating(true)} disabled={!wf.data} />}
    >
      {creating && (
        <InlinePrompt
          label="New workflow name"
          placeholder="find-flaky-tests"
          hint="Saved as ~/.claude/workflows/<name>.js (the folder is created on first save)"
          validate={(v) => {
            const s = slugify(v);
            if (!s) return "Use letters, numbers and hyphens";
            if (wf.data?.list.some((x) => x.file === `${s}.js`)) return `${s}.js already exists`;
            return null;
          }}
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      )}
      {wf.data && total === 0 && !creating && (
        <EmptyState title="No workflows yet">
          A workflow is a JavaScript file in ~/.claude/workflows that orchestrates subagents: it starts with an{" "}
          <code className="font-mono">export const meta</code> block, then calls agent(), parallel() and pipeline(). Claude Code runs a saved
          workflow when you ask for it by name. Use + to start one from a template.
        </EmptyState>
      )}
      {total > 0 && <SectionHeader title="User workflows" count={total} />}
      {(wf.data?.list ?? []).map((w) => (
        <div key={w.path}>
          <Row
            title={w.name}
            subtitle={w.description || w.file}
            clamp={2}
            tooltip={w.path}
            onClick={() => openEditor({ path: w.path, onSaved: () => void wf.reload() })}
            actions={<IconButton icon={Trash} title={`Delete ${w.file}`} danger onClick={() => setConfirmDelete(w.path)} />}
          />
          {confirmDelete === w.path && (
            <ConfirmBar text={<>Delete workflow <span className="font-mono">{w.file}</span>?</>} onConfirm={() => void remove(w)} onCancel={() => setConfirmDelete(null)} />
          )}
        </div>
      ))}
      {total > 0 && <Note>Ask Claude Code to run one by name. Project workflows in a repo's .claude/workflows are not listed here.</Note>}
      <div className="h-3" />
    </Panel>
  );
}
