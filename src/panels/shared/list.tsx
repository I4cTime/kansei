// List primitives for narrow sidebar panels.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import { Button, IconButton, cx } from "../ui";

/** Panel root: header pinned, body scrolls. */
export function Panel({ title, loading, onRefresh, actions, children }: { title: string; loading?: boolean; onRefresh?: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
        {actions}
        {onRefresh && <IconButton icon={RefreshCw} title="Refresh" onClick={onRefresh} spin={loading} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
    </div>
  );
}

export function SectionHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 bg-bg px-3 pt-3 pb-1">
      <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{title}</span>
      {count !== undefined && <span className="text-[11px] text-fg-muted tabular-nums">{count}</span>}
      <span className="flex-1" />
      {actions}
    </div>
  );
}

export function Row({
  title,
  subtitle,
  badge,
  actions,
  onClick,
  tooltip,
  active,
  clamp = 1,
  mono,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  tooltip?: string;
  active?: boolean;
  clamp?: 1 | 2;
  mono?: boolean;
}) {
  return (
    <div
      className={cx(
        "group flex items-start gap-1 px-3 py-1.5",
        onClick && "cursor-pointer hover:bg-bg-hover",
        active && "bg-bg-hover",
      )}
      title={tooltip}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cx("min-w-0 truncate text-[13px] text-fg", mono && "font-mono text-xs")}>{title}</span>
          {badge}
        </div>
        {subtitle && (
          <div className={cx("text-[11px] leading-snug text-fg-muted break-words", clamp === 2 ? "line-clamp-2" : "truncate")}>{subtitle}</div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = "Filter" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="px-3 pt-2">
      <div className="flex items-center gap-1 rounded-ui border border-border bg-bg-sunken px-2 focus-within:border-accent">
        <Search size={12} className="shrink-0 text-fg-muted" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent py-1 text-xs text-fg outline-none placeholder:text-fg-muted"
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.stopPropagation();
              onChange("");
            }
          }}
        />
        {value && <IconButton icon={X} title="Clear filter" className="h-5 w-5" onClick={() => onChange("")} />}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-3 my-3 rounded-ui border border-dashed border-border px-3 py-4 text-center">
      <div className="text-xs font-medium text-fg">{title}</div>
      {children && <div className="mt-1 text-[11px] leading-relaxed text-fg-muted">{children}</div>}
    </div>
  );
}

/** Inline confirm bar, used instead of window.confirm. */
export function ConfirmBar({ text, confirmLabel = "Delete", onConfirm, onCancel, busy }: { text: ReactNode; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <div className="mx-3 my-1 flex flex-wrap items-center gap-1.5 rounded-ui border border-danger bg-bg-raised px-2 py-1.5">
      <span className="min-w-0 flex-1 text-[11px] text-fg">{text}</span>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="danger" onClick={onConfirm} disabled={busy}>
        {confirmLabel}
      </Button>
    </div>
  );
}

/** Inline single-line prompt (for slugs and names). Enter submits, Esc cancels. */
export function InlinePrompt({
  label,
  placeholder,
  submitLabel = "Create",
  initial = "",
  validate,
  onSubmit,
  onCancel,
  hint,
}: {
  label: string;
  placeholder?: string;
  submitLabel?: string;
  initial?: string;
  validate?: (v: string) => string | null;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  hint?: ReactNode;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const err = v.trim() ? (validate?.(v) ?? null) : null;
  const submit = () => {
    if (!v.trim() || err) return;
    onSubmit(v.trim());
  };
  return (
    <div className="mx-3 my-2 flex flex-col gap-1.5 rounded-ui border border-border bg-bg-raised p-2">
      <span className="text-[11px] font-medium text-fg-muted">{label}</span>
      <input
        ref={ref}
        value={v}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="w-full rounded-ui border border-border bg-bg-sunken px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
      />
      {err ? <span className="text-[11px] text-danger">{err}</span> : hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={!v.trim() || !!err}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("px-3 py-1 text-[11px] leading-relaxed text-fg-muted", className)}>{children}</p>;
}
