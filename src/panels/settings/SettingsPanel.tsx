import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { FileText } from "lucide-react";
import { prefsAtom, savePrefs, type Prefs } from "../../app/prefs";
import { refreshProject } from "../../app/project";
import type { ProjectInfo } from "../../lib/ipc";
import { Badge, Button, Field, Select, TextInput, Toggle, cx } from "../ui";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, readJsonObject, useLoad, useToast, writeJson } from "../shared/hooks";
import { Note, Panel, SectionHeader } from "../shared/list";
import { basename, joinPath } from "../shared/paths";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";

type Tab = "claude" | "app";

const CLAUDE_THEMES = ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"];

export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("claude");
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <Panel title="Settings" onRefresh={() => setReloadKey((n) => n + 1)}>
      <div className="flex gap-3 border-b border-border px-3 pt-2" role="tablist">
        {(
          [
            ["claude", "Claude"],
            ["app", "This app"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx(
              "-mb-px cursor-pointer border-b-2 px-1 pt-1 pb-1.5 text-xs font-medium transition-colors",
              tab === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "claude" ? <ClaudeScoped reloadKey={reloadKey} /> : <AppSettings />}
    </Panel>
  );
}

function ClaudeScoped({ reloadKey }: { reloadKey: number }) {
  const { scope, choice, setScope, project } = useScope();
  return (
    <>
      <ScopeSwitch value={choice} project={project} onChange={setScope} />
      {scope === "project" && project ? <ProjectSettings key={reloadKey} project={project} /> : <ClaudeSettings key={reloadKey} />}
    </>
  );
}

function ProjectSettings({ project }: { project: ProjectInfo }) {
  const openEditor = useOpenEditor();
  useEffect(() => {
    void refreshProject();
  }, []);
  const name = basename(project.root) || project.root;
  const rows: { label: string; rel: string; exists: boolean; create: string; note?: string }[] = [
    { label: "CLAUDE.md", rel: "CLAUDE.md", exists: project.exists.claudeMd, create: `# ${name}\n\n`, note: "Shared project instructions, usually checked in." },
    {
      label: "CLAUDE.local.md",
      rel: "CLAUDE.local.md",
      exists: project.exists.claudeLocalMd,
      create: `# ${name} (local)\n\n`,
      note: "Your private instructions for this project. Keep it out of git.",
    },
    { label: ".claude/settings.json", rel: ".claude/settings.json", exists: project.exists.settings, create: "{}\n", note: "Shared project settings, usually checked in." },
    {
      label: ".claude/settings.local.json",
      rel: ".claude/settings.local.json",
      exists: project.exists.settingsLocal,
      create: "{}\n",
      note: "Your private settings for this project. Keep it out of git.",
    },
  ];
  return (
    <div className="flex flex-col">
      <SectionHeader title="Project files" />
      <div className="flex flex-col gap-1.5 px-3 py-1">
        {rows.map((r) => {
          const path = joinPath(project.root, r.rel);
          return (
            <Button
              key={r.rel}
              icon={FileText}
              title={path}
              className="min-w-0"
              onClick={() => openEditor({ path, title: r.label, create: r.create, note: r.note, onSaved: () => void refreshProject() })}
            >
              <span className="min-w-0 flex-1 truncate text-left">{r.label}</span>
              {!r.exists && <Badge>missing</Badge>}
            </Button>
          );
        })}
      </div>
      <Note>Missing files open with a starter and are created on first save.</Note>
      <div className="h-3" />
    </div>
  );
}

type ClaudeForm = { model: string; theme: string; autoMode: boolean | null };

function ClaudeSettings() {
  const toast = useToast();
  const openEditor = useOpenEditor();
  const [form, setForm] = useState<ClaudeForm | null>(null);
  const [saving, setSaving] = useState(false);

  const loaded = useLoad(
    useCallback(async () => {
      const p = await getPaths();
      const s = await readJsonObject(p.settings);
      const f: ClaudeForm = {
        model: typeof s.model === "string" ? s.model : "",
        theme: typeof s.theme === "string" ? s.theme : "",
        autoMode: typeof s.autoMode === "boolean" ? s.autoMode : null,
      };
      setForm(f);
      return { paths: p, form: f, autoModeKind: s.autoMode === undefined ? "absent" : typeof s.autoMode === "boolean" ? "boolean" : "object" };
    }, []),
    [],
  );

  const base = loaded.data?.form;
  const dirty = !!form && !!base && (form.model !== base.model || form.theme !== base.theme || form.autoMode !== base.autoMode);

  const save = async () => {
    if (!form || !loaded.data) return;
    setSaving(true);
    try {
      const s = await readJsonObject(loaded.data.paths.settings);
      const next: Record<string, unknown> = { ...s };
      const model = form.model.trim();
      if (model) next.model = model;
      else delete next.model;
      if (form.theme) next.theme = form.theme;
      else delete next.theme;
      if (form.autoMode !== null && (typeof s.autoMode === "boolean" || s.autoMode === undefined)) next.autoMode = form.autoMode;
      await writeJson(loaded.data.paths.settings, next);
      toast.info("Saved settings.json");
      await loaded.reload();
    } catch (e) {
      toast.error(e, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const open = (path: string, note?: string) => {
    if (dirty) {
      toast.error("Save or revert the fields above first");
      return;
    }
    openEditor({ path, create: "{}\n", note, onSaved: () => void loaded.reload() });
  };

  const themes = form && form.theme && !CLAUDE_THEMES.includes(form.theme) ? [form.theme, ...CLAUDE_THEMES] : CLAUDE_THEMES;
  const p = loaded.data?.paths;

  return (
    <div className="flex flex-col">
      <SectionHeader title="settings.json" />
      {form ? (
        <div className="flex flex-col gap-2.5 px-3 py-1">
          <Field label="Model" hint="Alias or full model id. Empty uses the default.">
            <TextInput className="font-mono" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="sonnet" />
          </Field>
          <Field label="Theme">
            <Select value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })}>
              <option value="">(not set)</option>
              {themes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Auto mode</span>
            {loaded.data?.autoModeKind === "object" ? (
              <span className="text-[11px] text-fg-muted">configured as an object, edit raw</span>
            ) : (
              <Toggle label="Auto mode" checked={!!form.autoMode} onChange={(v) => setForm({ ...form, autoMode: v })} />
            )}
          </div>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => base && setForm(base)} disabled={!dirty || saving}>
              Revert
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Note>Loading...</Note>
      )}
      <Note>Permissions, plugins, marketplaces and the rest are edited raw for now.</Note>

      <SectionHeader title="Raw files" />
      <div className="flex flex-col gap-1.5 px-3 py-1">
        <Button icon={FileText} disabled={!p} onClick={() => p && open(p.settings)} title={p?.settings}>
          settings.json
        </Button>
        <Button icon={FileText} disabled={!p} onClick={() => p && open(p.settingsLocal)} title={p?.settingsLocal}>
          settings.local.json
        </Button>
        <Button
          icon={FileText}
          disabled={!p}
          title={p?.claudeJson}
          onClick={() => p && open(p.claudeJson, "Claude Code rewrites ~/.claude.json while sessions run. Save quickly, and prefer the MCPs panel for servers.")}
        >
          ~/.claude.json
        </Button>
      </div>
      <div className="h-3" />
    </div>
  );
}

function AppSettings() {
  const prefs = useAtomValue(prefsAtom);
  const toast = useToast();
  const [font, setFont] = useState(prefs.fontFamily);
  const [size, setSize] = useState(String(prefs.fontSize));
  useEffect(() => setFont(prefs.fontFamily), [prefs.fontFamily]);
  useEffect(() => setSize(String(prefs.fontSize)), [prefs.fontSize]);

  const save = (patch: Partial<Prefs>) => {
    savePrefs(patch).catch((e) => toast.error(e, "Could not save prefs"));
  };

  const commitSize = () => {
    const n = Number(size);
    if (Number.isFinite(n) && n >= 8 && n <= 32) {
      if (n !== prefs.fontSize) save({ fontSize: n });
    } else setSize(String(prefs.fontSize));
  };

  const commitFont = () => {
    const f = font.trim();
    if (f && f !== prefs.fontFamily) save({ fontFamily: f });
    else if (!f) setFont(prefs.fontFamily);
  };

  return (
    <div className="flex flex-col">
      <SectionHeader title="Tabs" />
      <div className="flex flex-col gap-2.5 px-3 py-1">
        <Field label="New tab runs">
          <Select value={prefs.newTabCommand} onChange={(e) => save({ newTabCommand: e.target.value as Prefs["newTabCommand"] })}>
            <option value="claude">claude</option>
            <option value="shell">login shell</option>
          </Select>
        </Field>
      </div>
      <SectionHeader title="Terminal" />
      <div className="flex flex-col gap-2.5 px-3 py-1">
        <Field label="Font size" hint="8 to 32 px">
          <TextInput
            type="number"
            min={8}
            max={32}
            value={size}
            onChange={(e) => setSize(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === "Enter" && commitSize()}
          />
        </Field>
        <Field label="Font family" hint="CSS font-family list">
          <TextInput
            className="font-mono"
            value={font}
            onChange={(e) => setFont(e.target.value)}
            onBlur={commitFont}
            onKeyDown={(e) => e.key === "Enter" && commitFont()}
            title={font}
          />
        </Field>
      </div>
      <SectionHeader title="Appearance" />
      <div className="flex flex-col gap-2.5 px-3 py-1">
        <Field label="Theme">
          <Select value={prefs.theme} onChange={(e) => save({ theme: e.target.value as Prefs["theme"] })}>
            <option value="system">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Select>
        </Field>
      </div>
      <Note>Saved to ~/.local/share/tsukue/prefs.json. Terminals pick up font and theme changes live.</Note>
      <div className="h-3" />
    </div>
  );
}
