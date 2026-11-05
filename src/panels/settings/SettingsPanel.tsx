import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { ExternalLink, FileText, FolderPlus, Palette as PaletteIcon, Unlink, Upload, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, claudeCommandAtom, prefsAtom, savePrefs, type Prefs } from "../../app/prefs";
import { refreshProject } from "../../app/project";
import { theme as themeIpc, type ProjectInfo } from "../../lib/ipc";
import { activeThemeAtom, omarchyAtom } from "../../app/theme/apply";
import { BASE_COLORS, prettyName } from "../../app/theme/palette";
import { PRESETS, findPreset, type Preset } from "../../app/theme/presets";
import { themeTickAtom } from "../../app/terminalTheme";
import { Badge, Button, Field, IconButton, Select, TextInput, Toggle, cx } from "../ui";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, readJsonObject, useLoad, usePaths, useToast, writeJson } from "../shared/hooks";
import { Note, Panel, SectionHeader } from "../shared/list";
import { basename, joinPath, tildify } from "../shared/paths";
import { addWorkspaceRootWithPicker, removeWorkspaceRoot } from "../projects/actions";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";
import { BoardConnectForm, RequiredFieldsNote } from "../board/BoardConnect";
import { disconnectBoard } from "../board/actions";

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
  const [ctxWindow, setCtxWindow] = useState(String(prefs.contextWindow));
  const [claude, setClaude] = useState(prefs.claudeCommand);
  const resolved = useAtomValue(claudeCommandAtom);
  const home = usePaths()?.home;
  useEffect(() => setFont(prefs.fontFamily), [prefs.fontFamily]);
  useEffect(() => setClaude(prefs.claudeCommand), [prefs.claudeCommand]);
  useEffect(() => setSize(String(prefs.fontSize)), [prefs.fontSize]);
  useEffect(() => setCtxWindow(String(prefs.contextWindow)), [prefs.contextWindow]);

  const save = (patch: Partial<Prefs>) => {
    savePrefs(patch).catch((e) => toast.error(e, "Could not save prefs"));
  };

  const commitSize = () => {
    const n = Number(size);
    if (Number.isFinite(n) && n >= 8 && n <= 32) {
      if (n !== prefs.fontSize) save({ fontSize: n });
    } else setSize(String(prefs.fontSize));
  };

  const commitWindow = () => {
    const n = Math.round(Number(ctxWindow));
    if (Number.isFinite(n) && n >= CONTEXT_WINDOW_MIN && n <= CONTEXT_WINDOW_MAX) {
      if (n !== prefs.contextWindow) save({ contextWindow: n });
      else setCtxWindow(String(n));
    } else setCtxWindow(String(prefs.contextWindow));
  };

  const commitClaude = () => {
    const c = claude.trim();
    if (c !== prefs.claudeCommand) save({ claudeCommand: c });
    else setClaude(c);
  };
  const claudeDefault = resolved.local ? `${tildify(resolved.local, home)} (found)` : "claude (PATH)";

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
        <Field label="Claude command" hint="Leave empty to use ~/.local/bin/claude when it exists, otherwise claude from PATH.">
          <TextInput
            className="font-mono"
            value={claude}
            onChange={(e) => setClaude(e.target.value)}
            onBlur={commitClaude}
            onKeyDown={(e) => e.key === "Enter" && commitClaude()}
            placeholder={claudeDefault}
            title={resolved.source === "pref" ? `Runs ${resolved.command}` : `Runs ${resolved.command} (default)`}
            spellCheck={false}
            data-claude-command
          />
        </Field>
      </div>
      <WorkspaceRoots />
      <BoardSettings />
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
        <Field label="Context window" hint="Tokens the tab gauge measures against, 50000 to 2000000. A session past 200000 tokens uses 1000000.">
          <TextInput
            type="number"
            min={CONTEXT_WINDOW_MIN}
            max={CONTEXT_WINDOW_MAX}
            step={1000}
            value={ctxWindow}
            onChange={(e) => setCtxWindow(e.target.value)}
            onBlur={commitWindow}
            onKeyDown={(e) => e.key === "Enter" && commitWindow()}
            data-context-window
          />
        </Field>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Notify when a hidden tab needs you</span>
            <Toggle label="Notify when a hidden tab needs you" checked={prefs.notifyWaiting} onChange={(v) => save({ notifyWaiting: v })} />
          </div>
          <span className="text-[11px] text-fg-muted">A desktop notification when Claude in a tab you are not looking at asks for permission, asks a question or finishes its turn.</span>
        </div>
      </div>
      <Appearance prefs={prefs} save={save} />
      <Note>Saved to ~/.local/share/kansei/prefs.json. Terminals pick up font and theme changes live.</Note>
      <div className="h-3" />
    </div>
  );
}

