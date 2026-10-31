import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Plus, Trash, Undo2 } from "lucide-react";
import { Badge, Button, IconButton, TextArea, TextInput, cx } from "../ui";
import { useOpenEditor } from "../shared/EditorSheet";
import { getPaths, readJsonObject, useLoad, useToast, writeJson } from "../shared/hooks";
import { ConfirmBar, Note, Panel } from "../shared/list";
import { EVENTS, EVENT_INFO, applyHooks, readHooks, sameHooks, type HookEntry, type HooksMap, type MatcherGroup } from "./model";

export function HooksPanel() {
  const toast = useToast();
  const openEditor = useOpenEditor();
  const [draft, setDraft] = useState<HooksMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const loaded = useLoad(
    useCallback(async () => {
      const p = await getPaths();
      const settings = await readJsonObject(p.settings);
      let hooks: HooksMap = {};
      try {
        hooks = readHooks(settings.hooks);
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
      setDraft(structuredClone(hooks));
      setConflict(false);
      setOpen((o) => {
        const next = { ...o };
        for (const k of Object.keys(hooks)) if (next[k] === undefined) next[k] = true;
        return next;
      });
      return { path: p.settings, hooks, rawHooks: JSON.stringify(settings.hooks ?? null) };
    }, []),
    [],
  );

  const dirty = !!draft && !!loaded.data && !sameHooks(draft, loaded.data.hooks);
  const events = useMemo(() => [...EVENTS, ...Object.keys(draft ?? {}).filter((k) => !(EVENTS as readonly string[]).includes(k))], [draft]);

  const update = (event: string, fn: (groups: MatcherGroup[]) => MatcherGroup[]) =>
    setDraft((d) => (d ? { ...d, [event]: fn(d[event] ?? []) } : d));

  const save = async (force = false) => {
    if (!draft || !loaded.data || loadError) return;
    setSaving(true);
    try {
      const fresh = await readJsonObject(loaded.data.path);
      if (!force && JSON.stringify(fresh.hooks ?? null) !== loaded.data.rawHooks) {
        setConflict(true);
        return;
      }
      await writeJson(loaded.data.path, applyHooks(fresh, draft));
      toast.info("Saved hooks to settings.json");
      await loaded.reload();
    } catch (e) {
      toast.error(e, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const openRaw = () => {
    if (!loaded.data) return;
    if (dirty) {
      toast.error("Save or revert the hook changes before editing settings.json raw");
      return;
    }
    openEditor({ path: loaded.data.path, create: "{}\n", onSaved: () => void loaded.reload() });
  };

  return (
    <Panel
      title="Hooks"
      loading={loaded.loading}
      onRefresh={() => {
        if (dirty) toast.error("Unsaved hook changes: save or revert first");
        else void loaded.reload();
      }}
      actions={<IconButton icon={FileText} title="Open settings.json raw" onClick={openRaw} disabled={!loaded.data} />}
    >
      {dirty && !conflict && (
        <div className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-bg-raised px-3 py-1.5">
          <span className="flex-1 text-[11px] text-warn">Unsaved changes</span>
          <Button variant="ghost" icon={Undo2} onClick={() => loaded.data && setDraft(structuredClone(loaded.data.hooks))} disabled={saving}>
            Revert
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            Save
          </Button>
        </div>
      )}
      {conflict && (
        <ConfirmBar
          text="Hooks in settings.json changed on disk since they were loaded. Overwrite them?"
          confirmLabel="Overwrite"
          busy={saving}
          onConfirm={() => {
            setConflict(false);
            void save(true);
          }}
          onCancel={() => setConflict(false)}
        />
      )}
      {loadError && (
        <div className="mx-3 my-2 rounded-ui border border-danger px-2 py-1.5 text-[11px] text-danger">
          {loadError}
        </div>
      )}
      <Note className="pt-2">Command hooks from ~/.claude/settings.json. Each runs a shell command with the event JSON on stdin; timeout is in seconds.</Note>

      {draft &&
        !loadError &&
        events.map((ev) => {
          const groups = draft[ev] ?? [];
          const count = groups.reduce((n, g) => n + g.hooks.length, 0);
          const isOpen = !!open[ev];
          const info = EVENT_INFO[ev];
          const usesMatcher = info ? !!info.matcher : true;
          return (
            <div key={ev} className="border-b border-border last:border-b-0">
              <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-bg-hover">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                  onClick={() => setOpen((o) => ({ ...o, [ev]: !isOpen }))}
                  aria-expanded={isOpen}
                >
                  {isOpen ? <ChevronDown size={13} className="shrink-0 text-fg-muted" /> : <ChevronRight size={13} className="shrink-0 text-fg-muted" />}
                  <span className={cx("truncate font-mono text-xs", count > 0 ? "text-fg" : "text-fg-muted")}>{ev}</span>
                  <span className="flex-1" />
                  {count > 0 && (
                    <span
                      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent"
                      title={`${count} command${count === 1 ? "" : "s"}`}
                      aria-label={`${count} command${count === 1 ? "" : "s"}`}
                    >
                      {count}
                    </span>
                  )}
                </button>
                <IconButton
                  icon={Plus}
                  title={`Add a ${usesMatcher ? "matcher group" : "hook"} to ${ev}`}
                  onClick={() => {
                    update(ev, (gs) => [...gs, { ...(usesMatcher ? { matcher: "" } : {}), hooks: [{ type: "command", command: "" }] }]);
                    setOpen((o) => ({ ...o, [ev]: true }));
                  }}
                />
              </div>
              {isOpen && (
                <div className="flex flex-col gap-2 px-2 pb-2">
                  {info && <div className="px-1 text-[11px] text-fg-muted">{info.about}</div>}
                  {groups.length === 0 && <div className="px-1 text-[11px] text-fg-muted">No hooks. Use + to add one.</div>}
                  {groups.map((g, gi) => (
                    <GroupEditor
                      key={gi}
                      group={g}
                      matcherHint={info?.matcher}
                      showMatcher={usesMatcher || g.matcher !== undefined}
                      onChange={(ng) => update(ev, (gs) => gs.map((x, i) => (i === gi ? ng : x)))}
                      onRemove={() => update(ev, (gs) => gs.filter((_, i) => i !== gi))}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      <div className="h-3" />
    </Panel>
  );
}

function GroupEditor({
  group,
  matcherHint,
  showMatcher,
  onChange,
  onRemove,
}: {
  group: MatcherGroup;
  matcherHint?: string;
  showMatcher: boolean;
  onChange: (g: MatcherGroup) => void;
  onRemove: () => void;
}) {
  const setHook = (i: number, h: HookEntry) => onChange({ ...group, hooks: group.hooks.map((x, j) => (j === i ? h : x)) });
  return (
    <div className="flex flex-col gap-1.5 rounded-ui border border-border bg-bg-raised p-2">
      <div className="flex items-center gap-1">
        {showMatcher ? (
          <TextInput
            className="font-mono"
            value={group.matcher ?? ""}
            onChange={(e) => onChange({ ...group, matcher: e.target.value })}
            placeholder="matcher (empty = all)"
            title={matcherHint}
            aria-label="Matcher"
          />
        ) : (
          <span className="flex-1 text-[11px] text-fg-muted">Runs on every event</span>
        )}
        <IconButton icon={Trash} title="Remove this group" danger onClick={onRemove} />
      </div>
      {group.hooks.map((h, i) =>
        h.type === "command" ? (
          <div key={i} className="flex flex-col gap-1 border-l-2 border-border pl-2">
            <TextArea
              rows={2}
              value={h.command ?? ""}
              onChange={(e) => setHook(i, { ...h, command: e.target.value })}
              placeholder="command, e.g. ~/.claude/hooks/check.sh"
              aria-label="Command"
            />
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-fg-muted">timeout</span>
              <TextInput
                type="number"
                min={1}
                className="w-16"
                value={h.timeout ?? ""}
                placeholder="60"
                onChange={(e) => setHook(i, { ...h, timeout: e.target.value === "" ? undefined : Number(e.target.value) })}
                aria-label="Timeout in seconds"
              />
              <span className="text-[11px] text-fg-muted">s</span>
              <span className="flex-1" />
              <IconButton icon={Trash} title="Remove this command" danger onClick={() => onChange({ ...group, hooks: group.hooks.filter((_, j) => j !== i) })} />
            </div>
          </div>
        ) : (
          <div key={i} className="flex items-center gap-1 border-l-2 border-border pl-2">
            <Badge>{h.type}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted" title={JSON.stringify(h)}>
              {JSON.stringify(h)}
            </span>
            <IconButton icon={Trash} title="Remove this hook" danger onClick={() => onChange({ ...group, hooks: group.hooks.filter((_, j) => j !== i) })} />
          </div>
        ),
      )}
      <Button variant="ghost" icon={Plus} className="self-start" onClick={() => onChange({ ...group, hooks: [...group.hooks, { type: "command", command: "" }] })}>
        Add command
      </Button>
      {group.hooks.some((h) => h.type !== "command") && <div className="text-[11px] text-fg-muted">Non-command hooks are kept as is; edit them raw.</div>}
    </div>
  );
}
