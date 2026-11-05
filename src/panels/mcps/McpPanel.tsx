import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { Braces, ChevronDown, ChevronRight, Eye, EyeOff, FileText, HeartPulse, Plus, Trash } from "lucide-react";
import { mcp, type McpExtras, type McpServer } from "../../lib/ipc";
import { Badge, Button, Field, IconButton, Select, TextArea, TextInput, cx } from "../ui";
import { CodeEditor } from "../shared/CodeEditor";
import { useOpenEditor } from "../shared/EditorSheet";
import { errText, useLoad, usePaths, useToast } from "../shared/hooks";
import { ConfirmBar, EmptyState, Note, Panel, Row, SectionHeader } from "../shared/list";
import { basename, joinPath, tildify } from "../shared/paths";
import { ScopeSwitch, useScope } from "../shared/ScopeSwitch";
import { refreshProject } from "../../app/project";
import { checkAll, checkingAtom, connectorTarget, healthKey, pluginTarget } from "./health";
import { CheckButton, CheckingBadge, HealthDetail, HealthDot } from "./HealthBits";
import { configFromForm, emptyForm, formFromConfig, shortVersion, summaryOf, targetOf, transportOf, type McpForm } from "./model";

/** Same key as the health results (health.ts healthKey). */
const keyOf = healthKey;

const MASK = "••••••";
const SECRET_KEYS = ["headers", "env"] as const;

/** Display copy of a raw config with every value under headers and env masked. */
function maskedRaw(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "// This JSON does not parse. Show values to view and fix it.";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return JSON.stringify(parsed, null, 2);
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const k of SECRET_KEYS) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.keys(v).map((name) => [name, MASK]));
    } else if (v !== undefined) {
      out[k] = MASK;
    }
  }
  return JSON.stringify(out, null, 2);
}

