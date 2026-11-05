// Tab atoms. Actions live in tabs.ts (which re-exports these).
import { atom } from "jotai";
import { store } from "./store";

export type TabStatus = "spawning" | "alive" | "dead";

export type Tab = {
  /** pty id, null while spawning or after exit. */
  id: string | null;
  /** Stable key for React and the terminal registry. */
  key: string;
  title: string;
  cwd: string;
  command: string;
  args: string[];
  status: TabStatus;
  /** Exit code of the last pty (null if unknown or still running). */
  exitCode: number | null;
  /** Set when pty_spawn itself failed. */
  error: string | null;
  /** The pty child's pid (from pty_spawn or pty_list); null while spawning, after exit or when unknown. */
  pid: number | null;
};

export const tabsAtom = atom<Tab[]>([]);
export const activeKeyAtom = atom<string | null>(null);
export const activeTabAtom = atom((get) => {
  const key = get(activeKeyAtom);
  return get(tabsAtom).find((t) => t.key === key) ?? null;
});
/** A tab key whose rail item should enter rename mode (the palette's Rename tab); the item clears it. */
export const renameRequestAtom = atom<string | null>(null);
/** True once tabs.json has been restored; persistence starts after that. */
export const tabsRestoredAtom = atom(false);

export function getTab(key: string): Tab | undefined {
  return store.get(tabsAtom).find((t) => t.key === key);
}

export function updateTab(key: string, patch: Partial<Omit<Tab, "key">>) {
  store.set(tabsAtom, (tabs) => tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)));
}
