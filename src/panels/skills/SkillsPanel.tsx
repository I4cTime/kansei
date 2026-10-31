import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { files } from "../../lib/ipc";
import { IconButton } from "../ui";
import { refreshProject } from "../../app/project";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, useLoad, usePaths, useToast } from "../shared/hooks";
import { listDir, matches, readDoc, type Doc } from "../shared/docs";
import { EmptyState, InlinePrompt, Note, Panel, Row, SearchInput, SectionHeader } from "../shared/list";
import { joinPath, slugify, tildify } from "../shared/paths";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";

type Skill = Doc & { dirName: string };

function skillTemplate(slug: string): string {
  return `---
name: ${slug}
description: What this skill does and the phrases that should trigger it (for example "/${slug}" or "do the X routine").
---

# /${slug}

## When to use

## Steps

1. 
`;
}

async function loadSkills(dir: string): Promise<Skill[]> {
  const dirs = (await listDir(dir)).filter((e) => e.isDir);
  const out = await Promise.all(
    dirs.map(async (e) => {
      const path = joinPath(e.path, "SKILL.md");
      if (!(await files.exists(path))) return null;
      const d = await readDoc({ path, name: "SKILL.md", modifiedMs: e.modifiedMs });
      return { ...d, dirName: e.name };
    }),
  );
  return out.filter((x): x is Skill => x !== null).sort((a, b) => (a.meta.name || a.dirName).localeCompare(b.meta.name || b.dirName));
}

export function SkillsPanel() {
  const openEditor = useOpenEditor();
  const toast = useToast();
  const paths = usePaths();
  const { scope, choice, setScope, project } = useScope();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const projectRoot = scope === "project" ? (project?.root ?? null) : null;

  const skills = useLoad(
    useCallback(async () => {
      const dir = projectRoot ? joinPath(projectRoot, ".claude", "skills") : (await getPaths()).skillsDir;
      const exists = await files.exists(dir);
      return { dir, exists, list: exists ? await loadSkills(dir) : [] };
    }, [projectRoot]),
    [projectRoot],
  );
  const dirShown = skills.data ? tildify(skills.data.dir, paths?.home) : projectRoot ? "<project>/.claude/skills" : "~/.claude/skills";

  const shown = useMemo(() => (skills.data?.list ?? []).filter((s) => matches(q, s.meta.name, s.meta.description, s.dirName)), [skills.data, q]);
  const total = skills.data?.list.length ?? 0;

  const create = async (raw: string) => {
    if (!skills.data) return;
    const { dir } = skills.data;
    const slug = slugify(raw);
    setCreating(false);
    if (projectRoot) {
      try {
        await files.mkdir(joinPath(dir, slug));
      } catch (e) {
        toast.error(e, "Could not create the skill folder");
        return;
      }
    }
    openEditor({
      path: joinPath(dir, slug, "SKILL.md"),
      title: `${slug}/SKILL.md`,
      create: skillTemplate(slug),
      onSaved: () => {
        void skills.reload();
        if (projectRoot) void refreshProject();
      },
    });
  };

  return (
    <Panel
      title="Skills"
      loading={skills.loading}
      onRefresh={() => void skills.reload()}
      actions={<IconButton icon={Plus} title="New skill" onClick={() => setCreating(true)} disabled={!skills.data} />}
    >
      <ScopeSwitch
        value={choice}
        project={project}
        onChange={(s) => {
          setScope(s);
          setCreating(false);
          setQ("");
        }}
      />
      {creating && (
        <InlinePrompt
          label="New skill name (slug)"
          placeholder="deploy-check"
          hint={`Saved as ${dirShown}/<slug>/SKILL.md`}
          validate={(v) => {
            const s = slugify(v);
            if (!s) return "Use letters, numbers and hyphens";
            if (skills.data?.list.some((x) => x.dirName === s)) return `${s} already exists`;
            return null;
          }}
          onSubmit={(v) => void create(v)}
          onCancel={() => setCreating(false)}
        />
      )}
      {total > 6 && <SearchInput value={q} onChange={setQ} placeholder="Search skills" />}
      {skills.data && total === 0 && !projectRoot && (
        <EmptyState title="No user skills yet">
          A skill is a folder in ~/.claude/skills with a SKILL.md whose frontmatter has a name and a description. Claude Code loads it when the description matches the task, or when you type /name.
        </EmptyState>
      )}
      {skills.data && total === 0 && projectRoot && (
        <EmptyState title="No project skills">
          {skills.data.exists ? (
            <>
              <span className="font-mono">{dirShown}</span> has no skills yet. Use + to add one.
            </>
          ) : (
            <>
              <span className="font-mono">{dirShown}</span> does not exist yet. New (+) will create it.
            </>
          )}
        </EmptyState>
      )}
      {total > 0 && <SectionHeader title={q ? "Matching" : projectRoot ? "Project skills" : "User skills"} count={shown.length} />}
      {shown.map((s) => (
        <Row
          key={s.path}
          title={s.meta.name || s.dirName}
          subtitle={s.meta.description || s.firstLine}
          clamp={2}
          tooltip={s.path}
          onClick={() => openEditor({ path: s.path, title: `${s.dirName}/SKILL.md`, onSaved: () => void skills.reload() })}
        />
      ))}
      {q && shown.length === 0 && total > 0 && <Note>No skills match "{q}".</Note>}
      {total > 0 && <Note>Supporting files and scripts inside a skill folder are not listed here yet.</Note>}
      <div className="h-3" />
    </Panel>
  );
}
