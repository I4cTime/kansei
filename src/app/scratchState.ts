// Prompt scratchpad, live state (CONTRACT.md "Prompt scratchpad"): the drawer's
// open state (prefs.scratchOpen), the draft's key and text, the debounced save
// to <appData>/scratch/<key>.md, sending to the active tab's pty and the
// @reference insertion. The pure rules are in scratch.ts, the drawer in
// Scratchpad.tsx.
//
// The editor view registers itself (registerScratchEditor) so the text atom and
// the CodeMirror document stay in step both ways: typing sets the atom, and a
// programmatic change (setText, a draft load, Clear) is dispatched to the view.
import { atom } from "jotai";
import type { EditorView } from "@codemirror/view";
import { files } from "../lib/ipc";
import { treeAtom } from "../panels/projects/workspaceStore";
import { prefsAtom, setPrefs } from "./prefs";
import { CLEAR_CONFIRM_CHARS, createSaver, draftPath, draftProject, encodeKey, frameDraft, refsText, sendBlocker, spliceRefs, type SendMode } from "./scratch";
import { getPaths, store, toastError, toastInfo } from "./store";
import { activeKeyAtom, activeTabAtom } from "./tabState";
import { focusTerminal, writeToTab } from "./terminals";

/** The draft being edited: its key, the project path it belongs to, and whether the Drafts menu picked it. */
export type DraftKey = { key: string; project: string; explicit: boolean };

/** prefs.scratchOpen; writing it opens or closes the drawer (no focus change, no flush: use the actions). */
export const scratchOpenAtom = atom(
  (get) => get(prefsAtom).scratchOpen,
  (get, set, open: boolean) => set(prefsAtom, { ...get(prefsAtom), scratchOpen: open }),
);
export const scratchTextAtom = atom("");
/** null until a tab has been open while the drawer was. */
export const scratchKeyAtom = atom<DraftKey | null>(null);
/** The Clear confirm row is showing (Clear or Ctrl+L on a draft over CLEAR_CONFIRM_CHARS). */
export const clearConfirmAtom = atom(false);
/** Why the active tab cannot receive a draft (the send buttons' title), or null. */
export const sendBlockerAtom = atom((get) => sendBlocker(get(activeTabAtom)));

// ---------------------------------------------------------------------------
// saving

async function writeDraft(key: string, text: string) {
  try {
    const path = draftPath((await getPaths()).appData, key);
    if (text === "") {
      if (await files.exists(path)) await files.remove(path);
    } else {
      await files.writeText(path, text);
    }
  } catch (e) {
    toastError(e, "Could not save the draft");
  }
}

const saver = createSaver(writeDraft);

/** Write the pending draft now (tests, the driver, closing the drawer). */
export function flushDraft(): Promise<void> {
  return saver.flush();
}

/** Replace the draft text and save it after the debounce. */
export function setText(text: string) {
  store.set(scratchTextAtom, text);
  const k = store.get(scratchKeyAtom);
  if (k) saver.schedule(k.key, text);
}

// ---------------------------------------------------------------------------
// the draft key: the active tab's project, or a draft picked from the menu

let loadSeq = 0;
/** The active tab key the current draft was chosen under; a change ends an explicit pick. */
let keyTab: string | null = null;

async function loadDraft(next: DraftKey) {
  const seq = ++loadSeq;
  await saver.flush();
  if (seq !== loadSeq) return;
  store.set(scratchKeyAtom, next);
  store.set(clearConfirmAtom, false);
  store.set(scratchTextAtom, "");
  let text = "";
  try {
    const path = draftPath((await getPaths()).appData, next.key);
    if (await files.exists(path)) text = await files.readText(path);
  } catch (e) {
    toastError(e, "Could not read the draft");
  }
  // Typing during the read wins over the file.
  if (seq === loadSeq && store.get(scratchTextAtom) === "") store.set(scratchTextAtom, text);
}

/** Follow the active tab (and the workspace tree, which decides its project) while the drawer is open. */
function syncKey() {
  if (!store.get(scratchOpenAtom)) return;
  const active = store.get(activeKeyAtom);
  const cur = store.get(scratchKeyAtom);
  if (cur?.explicit && active === keyTab) return;
  const tab = store.get(activeTabAtom);
  if (!tab) return; // no tab: keep the last draft
  keyTab = active;
  const project = draftProject(tab.cwd, store.get(treeAtom));
  const next: DraftKey = { key: encodeKey(project), project, explicit: false };
  if (cur && cur.key === next.key && !cur.explicit) {
    if (cur.project !== project) store.set(scratchKeyAtom, next);
    return;
  }
  void loadDraft(next);
}

/** Edit the draft `key` (from scratch_list) until the next tab change. */
export function pickDraft(key: string, project: string | null) {
  keyTab = store.get(activeKeyAtom);
  const cur = store.get(scratchKeyAtom);
  if (cur?.key === key) {
    store.set(scratchKeyAtom, { ...cur, explicit: true });
    return;
  }
  void loadDraft({ key, project: project ?? key, explicit: true });
}

