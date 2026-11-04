import { useEffect } from "react";
import { OverlayHost } from "./OverlayHost";
import { Sidebar } from "./Sidebar";
import { TabRail } from "./TabRail";
import { TerminalArea } from "./TerminalArea";
import { ToastHost } from "./ToastHost";
import { installShortcuts } from "./keyboard";
import { installDriver } from "./driver";
import { loadPrefs } from "./prefs";
import { toastError } from "./store";
import { restoreTabs } from "./tabs";
import { startPtyRouting } from "./terminals";
import { startActivity } from "./activity";
import { startTheme } from "./theme/apply";
import { startWorkspaces } from "../panels/projects/workspaceStore";
import { startBoard } from "../panels/board/actions";
import { startCalendar } from "../panels/calendar/actions";

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
  startActivity().catch((e) => toastError(e, "Could not listen for tab status"));
  startTheme();
  startWorkspaces();
  startBoard();
  startCalendar();
  await restoreTabs();
}

export default function App() {
  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => installShortcuts(), []);
  useEffect(() => installDriver(), []);

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
