// Calendar sheets: Day (area, note, the day's tasks, schedule a task) and
// Rhythm (area + note per weekday). Plans save through schedule_write; task
// dates are board writes (setItemField).
import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { CalendarX } from "lucide-react";
import type { DayPlan, WeekdayKey } from "../../lib/ipc";
import { Button, IconButton, Select, TextInput } from "../ui";
import { Sheet } from "../shared/Sheet";
import { store } from "../../app/store";
import { boardConfigAtom, snapshotAtom } from "../board/model";
import { NoBoardLine } from "../board/BoardConnect";
import { setItemField } from "../board/actions";
import { StatusDot } from "../board/StatusDot";
import { saveSchedule } from "./actions";
import { WEEKDAY_KEYS, WEEKDAY_NAMES, dayPlan, dayTasks, emptySchedule, schedulableTasks, scheduleAtom, weekdayKey, withOverride, withRhythm, type Ymd } from "./model";

const NONE = "";

function AreaSelect({ value, areas, onChange, label }: { value: string | null; areas: string[]; onChange: (v: string | null) => void; label: string }) {
  const list = value && !areas.includes(value) ? [...areas, value] : areas;
  return (
    <Select value={value ?? NONE} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
      <option value={NONE}>none</option>
      {list.map((a) => (
        <option key={a} value={a}>
          {a}
        </option>
      ))}
    </Select>
  );
}

const Label = ({ children }: { children: string }) => <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{children}</span>;

export function DaySheet({ date, title, areas, close }: { date: Ymd; title: string; areas: string[]; close: () => void }) {
  const schedule = useAtomValue(scheduleAtom) ?? emptySchedule();
  const config = useAtomValue(boardConfigAtom);
  const boardSnap = useAtomValue(snapshotAtom);
  const snap = config ? boardSnap : null;
  const plan = dayPlan(schedule, date);
  const rhythm = schedule.rhythm[weekdayKey(date)];
  const [area, setArea] = useState<string | null>(plan.area);
  const [note, setNote] = useState(plan.source === "override" ? plan.note : "");
  const [busy, setBusy] = useState(false);
  const items = useMemo(() => snap?.items ?? [], [snap]);
  const tasks = useMemo(() => dayTasks(items, date), [items, date]);
  const pickable = useMemo(() => schedulableTasks(items).filter((i) => i.scheduled !== date), [items, date]);
  const dirty = area !== plan.area || note.trim() !== (plan.source === "override" ? plan.note : "");

  const save = async () => {
    setBusy(true);
    // Read the newest schedule: a drag may have changed it while the sheet was open.
    const base = store.get(scheduleAtom) ?? emptySchedule();
    const ok = await saveSchedule(withOverride(base, date, { area, note }));
    setBusy(false);
    if (ok) close();
  };
  const resetToRhythm = async () => {
    setBusy(true);
    const ok = await saveSchedule(withOverride(store.get(scheduleAtom) ?? emptySchedule(), date, null));
    setBusy(false);
    if (ok) close();
  };

  return (
    <Sheet
      title={title}
      subtitle={plan.source === "override" ? "This day has its own plan" : `Weekly rhythm: ${rhythm.area ?? "none"}`}
      onClose={close}
      footer={
        <>
          {plan.source === "override" && (
            <Button variant="ghost" onClick={() => void resetToRhythm()} disabled={busy} title="Remove this day's own plan">
              Use weekly rhythm
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={close} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            Save plan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 p-3">
        <label className="flex flex-col gap-1">
          <Label>Area</Label>
          <AreaSelect value={area} areas={areas} onChange={setArea} label="Area for this day" />
        </label>
        <label className="flex flex-col gap-1">
          <Label>Note</Label>
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="One line for this day"
            aria-label="Note for this day"
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty && !busy) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </label>
        {!config ? (
          <div className="flex flex-col gap-1">
            <Label>Tasks</Label>
            <NoBoardLine onOpen={close} />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Label>Tasks</Label>
              {tasks.length === 0 && <p className="text-[11px] text-fg-muted">Nothing scheduled.</p>}
              {tasks.map((t) => (
                <div key={t.itemId} className="flex min-w-0 items-center gap-1.5 rounded-ui px-1 py-0.5 hover:bg-bg-hover" data-day-task={t.itemId}>
                  <StatusDot item={t} />
                  <span className="min-w-0 flex-1 truncate text-xs text-fg" title={`${t.repo}#${t.number} ${t.title}`}>
                    {t.title}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-fg-muted">#{t.number}</span>
                  <IconButton icon={CalendarX} title="Unschedule" onClick={() => void setItemField(t.itemId, "scheduled", null)} />
                </div>
              ))}
            </div>
            <label className="flex flex-col gap-1">
              <Label>Schedule a task</Label>
              <Select
                value=""
                aria-label="Schedule a task on this day"
                disabled={pickable.length === 0}
                onChange={(e) => {
                  if (e.target.value) void setItemField(e.target.value, "scheduled", date);
                }}
              >
                <option value="">{pickable.length === 0 ? "No open tasks to schedule" : "Pick a task..."}</option>
                {pickable.map((t) => (
                  <option key={t.itemId} value={t.itemId}>
                    {t.status ?? "Backlog"}: {t.title} ({t.repo.split("/")[1]}#{t.number}){t.scheduled ? `, now ${t.scheduled}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          </>
        )}
      </div>
    </Sheet>
  );
}

export function RhythmSheet({ areas, close }: { areas: string[]; close: () => void }) {
  const schedule = useAtomValue(scheduleAtom) ?? emptySchedule();
  const [rows, setRows] = useState<Record<WeekdayKey, DayPlan>>(() => ({ ...schedule.rhythm }));
  const [busy, setBusy] = useState(false);
  const dirty = WEEKDAY_KEYS.some((k) => rows[k].area !== schedule.rhythm[k].area || rows[k].note.trim() !== schedule.rhythm[k].note);
  const set = (k: WeekdayKey, patch: Partial<DayPlan>) => setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));

  const save = async () => {
    setBusy(true);
    const ok = await saveSchedule(withRhythm(store.get(scheduleAtom) ?? emptySchedule(), rows));
    setBusy(false);
    if (ok) close();
  };

  return (
    <Sheet
      title="Weekly rhythm"
      subtitle="The area each weekday belongs to; a day's own plan wins"
      onClose={close}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            Save rhythm
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[6rem_minmax(0,10rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 p-3">
        {WEEKDAY_KEYS.map((k, i) => (
          <div key={k} className="contents" data-rhythm={k}>
            <span className="text-xs text-fg">{WEEKDAY_NAMES[i]}</span>
            <AreaSelect value={rows[k].area} areas={areas} onChange={(v) => set(k, { area: v })} label={`${WEEKDAY_NAMES[i]} area`} />
            <TextInput value={rows[k].note} onChange={(e) => set(k, { note: e.target.value })} placeholder="Note" aria-label={`${WEEKDAY_NAMES[i]} note`} />
          </div>
        ))}
      </div>
    </Sheet>
  );
}
