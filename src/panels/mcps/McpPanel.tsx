import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { Braces, Eye, EyeOff, Plus, Trash } from "lucide-react";
import { mcp, type McpServer } from "../../lib/ipc";
import { Badge, Button, Field, IconButton, Select, TextArea, TextInput, cx } from "../ui";
import { CodeEditor } from "../shared/CodeEditor";
import { errText, useLoad, usePaths, useToast } from "../shared/hooks";
import { ConfirmBar, EmptyState, Note, Panel, Row, SectionHeader } from "../shared/list";
import { basename, tildify } from "../shared/paths";
import { configFromForm, emptyForm, formFromConfig, summaryOf, transportOf, type McpForm } from "./model";

const keyOf = (s: { scope: string; project?: string; name: string }) => `${s.scope}|${s.project ?? ""}|${s.name}`;

export function McpPanel() {
  const paths = usePaths();
  const servers = useLoad(useCallback(() => mcp.list(), []), []);
  const [editing, setEditing] = useState<string | null>(null); // key, or "new"

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
  };

  return (
    <Panel
      title="MCP servers"
      loading={servers.loading}
      onRefresh={() => void servers.reload()}
      actions={<IconButton icon={Plus} title="Add server" onClick={() => setEditing("new")} />}
    >
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
                    title={s.name}
                    badge={<Badge tone={transportOf(s.config) === "stdio" ? "muted" : "accent"}>{transportOf(s.config)}</Badge>}
                    subtitle={<span className="font-mono">{summaryOf(s.config)}</span>}
                    tooltip={summaryOf(s.config)}
                    active={open}
                    onClick={() => setEditing(open ? null : k)}
                  />
                  {open && <McpEditor server={s} projectPaths={projectPaths} onDone={done} onCancel={() => setEditing(null)} />}
                </div>
              );
            })}
          </div>
        ),
      )}
      <Note className="pt-3">
        Reads and writes the mcpServers blocks of ~/.claude.json only. Servers declared in a repo's .mcp.json are not listed. A backup is kept at
        ~/.claude.json.tsukue-bak.
      </Note>
      <div className="h-3" />
    </Panel>
  );
}

function McpEditor({ server, projectPaths, onDone, onCancel }: { server?: McpServer; projectPaths: string[]; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const original = server?.config ?? {};
  const [form, setForm] = useState<McpForm>(() =>
    server ? formFromConfig(server.name, server.scope, server.project ?? "", server.config) : emptyForm(),
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
    if (form.scope === "project" && !form.project.trim()) return setError("Project path is required for project scope");
    const project = form.scope === "project" ? form.project.trim() : undefined;
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
        <Field label="Scope">
          <Select value={form.scope} onChange={(e) => set("scope", e.target.value as McpForm["scope"])}>
            <option value="user">user</option>
            <option value="project">project</option>
          </Select>
        </Field>
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
          <TextInput value={form.project} onChange={(e) => set("project", e.target.value)} placeholder="/home/you/Develop/repo" list="tsukue-mcp-projects" title={form.project} />
          <datalist id="tsukue-mcp-projects">
            {projectPaths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
      )}

      {raw !== null ? (
        <div className="h-56 overflow-hidden rounded-ui border border-border">
          <CodeEditor key={rawKey} value={raw} lang="json" onChange={setRaw} />
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
        <ConfirmBar text={<>Remove <span className="font-mono">{server?.name}</span> from ~/.claude.json?</>} confirmLabel="Remove" busy={busy} onConfirm={() => void remove()} onCancel={() => setConfirmRemove(false)} />
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
