// The prompt scratchpad drawer (CONTRACT.md "Prompt scratchpad"): between the
// tab rail and the terminal area, a header with the draft's project, Drafts,
// "@", Clear, Paste and Send, a CodeMirror editor, and a height handle on the
// bottom edge. Not rendered while closed, so the terminal column is unchanged.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useAtomValue } from "jotai";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { ChevronDown, NotebookPen } from "lucide-react";
import { scratch, type ScratchDraft } from "../lib/ipc";
import { CodeEditor } from "../panels/shared/CodeEditor";
import { basename, tildify } from "../panels/shared/paths";
import { relativeTime } from "../panels/shared/format";
import { accentVar } from "./accents";
import { activeAccentAtom } from "./accentState";
import { prefsAtom, setPrefs } from "./prefs";
import { clampScratchHeight, droppedPaths, SCRATCH_DEFAULT } from "./scratch";
import {
  activeProject,
  clearConfirmAtom,
  clearDraft,
  focusActiveTerminal,
  insertRefs,
  insertRefsAt,
  onEditorChange,
  pickDraft,
  registerScratchEditor,
  requestClear,
  scratchKeyAtom,
  scratchOpenAtom,
  scratchTextAtom,
  sendBlockerAtom,
  sendDraft,
} from "./scratchState";
import { draggedTabAtom } from "./split";
import { getPaths, store, toastError } from "./store";
import { Button } from "./ui";

/** Height handle in px (the hit area; a 1 px line is drawn in it). */
const HANDLE = 6;

const PLACEHOLDER = "Compose a prompt. Ctrl+Enter sends, Ctrl+Shift+Enter pastes without submitting, drop files for @references.";

const KEYS: KeyBinding[] = [
  { key: "Mod-Enter", run: () => (sendDraft("submit"), true) },
  { key: "Mod-Shift-Enter", run: () => (sendDraft("paste"), true) },
  { key: "Mod-l", run: () => (requestClear(), true) },
  {
    key: "Escape",
    run: (view) => {
      // The search panel closes first, as without this binding.
      if (view.dom.querySelector(".cm-search")) return false;
      if (store.get(clearConfirmAtom)) store.set(clearConfirmAtom, false);
      else focusActiveTerminal();
      return true;
    },
  },
];

/** A Projects row (text/plain = its path) dropped on the editor becomes an @reference; a dragged rail tab is ignored. */
const DROP = EditorView.domEventHandlers({
  drop(e) {
    if (store.get(draggedTabAtom)) {
      e.preventDefault();
      return true;
    }
    const paths = droppedPaths(e.dataTransfer?.getData("text/plain") ?? "");
    if (!paths) return false;
    e.preventDefault();
    insertRefsAt(paths, e.clientX, e.clientY);
    return true;
  },
});

export function Scratchpad() {
  const open = useAtomValue(scratchOpenAtom);
  return open ? <Drawer /> : null;
}