function Appearance({ prefs, save }: { prefs: Prefs; save: (patch: Partial<Prefs>) => void }) {
  const omarchy = useAtomValue(omarchyAtom);
  const preset = prefs.theme.startsWith("preset:") ? findPreset(prefs.theme.slice("preset:".length)) : undefined;
  const paletteSource = prefs.theme === "omarchy" || !!preset;
  const omarchyLabel = omarchy ? `Follow Omarchy (${prettyName(omarchy.name)})` : omarchy === null ? "Follow Omarchy (Omarchy theme not found)" : "Follow Omarchy";
  return (
    <>
      <SectionHeader title="Appearance" />
      <div className="flex flex-col gap-2.5 px-3 py-1" data-appearance>
        <Field label="Theme">
          <Select value={prefs.theme} onChange={(e) => save({ theme: e.target.value as Prefs["theme"] })} data-theme-select>
            <option value="system">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="omarchy">{omarchyLabel}</option>
            <optgroup label="Presets">
              {PRESETS.map((p) => (
                <option key={p.id} value={`preset:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Swatches />
        {preset && <PresetControls preset={preset} effects={prefs.effects} save={save} />}
        {paletteSource && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Theme Claude Code too</span>
              <Toggle label="Theme Claude Code too" checked={prefs.claudeTheme} onChange={(v) => save({ claudeTheme: v })} />
            </div>
            <span className="text-[11px] text-fg-muted">Writes ~/.claude/themes/kansei.json and sets theme to custom:kansei in ~/.claude/settings.json. The previous theme comes back with a built-in source.</span>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Project accents</span>
            <Toggle label="Project accents" checked={prefs.projectAccents} onChange={(v) => save({ projectAccents: v })} />
          </div>
          <span className="text-[11px] text-fg-muted">Tints each tab, the terminal column and the sidebar header with the project's colour (set one per project in its Edit sheet). The Calendar dots keep their colours.</span>
        </div>
      </div>
    </>
  );
}

/** 10 px squares: background, raised, accent, foreground, then the eight base colours. */
function Swatches() {
  const active = useAtomValue(activeThemeAtom);
  // The tick re-reads the built-in tokens when the theme or the OS scheme changes.
  const tick = useAtomValue(themeTickAtom);
  const colors = useMemo((): [string, string][] => {
    const p = active.palette;
    if (p) {
      return [
        ["background", p.background],
        ["raised", p.lighter_background],
        ["accent", p.accent],
        ["foreground", p.foreground],
        ...BASE_COLORS.map((k): [string, string] => [k, p[k]]),
      ];
    }
    // Built-in sources: read the CSS tokens in effect.
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim();
    return [
      ["background", v("--bg")],
      ["raised", v("--bg-raised")],
      ["accent", v("--accent")],
      ["foreground", v("--fg")],
      ...(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const).map((k): [string, string] => [k, v(`--t-${k}`)]),
    ];
  }, [active, tick]);
  return (
    <div className="flex flex-wrap items-center gap-1" data-theme-swatches title={active.name}>
      {colors.map(([name, color], i) => (
        <span
          key={name}
          title={`${name} ${color}`}
          className={cx("h-[10px] w-[10px] shrink-0 border border-border", i === 4 && "ml-1.5")}
          style={{ background: color }}
        />
      ))}
    </div>
  );
}

function PresetControls({ preset, effects, save }: { preset: Preset; effects: boolean; save: (patch: Partial<Prefs>) => void }) {
  const toast = useToast();
  const home = usePaths()?.home;
  const [busy, setBusy] = useState(false);
  const hasEffects = !!(preset.effects && Object.values(preset.effects).some(Boolean));
  const slug = `kansei-${preset.id}`;
  const exportTheme = async (apply: boolean) => {
    setBusy(true);
    try {
      const dir = tildify(await themeIpc.exportOmarchy({ slug, name: preset.name, palette: preset.palette, apply }), home);
      toast.info(apply ? `Exported to ${dir} and applied` : `Exported to ${dir}. Apply with: omarchy theme set ${slug}`);
    } catch (e) {
      toast.error(e, "Export failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2.5" data-preset-controls>
      <span className="text-[11px] text-fg-muted italic">{preset.tagline}</span>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted" title={hasEffects ? undefined : "This preset has no effects"}>
          Visual effects
        </span>
        <Toggle label="Visual effects" checked={effects} disabled={!hasEffects} onChange={(v) => save({ effects: v })} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button icon={Upload} disabled={busy} onClick={() => void exportTheme(false)} title={`Writes ~/.config/omarchy/themes/${slug}`}>
          Export as Omarchy theme
        </Button>
        <Button icon={PaletteIcon} disabled={busy} onClick={() => void exportTheme(true)} title={`Exports, then runs omarchy theme set ${slug}`}>
          Export and apply
        </Button>
      </div>
    </div>
  );
}

/** The connected GitHub Project: owner, number and hub repo, Connect / Reconnect and Disconnect. */
function BoardSettings() {
  const config = useAtomValue(prefsAtom).board;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectBoard();
      toast.info("Board disconnected");
    } catch (e) {
      toast.error(e, "Could not save prefs");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionHeader title="Board" />
      <div className="flex flex-col gap-2.5 px-3 py-1" data-board-settings="">
        {config ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            <span className="shrink-0">Connected to</span>
            <button
              type="button"
              className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-accent underline-offset-2 hover:underline"
              title={config.url}
              onClick={() => openUrl(config.url).catch((e) => toast.error(e, "Could not open the browser"))}
            >
              <span className="truncate">{config.title}</span>
              <ExternalLink size={11} className="shrink-0" />
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-fg-muted">Not connected. Board and Calendar tasks stay empty.</span>
        )}
        <BoardConnectForm
          config={config}
          extra={
            config && (
              <Button icon={Unlink} variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )
          }
        />
      </div>
      <div className="px-3 py-1">
        <RequiredFieldsNote />
      </div>
    </>
  );
}

function WorkspaceRoots() {
  const roots = useAtomValue(prefsAtom).workspaceRoots;
  const home = usePaths()?.home;
  const toast = useToast();
  const add = async () => {
    try {
      const p = await addWorkspaceRootWithPicker();
      if (p) toast.info(`Added workspace root ${tildify(p, home)}`);
    } catch (e) {
      toast.error(e, "Could not add the workspace root");
    }
  };
  return (
    <>
      <SectionHeader title="Projects" />
      <div className="flex flex-col gap-1.5 px-3 py-1" data-workspace-roots>
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Workspace roots</span>
        {roots.length === 0 && <span className="text-[11px] text-fg-muted">None. The Projects tree stays empty.</span>}
        {roots.map((r) => (
          <div key={r} className="flex min-w-0 items-center gap-1 rounded-ui border border-border bg-bg-sunken py-0.5 pr-0.5 pl-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={r}>
              {tildify(r, home)}
            </span>
            <IconButton
              icon={X}
              danger
              title={`Remove ${tildify(r, home)}`}
              onClick={() => removeWorkspaceRoot(r).catch((e) => toast.error(e, "Could not save prefs"))}
            />
          </div>
        ))}
        <div>
          <Button icon={FolderPlus} onClick={() => void add()}>
            Add root
          </Button>
        </div>
      </div>
      <Note>
        The Projects tree scans each root (groups, then projects, monorepo apps as subprojects) and keeps a generated PROJECTS.md in it. Removing a root keeps its
        descriptions.
      </Note>
    </>
  );
}