let started = false;
/** Subscribe to the active tab and the tree (once, at boot). */
export function startScratch() {
  if (started) return;
  started = true;
  store.sub(activeKeyAtom, syncKey);
  store.sub(activeTabAtom, syncKey);
  store.sub(treeAtom, syncKey);
  store.sub(scratchOpenAtom, syncKey);
  syncKey();
}

// ---------------------------------------------------------------------------
// the editor view

let view: EditorView | null = null;
let unsubView: (() => void) | null = null;
let focusWanted = false;

/** Called by the drawer's CodeEditor with its view (null on unmount). */
export function registerScratchEditor(v: EditorView | null) {
  unsubView?.();
  unsubView = null;
  view = v;
  if (!v) return;
  const apply = () => {
    const text = store.get(scratchTextAtom);
    const doc = v.state.doc.toString();
    if (doc !== text) v.dispatch({ changes: { from: 0, to: doc.length, insert: text }, selection: { anchor: text.length } });
  };
  apply();
  unsubView = store.sub(scratchTextAtom, apply);
  if (focusWanted) {
    focusWanted = false;
    v.focus();
  }
}

/** The editor typed: keep the atom (and the file) in step. */
export function onEditorChange(doc: string) {
  if (doc !== store.get(scratchTextAtom)) setText(doc);
}

export function focusScratchEditor() {
  if (view) view.focus();
  else focusWanted = true;
}

// ---------------------------------------------------------------------------
// actions

export function openScratch() {
  if (!store.get(scratchOpenAtom)) setPrefs({ scratchOpen: true });
  focusScratchEditor();
}

/** Close the drawer and save the draft now; the active terminal gets the focus. */
export function closeScratch() {
  focusWanted = false;
  if (store.get(scratchOpenAtom)) setPrefs({ scratchOpen: false });
  store.set(clearConfirmAtom, false);
  void saver.flush();
  const key = store.get(activeKeyAtom);
  if (key) focusTerminal(key);
}

/** Ctrl+Shift+Space, the palette and the rail's Pencil button. */
export function toggleScratch() {
  if (store.get(scratchOpenAtom)) closeScratch();
  else openScratch();
}

/** Esc in the editor: the terminal gets the focus, the drawer stays open. */
export function focusActiveTerminal() {
  const key = store.get(activeKeyAtom);
  if (key) focusTerminal(key);
}

/** Empty the draft (its file is deleted) now. */
export function clearDraft() {
  store.set(clearConfirmAtom, false);
  setText("");
  void saver.flush();
  focusScratchEditor();
}

/** Clear, asking first when the draft is over CLEAR_CONFIRM_CHARS characters. */
export function requestClear() {
  if (store.get(scratchTextAtom).length > CLEAR_CONFIRM_CHARS) store.set(clearConfirmAtom, true);
  else clearDraft();
}

/**
 * Send the draft to the active tab's pty in bracketed paste, with `\r` for
 * "submit". The draft is kept. Toasts and returns false when the tab cannot
 * receive or the draft is empty.
 */
export function sendDraft(mode: SendMode = "submit"): boolean {
  const tab = store.get(activeTabAtom);
  const reason = sendBlocker(tab);
  if (reason || !tab) {
    toastInfo(reason ?? "No tab open");
    return false;
  }
  const text = store.get(scratchTextAtom);
  if (!text.trim()) {
    toastInfo("The draft is empty");
    return false;
  }
  if (!writeToTab(tab.key, frameDraft(text, mode))) {
    toastInfo("The tab is not running");
    return false;
  }
  focusTerminal(tab.key);
  return true;
}

/** The active tab's project, for relative @references (null without a tab). */
export function activeProject(): string | null {
  const tab = store.get(activeTabAtom);
  return tab ? draftProject(tab.cwd, store.get(treeAtom)) : null;
}

/**
 * Insert `@<path>` per path (one per line, relative inside the active tab's
 * project) at `pos`, else at the cursor, else at the end of the draft.
 */
export function insertRefs(paths: string[], pos?: number | null) {
  const refs = refsText(paths, activeProject());
  if (!refs) return;
  if (view) {
    const doc = view.state.doc.toString();
    const at = Math.max(0, Math.min(doc.length, pos ?? view.state.selection.main.head));
    const { insert, cursor } = spliceRefs(doc, at, refs);
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: cursor }, scrollIntoView: true });
    view.focus();
    return;
  }
  const doc = store.get(scratchTextAtom);
  setText(doc + spliceRefs(doc, doc.length, refs).insert);
}

/** A drop at viewport point (x, y): insert where the editor puts that point, else at the cursor. */
export function insertRefsAt(paths: string[], x: number, y: number) {
  insertRefs(paths, view?.posAtCoords({ x, y }) ?? null);
}
