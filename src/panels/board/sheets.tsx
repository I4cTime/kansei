// Board sheets: New task, New epic, Move/Schedule. Creating writes to GitHub
// (gh issue create + the board fields); Move/Schedule goes through the
// optimistic setItemField.
import { useMemo, useState, type ReactNode } from "react";
import type { BoardItem, BoardStatus } from "../../lib/ipc";
import { Button, Select, TextArea, TextInput, cx } from "../ui";
import { errText } from "../shared/hooks";
import { Sheet } from "../shared/Sheet";
import { HUB_REPO, LANES, isEpic, laneOf, repoShort } from "./model";
import { createEpic, createTask, setItemField } from "./actions";

function FieldBlock({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
    </label>
  );
}

function Footer({ error, busy, onCancel, onConfirm, confirmLabel, disabled }: { error: string | null; busy: boolean; onCancel: () => void; onConfirm: () => void; confirmLabel: string; disabled?: boolean }) {
  return (
    <>
      {error && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-danger" title={error}>
          {error}
        </span>
      )}
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onConfirm} disabled={busy || disabled}>
        {busy ? "Working..." : confirmLabel}
      </Button>
    </>
  );
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function NewTaskSheet({ items, initialEpic, initialDate, close }: { items: BoardItem[]; initialEpic?: BoardItem | null; initialDate?: string | null; close: () => void }) {
  const epics = useMemo(() => items.filter((i) => isEpic(i) && i.state === "open").sort((a, b) => a.title.localeCompare(b.title)), [items]);
  const repos = useMemo(() => [...new Set(items.filter((i) => i.repo !== HUB_REPO).map((i) => i.repo))].sort(), [items]);
  const [epicKey, setEpicKey] = useState(initialEpic ? initialEpic.itemId : "");
  const epic = epics.find((e) => e.itemId === epicKey) ?? null;
  const [repo, setRepo] = useState(initialEpic?.area ? `I4cTime/${initialEpic.area}` : "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scheduled, setScheduled] = useState(initialDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoOk = REPO_RE.test(repo.trim());

  const pickEpic = (id: string) => {
    setEpicKey(id);
    const e = epics.find((x) => x.itemId === id);
    // A fresh form follows the epic's area (the repo is usually named like it).
    if (e?.area && (!repo.trim() || repo === `I4cTime/${epic?.area ?? ""}`)) setRepo(`I4cTime/${e.area}`);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createTask({
        repo: repo.trim(),
        title: title.trim(),
        body,
        epic: epic ? { repo: epic.repo, number: epic.number } : null,
        scheduled: scheduled || null,
      });
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New task"
      subtitle="gh issue create, then a sub-issue of its epic on the I4C board"
      onClose={close}
      footer={<Footer error={error} busy={busy} onCancel={close} onConfirm={() => void submit()} confirmLabel="Create task" disabled={!repoOk || !title.trim()} />}
    >
      <div className="flex flex-col gap-2.5 p-3">
        <FieldBlock label="Epic">
          <Select value={epicKey} onChange={(e) => pickEpic(e.target.value)} aria-label="Epic">
            <option value="">(no epic)</option>
            {epics.map((e) => (
              <option key={e.itemId} value={e.itemId}>
                #{e.number} {e.title}
              </option>
            ))}
          </Select>
        </FieldBlock>
        <FieldBlock label="Repository" hint="owner/name, where the code lives">
          <TextInput value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="I4cTime/aibou" list="tsukue-board-repos" className="font-mono" aria-label="Repository" />
          <datalist id="tsukue-board-repos">
            {repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </FieldBlock>
        <FieldBlock label="Title">
          <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What gets done" aria-label="Title" />
        </FieldBlock>
        <FieldBlock label="Body">
          <TextArea className="font-sans" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Optional details (Markdown)" aria-label="Body" />
        </FieldBlock>
        <FieldBlock label="Scheduled" hint="The day it is meant to happen (optional)">
          <TextInput type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} aria-label="Scheduled" />
        </FieldBlock>
      </div>
    </Sheet>
  );
}

export function NewEpicSheet({ areas, close }: { areas: string[]; close: () => void }) {
  const [title, setTitle] = useState("");
  const [area, setArea] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createEpic({ title: title.trim(), body, area: area || null, doneWhen: doneWhen.trim() || null });
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New epic"
      subtitle={`An issue in ${HUB_REPO} with Kind Epic`}
      onClose={close}
      footer={<Footer error={error} busy={busy} onCancel={close} onConfirm={() => void submit()} confirmLabel="Create epic" disabled={!title.trim()} />}
    >
      <div className="flex flex-col gap-2.5 p-3">
        <FieldBlock label="Title">
          <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The goal" aria-label="Title" />
        </FieldBlock>
        <FieldBlock label="Area" hint="The project it belongs to">
          <Select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area">
            <option value="">(none)</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </FieldBlock>
        <FieldBlock label="Done when">
          <TextArea className="font-sans" rows={2} value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} placeholder="What finished looks like" aria-label="Done when" />
        </FieldBlock>
        <FieldBlock label="Body">
          <TextArea className="font-sans" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Optional details (Markdown)" aria-label="Body" />
        </FieldBlock>
      </div>
    </Sheet>
  );
}

/** Lane buttons plus the Scheduled date (set or clear). Each change is written right away. */
export function MoveScheduleSheet({ item, close }: { item: BoardItem; close: () => void }) {
  const lane = laneOf(item);
  const [date, setDate] = useState(item.scheduled ?? "");
  const [busy, setBusy] = useState(false);

  const move = async (to: BoardStatus) => {
    if (to === lane) return;
    close();
    await setItemField(item.itemId, "status", to);
  };
  const schedule = async (value: string | null) => {
    setBusy(true);
    const ok = await setItemField(item.itemId, "scheduled", value);
    setBusy(false);
    if (ok) close();
  };

  return (
    <Sheet
      title={item.title}
      subtitle={`${item.repo}#${item.number}`}
      onClose={close}
      footer={
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <FieldBlock label="Lane">
          <div className="flex flex-wrap gap-1">
            {LANES.map((l) => (
              <Button key={l} variant={l === lane ? "primary" : "default"} onClick={() => void move(l)} aria-pressed={l === lane}>
                {l}
              </Button>
            ))}
          </div>
        </FieldBlock>
        <FieldBlock label="Scheduled" hint={item.scheduled ? `Now ${item.scheduled}` : "Not scheduled"}>
          <div className="flex items-center gap-1.5">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Scheduled date" className="min-w-0 flex-1" />
            <Button variant="primary" disabled={busy || !date || date === item.scheduled} onClick={() => void schedule(date)}>
              Set
            </Button>
            <Button disabled={busy || !item.scheduled} onClick={() => void schedule(null)}>
              Clear
            </Button>
          </div>
        </FieldBlock>
        <p className={cx("text-[11px] leading-relaxed text-fg-muted")}>
          Changes go to the I4C board on GitHub ({repoShort(item.repo)}#{item.number}) and come back here when they land.
        </p>
      </div>
    </Sheet>
  );
}