export function McpPanel() {
  const paths = usePaths();
  const { scope, choice, setScope, project } = useScope();
  const projectRoot = scope === "project" ? (project?.root ?? null) : null;
  const servers = useLoad(
    useCallback(() => mcp.list(projectRoot ?? undefined), [projectRoot]),
    [projectRoot],
  );
  const extras = useLoad(
    useCallback(() => mcp.extras(), []),
    [],
  );
  const [editing, setEditing] = useState<string | null>(null); // key, or "new"
  const anyChecking = Object.keys(useAtomValue(checkingAtom)).length > 0;

  const fileServers = useMemo(
    () => (projectRoot ? (servers.data ?? []).filter((s) => s.scope === "projectFile").sort((a, b) => a.name.localeCompare(b.name)) : []),
    [servers.data, projectRoot],
  );
  const claudeJsonForRoot = useMemo(
    () => (projectRoot ? (servers.data ?? []).filter((s) => s.scope === "project" && s.project === projectRoot).length : 0),
    [servers.data, projectRoot],
  );

  const groups = useMemo(() => {
    const list = servers.data ?? [];
    const user = list.filter((s) => s.scope === "user").sort((a, b) => a.name.localeCompare(b.name));
    const byProject = new Map<string, McpServer[]>();
    for (const s of list.filter((x) => x.scope === "project")) {
      const p = s.project ?? "";
      byProject.set(p, [...(byProject.get(p) ?? []), s]);
    }
    const projects = [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, xs]) => ({ title: p, servers: xs.sort((a, b) => a.name.localeCompare(b.name)) }));
    return [{ title: "User", servers: user, project: undefined as string | undefined }, ...projects.map((g) => ({ ...g, project: g.title }))];
  }, [servers.data]);

  const projectPaths = useMemo(() => [...new Set((servers.data ?? []).map((s) => s.project).filter((p): p is string => !!p))], [servers.data]);

  const done = () => {
    setEditing(null);
    void servers.reload();
    if (projectRoot) void refreshProject();
  };

  const mcpJsonShown = projectRoot ? tildify(joinPath(projectRoot, ".mcp.json"), paths?.home) : "";
  const fixed = projectRoot ? { root: projectRoot, shown: mcpJsonShown } : undefined;

  return (
    <Panel
      title="MCP servers"
      loading={servers.loading || extras.loading}
      onRefresh={() => {
        void servers.reload();
        void extras.reload();
      }}
      actions={
        <>
          <IconButton icon={HeartPulse} title={anyChecking ? "Checking MCP servers" : "Check all servers"} disabled={anyChecking} onClick={() => void checkAll()} />
          <IconButton icon={Plus} title="Add server" onClick={() => setEditing("new")} />
        </>
      }
    >
      <ScopeSwitch
        value={choice}
        project={project}
        onChange={(s) => {
          setScope(s);
          setEditing(null);
        }}
      />
      {projectRoot ? (
        <>
          {editing === "new" && <McpEditor key="new" fixed={fixed} projectPaths={[]} onDone={done} onCancel={() => setEditing(null)} />}
          {servers.data && fileServers.length === 0 && editing !== "new" && (
            <EmptyState title="No project servers">
              <span className="font-mono">{mcpJsonShown}</span> {project?.exists.mcpJson ? "has no servers yet." : "does not exist yet."} Use + to add one; it is created on first save.
            </EmptyState>
          )}
          {fileServers.length > 0 && <SectionHeader title=".mcp.json" count={fileServers.length} />}
          {fileServers.map((s) => {
            const k = keyOf(s);
            const open = editing === k;
            return (
              <div key={k}>
                <Row
                  lead={<HealthDot k={k} />}
                  title={s.name}
                  badge={
                    <>
                      <Badge tone={transportOf(s.config) === "stdio" ? "muted" : "accent"}>{transportOf(s.config)}</Badge>
                      <CheckingBadge k={k} />
                    </>
                  }
                  subtitle={<span className="font-mono">{summaryOf(s.config)}</span>}
                  tooltip={summaryOf(s.config)}
                  active={open}
                  onClick={() => setEditing(open ? null : k)}
                  actions={<CheckButton target={s} />}
                />
                <HealthDetail k={k} />
                {open && <McpEditor server={s} fixed={fixed} projectPaths={[]} onDone={done} onCancel={() => setEditing(null)} />}
              </div>
            );
          })}
          <Note className="pt-3">
            Servers shared through the repo's .mcp.json. Claude Code asks before it starts them the first time.
            {claudeJsonForRoot > 0
              ? ` ${claudeJsonForRoot} more for this path ${claudeJsonForRoot === 1 ? "is" : "are"} stored in ~/.claude.json and listed under User > ${basename(projectRoot) || projectRoot}.`
              : " Entries for this path in ~/.claude.json, if any, are listed under User > " + (basename(projectRoot) || projectRoot) + "."}
          </Note>
          <ExtrasGroups data={extras.data} home={paths?.home} />
          <div className="h-3" />
        </>
      ) : (
        <>
          {editing === "new" && <McpEditor key="new" projectPaths={projectPaths} onDone={done} onCancel={() => setEditing(null)} />}
          {servers.data && servers.data.length === 0 && editing !== "new" && (
            <EmptyState title="No MCP servers">Servers from ~/.claude.json show here, user scope first, then per project. Use + to add one.</EmptyState>
          )}
          {groups.map((g) =>
            g.servers.length === 0 ? null : (
              <div key={g.title}>
                <SectionHeader title={g.project ? basename(g.project) || g.project : "User"} count={g.servers.length} />
                {g.project && (
                  <div className="truncate px-3 pb-1 font-mono text-[11px] text-fg-muted" title={g.project}>
                    {tildify(g.project, paths?.home)}
                  </div>
                )}
                {g.servers.map((s) => {
                  const k = keyOf(s);
                  const open = editing === k;
                  return (
                    <div key={k}>
                      <Row
                        lead={<HealthDot k={k} />}
                        title={s.name}
                        badge={
                          <>
                            <Badge tone={transportOf(s.config) === "stdio" ? "muted" : "accent"}>{transportOf(s.config)}</Badge>
                            <CheckingBadge k={k} />
                          </>
                        }
                        subtitle={<span className="font-mono">{summaryOf(s.config)}</span>}
                        tooltip={summaryOf(s.config)}
                        active={open}
                        onClick={() => setEditing(open ? null : k)}
                        actions={<CheckButton target={s} />}
                      />
                      <HealthDetail k={k} />
                      {open && <McpEditor server={s} projectPaths={projectPaths} onDone={done} onCancel={() => setEditing(null)} />}
                    </div>
                  );
                })}
              </div>
            ),
          )}
          <Note className="pt-3">
            Reads and writes the mcpServers blocks of ~/.claude.json. Servers in a repo's .mcp.json are under the Project scope. A backup is kept at
            ~/.claude.json.kansei-bak.
          </Note>
          <ExtrasGroups data={extras.data} home={paths?.home} />
          <div className="h-3" />
        </>
      )}
    </Panel>
  );
}

