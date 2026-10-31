// Overlay host: panels push a React node here; the shell renders it over the
// terminal area. Esc (handled by the shell) clears it unless onEscape returns false.
import { atom } from "jotai";
import type { ReactNode } from "react";

export type Overlay = {
  node: ReactNode;
  /** Return false to keep the overlay open (e.g. unsaved changes prompt). */
  onEscape?: () => boolean | void;
};

export const overlayAtom = atom<Overlay | null>(null);

/** Toasts: short messages, errors in red. Shell renders them bottom-right. */
export type Toast = { id: number; kind: "info" | "error"; text: string };
export const toastsAtom = atom<Toast[]>([]);
let toastSeq = 0;
export const pushToastAtom = atom(null, (get, set, t: Omit<Toast, "id">) => {
  const id = ++toastSeq;
  set(toastsAtom, [...get(toastsAtom), { ...t, id }]);
  setTimeout(() => set(toastsAtom, (xs) => xs.filter((x) => x.id !== id)), t.kind === "error" ? 8000 : 3500);
});
