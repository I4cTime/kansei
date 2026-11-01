// Window-level shortcuts (capture phase, so they win over xterm and inputs).
import { PANELS } from "../panels";
import { overlayAtom } from "../lib/overlay";
import { prefsAtom, setPrefs } from "./prefs";
import { matchShortcut, type ShortcutAction } from "./shortcuts";
import { store } from "./store";
import { closeActiveTab, cycleTab, newTabWithPicker } from "./tabs";

function run(a: ShortcutAction) {
  switch (a.type) {
    case "newTab":
      void newTabWithPicker();
      return;
    case "closeTab":
      closeActiveTab();
      return;
    case "prevTab":
      cycleTab(-1);
      return;
    case "nextTab":
      cycleTab(1);
      return;
    case "toggleSidebar":
      setPrefs({ sidebarCollapsed: !store.get(prefsAtom).sidebarCollapsed });
      return;
    case "section": {
      const panel = PANELS[a.index];
      if (panel) setPrefs({ sidebarSection: panel.id, sidebarCollapsed: false });
      return;
    }
    case "panel":
      if (PANELS.some((p) => p.id === a.id)) setPrefs({ sidebarSection: a.id, sidebarCollapsed: false });
      return;
  }
}

/** Close the overlay as Esc would: onEscape() returning false keeps it open. */
export function dismissOverlay() {
  const ov = store.get(overlayAtom);
  if (!ov) return;
  if (ov.onEscape?.() === false) return;
  // onEscape may have replaced the overlay itself; only clear the one we saw.
  if (store.get(overlayAtom) === ov) store.set(overlayAtom, null);
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && store.get(overlayAtom)) {
      e.preventDefault();
      e.stopPropagation();
      dismissOverlay();
      return;
    }
    const action = matchShortcut(e);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && (action.type === "newTab" || action.type === "closeTab")) return;
    run(action);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
