import { useCallback, useMemo, useState } from "react";
import { Plus, Trash } from "lucide-react";
import { files } from "../../lib/ipc";
import { Badge, Button, IconButton } from "../ui";
import { useOpenEditorTracked } from "../shared/EditorSheet";
import { refreshProject } from "../../app/project";
import { getPaths, useLoad, usePaths, useToast } from "../shared/hooks";
import { matches } from "../shared/docs";
import { ConfirmBar, EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { dirname, joinPath, tildify } from "../shared/paths";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";
import { loadRules, ruleSlug, ruleTemplate, type Rule } from "./model";

const MAX_CHIPS = 3;

function RuleChips({ r }: { r: Rule }) {
  const shown = r.globs.slice(0, MAX_CHIPS);
  const rest = r.globs.slice(MAX_CHIPS);
  return (
    <>
      {r.globs.length === 0 && (
        <Badge tone="ok" title="No paths: Claude reads this rule in every session">
          always
        </Badge>
      )}
      {shown.map((g) => (
        <Badge key={g} tone="accent" title={g} className="min-w-0 max-w-full font-mono">
          <span className="truncate">{g}</span>
        </Badge>
      ))}
      {rest.length > 0 && <Badge title={rest.join("\n")}>+{rest.length}</Badge>}
      {r.failed && <Badge title="The frontmatter block could not be parsed, so it is treated as having no paths">no frontmatter</Badge>}
      {r.unreadable && <Badge tone="warn">unreadable</Badge>}
    </>
  );
}

export function RulesPanel() {
  const toast = useToast();
  const paths = usePaths();
  const { openEditor, openPath } = useOpenEditorTracked();
  const { scope, choice, setScope, project } = useScope();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const projectRoot = scope === "project" ? (project?.root ?? null) : null;

  const rules = useLoad(
    useCallback(async () => {
      const dir = projectRoot ? joinPath(projectRoot, ".claude", "rules") : joinPath((await getPaths()).claudeDir, "rules");
      const exists = await files.exists(dir);
      return { dir, exists, list: exists ? await loadRules(dir) : [] };
    }, [projectRoot]),
    [projectRoot],
  );
  const dirShown = rules.data ? tildify(rules.data.dir, paths?.home) : projectRoot ? "<project>/.claude/rules" : "~/.claude/rules";

  const shown = useMemo(
    () => (rules.data?.list ?? []).filter((r) => matches(q, r.name, r.summary, ...r.globs)),
    [rules.data, q],
  );
  const total = rules.data?.list.length ?? 0;

  const create = async (raw: string) => {
    if (!rules.data) return;
    const { dir } = rules.data;
    const slug = ruleSlug(raw);
    const path = joinPath(dir, `${slug}.md`);
    setCreating(false);
    if (projectRoot) {
      try {
        await files.mkdir(dirname(path));
      } catch (e) {
        toast.error(e, "Could not create the rules folder");
        return;
      }
    }
    openEditor({
      path,
      title: `${slug}.md`,
      create: ruleTemplate(slug),
      onSaved: () => {
        void rules.reload();
        if (projectRoot) void refreshProject();
      },
    });
  };

  const remove = async (r: Rule) => {
    try {
      await files.remove(r.path);
      toast.info(`Deleted ${r.name}.md`);
      setConfirmDelete(null);
      void rules.reload();
    } catch (e) {
      toast.error(e, "Delete failed");
    }
  };

  return (
    <Panel
      title="Rules"
      loading={rules.loading}
      onRefresh={() => void rules.reload()}
      actions={<IconButton icon={Plus} title="New rule" onClick={() => setCreating(true)} disabled={!rules.data} />}
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
          label="New rule name (a slash makes a subfolder)"
          placeholder="frontend/react"
          hint={`Saved as ${dirShown}/<name>.md`}
          validate={(v) => {
            const s = ruleSlug(v);
            if (!s) return "Use letters, numbers, hyphens and slashes";
            if (rules.data?.list.some((r) => r.name === s)) return `${s}.md already exists`;
            return null;
          }}
          onSubmit={(v) => void create(v)}
          onCancel={() => setCreating(false)}
        />
      )}
      {total > 0 && <SearchInput value={q} onChange={setQ} placeholder="Search rules" />}
      {rules.data && total === 0 && !creating && (
        <EmptyState title="No rules yet">
          Rules are extra instructions Claude reads for matching files, or always when they have no paths.
          <div className="mt-1 font-mono">{dirShown}</div>
          <div className="mt-2 flex justify-center">
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New rule
            </Button>
          </div>
        </EmptyState>
      )}
      {total > 0 && <SectionHeader title={q ? "Matching" : projectRoot ? "Project rules" : "User rules"} count={shown.length} />}
      {shown.map((r) => (
        <div key={r.path}>
          <Row
            title={r.name}
            subtitle={r.summary || undefined}
            extra={<RuleChips r={r} />}
            tooltip={[r.path, r.globs.length ? `paths: ${r.globs.join(", ")}` : "paths: none (always loaded)"].join("\n")}
            active={openPath === r.path}
            onClick={() => openEditor({ path: r.path, title: `${r.name}.md`, onSaved: () => void rules.reload() })}
            actions={<IconButton icon={Trash} title={`Delete ${r.name}.md`} danger onClick={() => setConfirmDelete(r.path)} />}
          />
          {confirmDelete === r.path && (
            <ConfirmBar text={<>Delete rule <span className="font-mono">{r.name}.md</span>?</>} onConfirm={() => void remove(r)} onCancel={() => setConfirmDelete(null)} />
          )}
        </div>
      ))}
      {q && shown.length === 0 && total > 0 && <Note>No rules match "{q}".</Note>}
      <div className="h-3" />
    </Panel>
  );
}
