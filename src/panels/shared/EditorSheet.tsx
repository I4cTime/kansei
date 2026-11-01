// Editor sheet rendered through the overlay host. Ctrl+S saves, Esc (handled by
// the shell via overlay.onEscape) closes, asking first when there are unsaved changes.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { Save, X } from "lucide-react";
import { files } from "../../lib/ipc";
import { overlayAtom, pushToastAtom } from "../../lib/overlay";
import { Badge, Button, IconButton } from "../ui";
import { CodeEditor, langForPath, type Lang } from "./CodeEditor";
import { errText, getPaths } from "./hooks";
import { basename, tildify } from "./paths";

export type OpenEditorOptions = {
  path: string;
  title?: string;
  /** Initial content when the file does not exist yet. Without it a missing file is an error. */
  create?: string;
  /** Override the language picked from the extension. */
  lang?: Lang;
  /** Called after a successful save with the saved content. */
  onSaved?: (content: string) => void;
  /** Short muted note shown under the header (reminders, warnings). */
  note?: ReactNode;
  /** View only: no Save button, Ctrl+S does nothing, the text cannot change. */
  readOnly?: boolean;
};

type Ctl = { escape: () => boolean; dirty: () => boolean };
let active: Ctl | null = null;
let seq = 0;

/** Returns `openEditor(opts)`. A hook so it uses whichever jotai store the shell provides. */
export function useOpenEditor(): (o: OpenEditorOptions) => void {
  const store = useStore();
  return useCallback(
    (o: OpenEditorOptions) => {
      if (active?.dirty()) {
        store.set(pushToastAtom, { kind: "error", text: "Save or discard the open editor first" });
        return;
      }
      const ctl: Ctl = { escape: () => true, dirty: () => false };
      const close = () => {
        if (active === ctl) active = null;
        if (store.get(overlayAtom)?.node === node) store.set(overlayAtom, null);
      };
      const node = <EditorSheet key={`ed-${++seq}`} opts={o} ctl={ctl} close={close} />;
      active = ctl;
      store.set(overlayAtom, {
        node,
        onEscape: () => {
          const ok = ctl.escape();
          if (ok && active === ctl) active = null;
          return ok;
        },
      });
    },
    [store],
  );
}

/**
 * Like useOpenEditor, but also returns the path of the file this panel opened
 * while its sheet is still showing, so the panel can highlight that row.
 */
export function useOpenEditorTracked(): { openEditor: (o: OpenEditorOptions) => void; openPath: string | null } {
  const store = useStore();
  const openEditor = useOpenEditor();
  const overlay = useAtomValue(overlayAtom);
  const [opened, setOpened] = useState<{ path: string; overlay: unknown } | null>(null);
  const tracked = useCallback(
    (o: OpenEditorOptions) => {
      const before = store.get(overlayAtom);
      openEditor(o);
      const after = store.get(overlayAtom);
      // openEditor refuses while another sheet has unsaved changes; only track a real open.
      if (after && after !== before) setOpened({ path: o.path, overlay: after });
    },
    [store, openEditor],
  );
  const openPath = opened && overlay === opened.overlay ? opened.path : null;
  return { openEditor: tracked, openPath };
}

function EditorSheet({ opts, ctl, close }: { opts: OpenEditorOptions; ctl: Ctl; close: () => void }) {
  const push = useSetAtom(pushToastAtom);
  const [home, setHome] = useState<string>();
  const [initial, setInitial] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [text, setText] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const lang = opts.lang ?? langForPath(opts.path);
  const dirty = !opts.readOnly && initial !== null && (isNew || text !== baseline);

  useEffect(() => {
    getPaths().then((p) => setHome(p.home), () => {});
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const exists = await files.exists(opts.path);
        let content: string;
        if (exists) content = await files.readText(opts.path);
        else if (opts.create !== undefined) content = opts.create;
        else throw new Error("File does not exist");
        if (!live) return;
        setIsNew(!exists);
        setInitial(content);
        setBaseline(exists ? content : "");
        setText(content);
      } catch (e) {
        if (live) setLoadError(errText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [opts.path, opts.create]);

  const doSave = useCallback(
    async (force = false) => {
      if (saving || opts.readOnly) return;
      if (lang === "json" && !force) {
        try {
          JSON.parse(text);
        } catch (e) {
          setJsonError(errText(e));
          return;
        }
      }
      setJsonError(null);
      setSaving(true);
      try {
        await files.writeText(opts.path, text);
        setBaseline(text);
        setIsNew(false);
        setConfirmDiscard(false);
        push({ kind: "info", text: `Saved ${basename(opts.path)}` });
        opts.onSaved?.(text);
      } catch (e) {
        push({ kind: "error", text: `Save failed: ${errText(e)}` });
      } finally {
        setSaving(false);
      }
    },
    [saving, lang, text, opts, push],
  );

  // Keep the controller in sync with the latest state for the shell's Esc handling.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const confirmRef = useRef(confirmDiscard);
  confirmRef.current = confirmDiscard;
  ctl.dirty = () => dirtyRef.current;
  ctl.escape = () => {
    if (confirmRef.current) {
      setConfirmDiscard(false);
      return false;
    }
    if (dirtyRef.current) {
      setConfirmDiscard(true);
      return false;
    }
    return true;
  };

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else close();
  };

  // Ctrl+S at window level (capture) so the terminal underneath cannot swallow it.
  const saveRef = useRef(doSave);
  saveRef.current = doSave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const shown = tildify(opts.path, home);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-ui border border-border bg-bg shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border bg-bg-raised px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{opts.title ?? basename(opts.path)}</span>
            {isNew && <Badge tone="accent">new file</Badge>}
            {opts.readOnly && <Badge>read only</Badge>}
            {dirty && !isNew && <Badge tone="warn">unsaved</Badge>}
          </div>
          <div className="truncate font-mono text-[11px] text-fg-muted" title={opts.path}>
            {shown}
          </div>
        </div>
        {!opts.readOnly && (
          <Button variant="primary" icon={Save} onClick={() => void doSave()} disabled={!dirty || saving || initial === null} title="Save (Ctrl+S)">
            Save
          </Button>
        )}
        <IconButton icon={X} title="Close (Esc)" onClick={requestClose} />
      </div>

      {opts.note && <div className="border-b border-border bg-bg-raised px-3 py-1.5 text-[11px] text-fg-muted">{opts.note}</div>}

      {confirmDiscard && (
        <div className="flex flex-wrap items-center gap-2 border-b border-danger bg-bg-raised px-3 py-1.5">
          <span className="flex-1 text-xs text-fg">Discard changes?</span>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={close}>
            Discard
          </Button>
        </div>
      )}

      {jsonError && (
        <div className="flex flex-wrap items-center gap-2 border-b border-danger bg-bg-raised px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-danger" title={jsonError}>
            Invalid JSON: {jsonError}
          </span>
          <Button variant="ghost" onClick={() => setJsonError(null)}>
            Fix it
          </Button>
          <Button variant="danger" onClick={() => void doSave(true)}>
            Save anyway
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {loadError ? (
          <div className="p-4 text-xs text-danger">Could not open {shown}: {loadError}</div>
        ) : initial === null ? (
          <div className="p-4 text-xs text-fg-muted">Loading...</div>
        ) : (
          <CodeEditor value={initial} lang={lang} wrap={lang === "markdown"} onChange={setText} readOnly={opts.readOnly} autoFocus />
        )}
      </div>
    </div>
  );
}