function Drawer() {
  const box = useRef<HTMLDivElement>(null);
  const editorBox = useRef<HTMLDivElement>(null);
  const wanted = useAtomValue(prefsAtom).scratchHeight;
  const accent = useAtomValue(activeAccentAtom);
  const draft = useAtomValue(scratchKeyAtom);
  const text = useAtomValue(scratchTextAtom);
  const blocker = useAtomValue(sendBlockerAtom);
  const confirm = useAtomValue(clearConfirmAtom);
  const [column, setColumn] = useState(0);
  const [osOver, setOsOver] = useState(false);
  const [home, setHome] = useState<string>();

  useEffect(() => {
    getPaths().then((p) => setHome(p.home), () => {});
  }, []);

  // The terminal column's height, for the 60 % cap.
  useEffect(() => {
    const col = box.current?.parentElement;
    if (!col) return;
    setColumn(col.clientHeight);
    const ro = new ResizeObserver(() => setColumn(col.clientHeight));
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  // Files dropped from the OS (Tauri's drag-drop events, physical pixels) onto the editor.
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | null = null;
    const inside = (pos: { x: number; y: number }) => {
      const r = editorBox.current?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? { x, y } : null;
    };
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "leave") setOsOver(false);
        else if (p.type === "drop") {
          setOsOver(false);
          const at = inside(p.position);
          if (at && p.paths.length > 0) insertRefsAt(p.paths, at.x, at.y);
        } else setOsOver(!!inside(p.position));
      })
      .then((u) => {
        if (live) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  const height = clampScratchHeight(wanted, column);
  const project = draft?.project ?? null;
  const empty = !text.trim();
  const sendTitle = (what: string, keys: string) => blocker ?? (empty ? "The draft is empty" : `${what} (${keys})`);

  const pickFiles = async () => {
    try {
      const picked = await openDialog({ multiple: true, directory: false, defaultPath: activeProject() ?? home, title: "Insert @references" });
      if (!picked) return;
      insertRefs(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      toastError(e, "Could not open the file picker");
    }
  };

  return (
    <div
      ref={box}
      data-scratchpad
      className="relative flex shrink-0 flex-col bg-bg"
      // Under the rail, the drawer takes the rail's bottom edge (the active tab's accent).
      style={{ height, borderTop: `2px solid ${accent ? accentVar(accent.accent) : "var(--border)"}` }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-bg-raised pr-1 pl-2">
        <NotebookPen size={13} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 text-xs font-medium text-fg">Scratchpad</span>
        {project && (
          <span data-scratch-project className="min-w-0 truncate text-xs text-fg-muted" title={project}>
            {basename(project)}
          </span>
        )}
        <div className="flex-1" />
        <DraftsMenu current={draft?.key ?? null} home={home} />
        <Button size="sm" title="Insert @references from a file picker" onClick={() => void pickFiles()} data-scratch-at>
          @
        </Button>
        <Button size="sm" title="Clear the draft (Ctrl+L)" onClick={requestClear} disabled={!text} data-scratch-clear>
          Clear
        </Button>
        <Button size="sm" title={sendTitle("Paste without submitting", "Ctrl+Shift+Enter")} disabled={!!blocker || empty} onClick={() => sendDraft("paste")} data-scratch-paste>
          Paste
        </Button>
        <Button size="sm" variant="primary" title={sendTitle("Send and submit", "Ctrl+Enter")} disabled={!!blocker || empty} onClick={() => sendDraft("submit")} data-scratch-send>
          Send
        </Button>
      </div>
      {confirm && (
        <div data-scratch-confirm className="flex shrink-0 items-center gap-2 border-b border-danger bg-bg-raised px-3 py-1">
          <span className="flex-1 text-xs text-fg">Clear the draft? {text.length} characters.</span>
          <Button size="sm" onClick={() => store.set(clearConfirmAtom, false)}>
            Keep
          </Button>
          <Button size="sm" variant="danger" onClick={clearDraft}>
            Clear
          </Button>
        </div>
      )}
      <div ref={editorBox} data-scratch-editor data-drop-over={osOver ? "" : undefined} className={`min-h-0 flex-1 ${osOver ? "outline-2 -outline-offset-2 outline-accent" : ""}`}>
        <CodeEditor
          value={store.get(scratchTextAtom)}
          lang="markdown"
          wrap
          onChange={onEditorChange}
          onView={registerScratchEditor}
          keys={KEYS}
          placeholder={PLACEHOLDER}
          extensions={DROP}
        />
      </div>
      <HeightHandle box={box} />
    </div>
  );
}

/** The drawer's bottom edge: drag to resize (window pointer listeners, as the split divider), double click resets. */
function HeightHandle({ box }: { box: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the scratchpad"
      title="Drag to resize, double click to reset"
      data-scratch-handle
      className="group flex shrink-0 cursor-row-resize items-center bg-bg"
      style={{ height: HANDLE }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !box.current) return;
        e.preventDefault(); // no text selection while dragging
        const el = e.currentTarget;
        const id = e.pointerId;
        const top = box.current.getBoundingClientRect().top;
        const column = box.current.parentElement?.clientHeight ?? 0;
        try {
          el.setPointerCapture(id);
        } catch {
          // The window listeners below follow the pointer anyway.
        }
        const move = (ev: PointerEvent) => {
          if (ev.pointerId === id) setPrefs({ scratchHeight: clampScratchHeight(ev.clientY - top, column) });
        };
        const up = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
          window.removeEventListener("pointercancel", up, true);
          if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
      }}
      onDoubleClick={() => setPrefs({ scratchHeight: SCRATCH_DEFAULT })}
    >
      <div className="h-px w-full bg-border group-hover:bg-accent" />
    </div>
  );
}

/** Saved drafts from scratch_list, newest first; picking one edits it until the next tab change. */
function DraftsMenu({ current, home }: { current: string | null; home: string | undefined }) {
  const [list, setList] = useState<ScratchDraft[] | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    let live = true;
    scratch
      .list()
      .then((l) => live && setList(l))
      .catch((e) => {
        if (live) setList([]);
        toastError(e, "Could not list the drafts");
      });
    const close = () => setOpenMenu(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node | null)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      live = false;
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [openMenu]);

  const now = Date.now();
  return (
    <div ref={wrap} className="relative">
      <Button size="sm" title="Recent drafts" aria-expanded={openMenu} onClick={() => setOpenMenu((o) => !o)} data-scratch-drafts>
        Drafts
        <ChevronDown size={12} strokeWidth={2} />
      </Button>
      {openMenu && (
        <div role="menu" data-scratch-menu className="absolute top-full right-0 z-50 mt-1 flex max-h-72 w-72 flex-col overflow-y-auto rounded-ui border border-border bg-bg-raised py-1 shadow-lg shadow-black/30">
          {list === null ? (
            <div className="px-3 py-1 text-xs text-fg-muted">Loading...</div>
          ) : list.length === 0 ? (
            <div className="px-3 py-1 text-xs text-fg-muted">No saved drafts</div>
          ) : (
            list.map((d) => (
              <button
                key={d.key}
                type="button"
                role="menuitem"
                data-scratch-draft={d.key}
                title={d.project ?? d.key}
                onClick={() => {
                  setOpenMenu(false);
                  pickDraft(d.key, d.project);
                }}
                className={`flex cursor-pointer flex-col px-3 py-1 text-left hover:bg-bg-hover ${d.key === current ? "bg-bg-hover" : ""}`}
              >
                <span className="truncate text-xs text-fg">{d.project ? basename(d.project) : d.key}</span>
                <span className="truncate text-[11px] text-fg-muted">
                  {d.project ? tildify(d.project, home) : "folder not found"} - {relativeTime(d.modifiedMs, now)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