/** Section header that folds its group. Same look as SectionHeader plus a chevron. */
function FoldHeader({ title, count, open, onToggle }: { title: string; count: number; open: boolean; onToggle: () => void }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 bg-bg px-3 pt-3 pb-1 text-left text-fg-muted hover:text-fg"
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide">{title}</span>
      <span className="text-[11px] tabular-nums">{count}</span>
    </button>
  );
}

function MutedLine({ children }: { children: ReactNode }) {
  return <div className="px-3 py-1 text-[11px] text-fg-muted">{children}</div>;
}

/**
 * Read-only groups below the editable servers: plugin servers, claude.ai
 * connectors and built-ins (mcp_extras). No edit or delete; plugin rows can
 * open their .mcp.json read-only.
 */
function ExtrasGroups({ data, home }: { data: McpExtras | null; home: string | undefined }) {
  const openEditor = useOpenEditor();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const flip = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  if (!data) return null;
  const muted = (t: string) => <span className="text-fg-muted">{t}</span>;
  return (
    <div data-mcp-extras>
      <FoldHeader title="Plugins" count={data.plugins.length} open={!closed.plugins} onToggle={() => flip("plugins")} />
      {!closed.plugins && (
        <>
          {data.plugins.length === 0 && <MutedLine>No installed plugin ships MCP servers.</MutedLine>}
          {data.plugins.map((p) => {
            const note = typeof p.config.note === "string" ? p.config.note : "";
            const target = targetOf(p.config);
            const version = shortVersion(p.version);
            const probe = pluginTarget(p);
            const hk = healthKey(probe);
            return (
              <div key={`${p.file}|${p.name}`}>
                <Row
                  lead={<HealthDot k={hk} />}
                  title={muted(p.name)}
                  badge={
                    <>
                      <Badge tone="muted">{transportOf(p.config)}</Badge>
                      <CheckingBadge k={hk} />
                    </>
                  }
                  subtitle={note || <span className="font-mono">{target}</span>}
                  clamp={note ? 2 : 1}
                  tooltip={[summaryOf(p.config), note, `Plugin ${p.plugin}${p.marketplace ? `@${p.marketplace}` : ""}${p.version ? ` ${p.version}` : ""}`].filter(Boolean).join("\n")}
                  extra={
                    <>
                      <Badge title={tildify(p.file, home)}>{version ? `${p.plugin} ${version}` : p.plugin}</Badge>
                      {note && target && <Badge className="font-mono">{target}</Badge>}
                      {p.enabled === false && <Badge tone="warn">disabled</Badge>}
                      {p.needsAuth && <Badge tone="warn">needs auth</Badge>}
                      {p.scope && p.scope !== "user" && <Badge title={p.projectPath ?? undefined}>{p.scope}</Badge>}
                    </>
                  }
                  actions={
                    <>
                      <CheckButton target={probe} />
                      <IconButton
                        icon={FileText}
                        title={`Open ${tildify(p.file, home)} (read only)`}
                        onClick={() => openEditor({ path: p.file, title: `${p.plugin} .mcp.json`, readOnly: true, note: "Installed by the plugin. Claude Code manages this file; Kansei only shows it." })}
                      />
                    </>
                  }
                />
                <HealthDetail k={hk} />
              </div>
            );
          })}
        </>
      )}
      <FoldHeader title="claude.ai connectors" count={data.connectors.length} open={!closed.connectors} onToggle={() => flip("connectors")} />
      {!closed.connectors && (
        <>
          {data.connectors.length === 0 && <MutedLine>None recorded</MutedLine>}
          {data.connectors.map((c) => (
            <Row
              key={c.name}
              lead={<HealthDot k={healthKey(connectorTarget(c))} />}
              title={muted(c.name)}
              subtitle="Managed at claude.ai, not editable here"
              extra={c.needsAuth ? <Badge tone="warn">needs auth</Badge> : undefined}
            />
          ))}
        </>
      )}
      <FoldHeader title="Built-in" count={data.builtins.length} open={!closed.builtins} onToggle={() => flip("builtins")} />
      {!closed.builtins && (
        <>
          {data.builtins.length === 0 && <MutedLine>None enabled</MutedLine>}
          {data.builtins.map((b) => (
            <Row key={b.name} title={muted(b.name)} subtitle={b.note} />
          ))}
        </>
      )}
      <Note className="pt-2">Read only. Plugins come from ~/.claude/plugins, connectors and built-ins from ~/.claude.json.</Note>
    </div>
  );
}

