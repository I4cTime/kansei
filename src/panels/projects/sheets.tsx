// Sheets for the Projects panel: Edit (description, status, accent), and the project
// picker used by "Related..." and "Open with...".
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, TextArea, cx } from "../ui";
import { errText } from "../shared/hooks";
import { Sheet } from "../shared/Sheet";
import { queryWords } from "./model";
import { STATUSES, type PickItem, type ProjectStatus, type RegistryEntry } from "./workspace";
import { ACCENT_NAMES, accentVar, type AccentName } from "../../app/accents";

type EditPatch = { description: string; status: ProjectStatus | null; accent: AccentName | null };

export function EditSheet({
  title,
  subtitle,
  entry,
  autoAccent,
  onSave,
  close,
}: {
  title: string;
  subtitle: string;
  entry: RegistryEntry;
  /** The accent Auto gives this project (the hash of its path), for the Auto swatch. */
  autoAccent: AccentName;
  onSave: (patch: EditPatch) => Promise<void>;
  close: () => void;
}) {
  const [description, setDescription] = useState(entry.description);
  const [status, setStatus] = useState<ProjectStatus | "">(entry.status ?? "");
  const [accent, setAccent] = useState<AccentName | null>(entry.accent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = description.trim() !== entry.description || (status || null) !== entry.status || accent !== entry.accent;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ description: description.trim(), status: status || null, accent });
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Edit ${title}`}
      subtitle={subtitle}
      onClose={close}
      footer={
        <>
          {error && <span className="min-w-0 flex-1 truncate text-[11px] text-danger" title={error}>{error}</span>}
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Description</span>
          <TextArea
            autoFocus
            className="font-sans"
            rows={3}
            value={description}
            placeholder="One line: what it is and what it is built with"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (dirty && !busy) void save();
              }
            }}
          />
          <span className="text-[11px] text-fg-muted">Shown in the Projects panel and in PROJECTS.md as one line. Ctrl+Enter saves.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | "")}>
            <option value="">(none)</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-col gap-1">
          <span id="edit-accent-label" className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
            Accent
          </span>
          <div role="radiogroup" aria-labelledby="edit-accent-label" className="flex flex-wrap gap-1" data-accent-picker="">
            {[null, ...ACCENT_NAMES].map((a) => (
              <AccentOption key={a ?? "auto"} name={a} swatch={a ?? autoAccent} checked={accent === a} onPick={() => setAccent(a)} />
            ))}
          </div>
          <span className="text-[11px] text-fg-muted">Tints this project's tabs, the terminal column and the header chip. Auto picks one from the path.</span>
        </div>
      </div>
    </Sheet>
  );
}

function AccentOption({ name, swatch, checked, onPick }: { name: AccentName | null; swatch: AccentName; checked: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-accent-option={name ?? "auto"}
      onClick={onPick}
      title={name ? undefined : `Auto (${swatch})`}
      className={cx(
        "flex h-6 cursor-pointer items-center gap-1.5 rounded-ui border px-2 text-[12px]",
        checked ? "border-accent bg-accent/15 text-fg" : "border-border text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", !name && "opacity-60")} style={{ background: accentVar(swatch) }} />
      {name ?? "Auto"}
    </button>
  );
}

export function PickerSheet({
  title,
  subtitle,
  items,
  initial,
  confirmLabel,
  note,
  requireChange = false,
  onConfirm,
  close,
}: {
  title: string;
  subtitle: string;
  items: PickItem[];
  initial: string[];
  confirmLabel: string;
  note?: string;
  /** Confirm only after the selection changed (Related); Open with confirms any selection. */
  requireChange?: boolean;
  onConfirm: (paths: string[]) => Promise<void> | void;
  close: () => void;
}) {
  const [q, setQ] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const shown = useMemo(() => {
    const words = queryWords(q);
    if (words.length === 0) return items;
    return items.filter((it) => {
      const hay = `${it.name}\n${it.rel}\n${it.heading}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);

  const initialKey = [...initial].sort().join("\n");
  const changed = [...checked].sort().join("\n") !== initialKey;
  // In tree order, so the saved list reads like the tree.
  const selected = items.filter((it) => checked.has(it.path)).map((it) => it.path);
  const canConfirm = !busy && (!requireChange || changed);

  const toggle = (path: string) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(selected);
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  let lastHeading = "";
  return (
    <Sheet
      title={title}
      subtitle={subtitle}
      onClose={close}
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={error ?? undefined}>
            {error ? <span className="text-danger">{error}</span> : `${selected.length} selected`}
          </span>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="sticky top-0 z-10 border-b border-border bg-bg px-3 py-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects"
          spellCheck={false}
          aria-label="Search projects"
          className="w-full rounded-ui border border-border bg-bg-sunken px-2 py-1 text-xs text-fg outline-none placeholder:text-fg-muted focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) {
              e.stopPropagation();
              setQ("");
            }
          }}
        />
        {note && <p className="pt-1.5 text-[11px] leading-relaxed text-fg-muted">{note}</p>}
      </div>
      {shown.length === 0 && <p className="px-3 py-4 text-center text-[11px] text-fg-muted">Nothing matches "{q}".</p>}
      <div className="pb-2">
        {shown.map((it) => {
          const heading = it.heading !== lastHeading ? it.heading : null;
          lastHeading = it.heading;
          return (
            <div key={it.path}>
              {heading && <div className="px-3 pt-2.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{heading}</div>}
              <label className={cx("flex cursor-pointer items-center gap-2 py-1 pr-3 hover:bg-bg-hover", it.depth ? "pl-8" : "pl-3")} title={it.path} data-pick={it.path}>
                <input type="checkbox" className="shrink-0 accent-accent" checked={checked.has(it.path)} onChange={() => toggle(it.path)} />
                <span className="min-w-0 truncate text-[13px] text-fg">{it.name}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-fg-muted">{it.rel}</span>
              </label>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
