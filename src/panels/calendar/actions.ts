// Calendar side effects: read schedule.json at boot, save every change
// through schedule_write (which also renders SCHEDULE.md), and keep the
// date current so the Today strip and SCHEDULE.md roll over at midnight.
import { schedule as scheduleIpc, type Schedule } from "../../lib/ipc";
import { store, toastError } from "../../app/store";
import { sanitizeSchedule, scheduleAtom, todayAtom, todayYmd } from "./model";

export async function loadSchedule(): Promise<void> {
  try {
    store.set(scheduleAtom, sanitizeSchedule(await scheduleIpc.read()));
  } catch (e) {
    toastError(e, "Could not read schedule.json");
  }
}

/** Save the schedule (optimistic; rolled back with a toast on failure). */
export async function saveSchedule(next: Schedule): Promise<boolean> {
  const before = store.get(scheduleAtom);
  store.set(scheduleAtom, next);
  try {
    store.set(scheduleAtom, sanitizeSchedule(await scheduleIpc.write(next)));
    return true;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    // schedule.json was written; only SCHEDULE.md failed. Keep the change.
    if (!msg.startsWith("schedule saved")) store.set(scheduleAtom, before);
    toastError(msg, "Could not save the schedule");
    return false;
  }
}

let started = false;
/** At boot: read the schedule and start the clock. */
export function startCalendar(): void {
  if (started) return;
  started = true;
  void loadSchedule();
  window.setInterval(() => {
    const now = todayYmd();
    if (store.get(todayAtom) === now) return;
    store.set(todayAtom, now);
    // A new day: Today in SCHEDULE.md moves on too.
    scheduleIpc.render().catch(() => {});
  }, 60_000);
}
