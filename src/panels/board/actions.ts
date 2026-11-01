// Board side effects: load the cache at boot, fetch through gh, and the
// optimistic field writes (rolled back with a toast when GitHub refuses).
import { board, type BoardField, type BoardItem, type BoardSnapshot } from "../../lib/ipc";
import { store, toastError, toastInfo } from "../../app/store";
import { boardLoadingAtom, ghStatusAtom, patchItem, snapshotAtom, withItem } from "./model";

const REFRESH_MS = 10 * 60_000;

let fetching: Promise<BoardSnapshot | null> | null = null;

/**
 * Fetch the board (force skips the 60 s cache). A failed fetch keeps the
 * items shown and records the error on the snapshot; `loud` toasts it.
 */
export function refreshBoard(force = false, loud = force): Promise<BoardSnapshot | null> {
  if (fetching && !force) return fetching;
  let run: Promise<BoardSnapshot | null> | null = null;
  run = (async () => {
    store.set(boardLoadingAtom, true);
    try {
      const snap = await board.fetch(force);
      const prev = store.get(snapshotAtom);
      // Nothing came back (gh failed, no cache on disk): keep what is shown.
      const next = snap.error && snap.items.length === 0 && prev ? { ...prev, error: snap.error } : snap;
      store.set(snapshotAtom, next);
      if (snap.error && loud) toastError(snap.error, "Could not refresh the board");
      return next;
    } catch (e) {
      if (loud) toastError(e, "Could not refresh the board");
      return null;
    } finally {
      store.set(boardLoadingAtom, false);
      if (fetching === run) fetching = null;
    }
  })();
  fetching = run;
  return run;
}

export async function refreshGhStatus(): Promise<void> {
  try {
    store.set(ghStatusAtom, await board.ghStatus());
  } catch (e) {
    store.set(ghStatusAtom, { available: false, login: null, scopes: [], error: e instanceof Error ? e.message : String(e) });
  }
}

let started = false;
/** At boot: show board.json, check gh, fetch once, then every 10 min while visible. */
export function startBoard(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      const cached = await board.cached();
      if (cached && !store.get(snapshotAtom)) store.set(snapshotAtom, cached);
    } catch (e) {
      toastError(e, "Could not read board.json");
    }
    await refreshGhStatus();
    await refreshBoard(false, false);
  })();
  window.setInterval(() => {
    if (!document.hidden) void refreshBoard(false, false);
  }, REFRESH_MS);
}

function findItem(itemId: string): BoardItem | undefined {
  return store.get(snapshotAtom)?.items.find((i) => i.itemId === itemId);
}

/**
 * Change one field on GitHub. The snapshot changes right away; when the write
 * fails the item goes back to how it was and a toast says why.
 */
export async function setItemField(itemId: string, field: BoardField, value: string | number | null): Promise<BoardItem | null> {
  const before = findItem(itemId);
  if (!before) {
    toastError(`item ${itemId} is not on the board`);
    return null;
  }
  const optimistic = patchItem(before, field, value);
  store.set(snapshotAtom, (s) => withItem(s, optimistic));
  try {
    const item = await board.setField(itemId, field, value);
    store.set(snapshotAtom, (s) => withItem(s, item));
    return item;
  } catch (e) {
    // Roll back unless something else changed the item meanwhile.
    if (findItem(itemId) === optimistic) store.set(snapshotAtom, (s) => withItem(s, before));
    toastError(e, `Could not change ${before.repo}#${before.number}`);
    return null;
  }
}

export async function createTask(a: Parameters<typeof board.createTask>[0]): Promise<BoardItem> {
  const item = await board.createTask(a);
  store.set(snapshotAtom, (s) => withItem(s, item));
  toastInfo(`Created ${item.repo}#${item.number}`);
  return item;
}

export async function createEpic(a: Parameters<typeof board.createEpic>[0]): Promise<BoardItem> {
  const item = await board.createEpic(a);
  store.set(snapshotAtom, (s) => withItem(s, item));
  toastInfo(`Created epic ${item.repo}#${item.number}`);
  return item;
}
