// Live project accents (CONTRACT.md "Project accents"): the accent of a cwd
// from the scanned trees and the registry, and the active tab's accent when
// prefs.projectAccents is on. The pure rules are in accents.ts.
import { atom } from "jotai";
import { registryAtom, treeAtom } from "../panels/projects/workspaceStore";
import { tabAccent, type TabAccent } from "./accents";
import { prefsAtom } from "./prefs";
import { activeTabAtom } from "./tabState";

/** cwd -> its project, name and accent, from the current trees and registry (regardless of the pref). */
export const accentOfAtom = atom((get) => {
  const tree = get(treeAtom);
  const registry = get(registryAtom);
  return (cwd: string): TabAccent => tabAccent(cwd, tree, registry);
});

/** True when the tab rail, terminal column and header are tinted (prefs.projectAccents). */
export const accentsOnAtom = atom((get) => get(prefsAtom).projectAccents);

/** The active tab's accent; null with no active tab or with the pref off. */
export const activeAccentAtom = atom((get) => {
  const tab = get(activeTabAtom);
  if (!tab || !get(accentsOnAtom)) return null;
  return get(accentOfAtom)(tab.cwd);
});