function McpEditor({
  server,
  fixed,
  projectPaths,
  onDone,
  onCancel,
}: {
  server?: McpServer;
  /** Project scope: always saves to <root>/.mcp.json (scope projectFile). */
  fixed?: { root: string; shown: string };
  projectPaths: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const original = server?.config ?? {};
  const [form, setForm] = useState<McpForm>(() =>
    server
      ? formFromConfig(server.name, server.scope, server.project ?? "", server.config)
      : fixed
        ? { ...emptyForm(), scope: "projectFile", project: fixed.root }
        : emptyForm(),
  );
  const [extra, setExtra] = useState<Record<string, unknown>>(original);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof McpForm>(k: K, v: McpForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const masked = reveal ? undefined : ({ WebkitTextSecurity: "disc" } as CSSProperties);

  const toggleRaw = () => {
    if (raw === null) {
      const built = configFromForm(form, extra);
      setRaw(JSON.stringify(built.error ? extra : built.config, null, 2));
      setRawKey((n) => n + 1);
      setError(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config must be a JSON object");
      const obj = parsed as Record<string, unknown>;
      setForm((f) => ({ ...formFromConfig(f.name, f.scope, f.project, obj) }));
      setExtra(obj);
      setRaw(null);
      setError(null);
    } catch (e) {
      setError(`Raw JSON: ${errText(e)}`);
    }
  };

  const save = async () => {
    let config: Record<string, unknown>;
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config must be a JSON object");
        config = parsed as Record<string, unknown>;
      } catch (e) {
        setError(`Raw JSON: ${errText(e)}`);
        return;
      }
    } else {
      const built = configFromForm(form, extra);
      if (built.error) {
        setError(built.error);
        return;
      }
      config = built.config;
    }
    const name = form.name.trim();
    if (!name) return setError("Name is required");
    if (name !== server?.name && !/^[A-Za-z0-9_.-]+$/.test(name)) return setError("Name may use letters, digits, dot, dash and underscore");
    if (form.scope !== "user" && !form.project.trim()) return setError("Project path is required for project scope");
    const project = form.scope !== "user" ? form.project.trim() : undefined;
    setError(null);
    setBusy(true);
    try {
      await mcp.upsert({ scope: form.scope, project, name, config });
      if (server && keyOf(server) !== keyOf({ scope: form.scope, project, name })) {
        await mcp.remove({ scope: server.scope, project: server.project, name: server.name });
      }
      toast.info(`Saved MCP server ${name}`);
      onDone();
    } catch (e) {
      toast.error(e, "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!server) return;
    setBusy(true);
    try {
      await mcp.remove({ scope: server.scope, project: server.project, name: server.name });
      toast.info(`Removed MCP server ${server.name}`);
      onDone();
    } catch (e) {
      toast.error(e, "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mx-2 mb-2 flex flex-col gap-2 rounded-ui border border-border bg-bg-raised p-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && raw === null) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{server ? "Edit server" : "New server"}</span>
        <Button variant={raw !== null ? "primary" : "ghost"} icon={Braces} onClick={toggleRaw} title="Edit this server's config as JSON">
          Raw JSON
        </Button>
      </div>

      <Field label="Name">
        <TextInput value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="my-server" autoFocus={!server} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {fixed ? (
          <Field label="Saved to">
            <span className="truncate py-1 font-mono text-xs text-fg-muted" title={fixed.root + "/.mcp.json"}>
              {fixed.shown}
            </span>
          </Field>
        ) : (
          <Field label="Scope">
            <Select value={form.scope} onChange={(e) => set("scope", e.target.value as McpForm["scope"])}>
              <option value="user">user</option>
              <option value="project">project</option>
            </Select>
          </Field>
        )}
        {raw === null && (
          <Field label="Type">
            <Select value={form.type} onChange={(e) => set("type", e.target.value as McpForm["type"])}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </Select>
          </Field>
        )}
      </div>
      {form.scope === "project" && (
        <Field label="Project path">
          <TextInput value={form.project} onChange={(e) => set("project", e.target.value)} placeholder="/home/you/Develop/repo" list="kansei-mcp-projects" title={form.project} />
          <datalist id="kansei-mcp-projects">
            {projectPaths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
      )}

      {raw !== null ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center">
            <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Config</span>
            <IconButton icon={reveal ? EyeOff : Eye} title={reveal ? "Hide values" : "Show values"} onClick={() => setReveal(!reveal)} className="h-5 w-5" />
          </div>
          <div className="h-56 overflow-hidden rounded-ui border border-border">
            {reveal ? (
              <CodeEditor key={`${rawKey}-edit`} value={raw} lang="json" onChange={setRaw} />
            ) : (
              <CodeEditor key={`${rawKey}-masked`} value={maskedRaw(raw)} lang="json" readOnly />
            )}
          </div>
          {!reveal && <span className="text-[11px] text-fg-muted">Header and env values are hidden. Show values to edit the JSON.</span>}
        </div>
      ) : form.type === "stdio" ? (
        <>
          <Field label="Command">
            <TextInput className="font-mono" value={form.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" />
          </Field>
          <Field label="Args" hint="One per line">
            <TextArea rows={3} value={form.args} onChange={(e) => set("args", e.target.value)} placeholder={"-y\n@scope/server"} />
          </Field>
          <SecretField label="Env" hint="KEY=VALUE, one per line" value={form.env} onChange={(v) => set("env", v)} reveal={reveal} setReveal={setReveal} style={masked} />
        </>
      ) : (
        <>
          <Field label="URL">
            <TextInput className="font-mono" value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/mcp" />
          </Field>
          <SecretField
            label="Headers"
            hint="Name: value, one per line"
            value={form.headers}
            onChange={(v) => set("headers", v)}
            reveal={reveal}
            setReveal={setReveal}
            style={masked}
          />
        </>
      )}

      {error && <div className="text-[11px] text-danger">{error}</div>}

      {confirmRemove ? (
        <ConfirmBar
          text={
            <>
              Remove <span className="font-mono">{server?.name}</span> from {server?.scope === "projectFile" ? ".mcp.json" : "~/.claude.json"}?
            </>
          }
          confirmLabel="Remove"
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          {server && (
            <Button variant="ghost" icon={Trash} className="hover:text-danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function SecretField({
  label,
  hint,
  value,
  onChange,
  reveal,
  setReveal,
  style,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  reveal: boolean;
  setReveal: (v: boolean) => void;
  style?: CSSProperties;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">{label}</span>
        <IconButton icon={reveal ? EyeOff : Eye} title={reveal ? "Hide values" : "Show values"} onClick={() => setReveal(!reveal)} className="h-5 w-5" />
      </div>
      <TextArea rows={3} value={value} onChange={(e) => onChange(e.target.value)} style={style} className={cx(!reveal && "tracking-wider")} />
      <span className="text-[11px] text-fg-muted">{hint}</span>
    </div>
  );
}
