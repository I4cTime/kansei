import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { OverlayHost } from "./OverlayHost";
import { Sidebar } from "./Sidebar";
import { TabRail } from "./TabRail";
import { TerminalArea } from "./TerminalArea";
import { ToastHost } from "./ToastHost";
import { installShortcuts } from "./keyboard";
import { installDriver } from "./driver";
import { loadPrefs, prefsAtom } from "./prefs";
import { store, toastError } from "./store";
import { restoreTabs } from "./tabs";
import { startPtyRouting } from "./terminals";
import { themeTickAtom } from "./terminalTheme";
import { startWorkspaces } from "../panels/projects/workspaceStore";

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  try {
    await startPtyRouting();
  } catch (e) {
    toastError(e, "Could not listen for terminal output");
  }
  await loadPrefs();
  startWorkspaces();
  await restoreTabs();
}

const bumpTheme = () => store.set(themeTickAtom, (n) => n + 1);

export default function App() {
  const theme = useAtomValue(prefsAtom).theme;

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => installShortcuts(), []);
  useEffect(() => installDriver(), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    bumpTheme();
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", bumpTheme);
    return () => mq.removeEventListener("change", bumpTheme);
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <TabRail />
        <TerminalArea />
        <OverlayHost />
      </main>
      <ToastHost />
    </div>
  );
}
