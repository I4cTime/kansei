// Minimal UI primitives for the panels. Local on purpose: src/app/ui.tsx is owned
// by the shell and may not exist when the panels are built.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

type Variant = "default" | "primary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  default: "bg-bg-raised border border-border text-fg hover:bg-bg-hover",
  primary: "bg-accent text-accent-fg border border-accent hover:opacity-90",
  danger: "bg-transparent border border-danger text-danger hover:bg-danger hover:text-bg",
  ghost: "bg-transparent border border-transparent text-fg-muted hover:text-fg hover:bg-bg-hover",
};

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

export function Button({
  variant = "default",
  icon: Icon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: LucideIcon }) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-ui px-2 py-1 text-xs font-medium whitespace-nowrap",
        "disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={13} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  title,
  danger,
  className,
  type = "button",
  spin,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; title: string; danger?: boolean; spin?: boolean }) {
  return (
    <button
      type={type}
      title={title}
      aria-label={title}
      className={cx(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-ui cursor-pointer",
        "text-fg-muted hover:bg-bg-hover disabled:opacity-40 disabled:pointer-events-none",
        danger ? "hover:text-danger" : "hover:text-fg",
        className,
      )}
      {...rest}
    >
      <Icon size={14} strokeWidth={2} className={spin ? "animate-spin" : undefined} />
    </button>
  );
}

const FIELD = "w-full rounded-ui border border-border bg-bg-sunken px-2 py-1 text-xs text-fg outline-none focus:border-accent placeholder:text-fg-muted";

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD, className)} spellCheck={false} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(FIELD, "font-mono resize-y min-h-[3.5rem]", className)} spellCheck={false} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(FIELD, "cursor-pointer", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors cursor-pointer",
        "disabled:opacity-40 disabled:pointer-events-none",
        checked ? "bg-accent border-accent" : "bg-bg-sunken border-border",
      )}
    >
      <span
        className={cx(
          "inline-block h-2.5 w-2.5 rounded-full transition-transform",
          checked ? "translate-x-3.5 bg-accent-fg" : "translate-x-0.5 bg-fg-muted",
        )}
      />
    </button>
  );
}

export function Badge({ children, tone = "muted", title }: { children: ReactNode; tone?: "muted" | "accent" | "ok" | "warn" | "danger"; title?: string }) {
  const tones = {
    muted: "border-border text-fg-muted",
    accent: "border-accent text-accent",
    ok: "border-ok text-ok",
    warn: "border-warn text-warn",
    danger: "border-danger text-danger",
  } as const;
  return (
    <span title={title} className={cx("inline-flex shrink-0 items-center rounded border px-1 text-[10px] leading-4 font-medium", tones[tone])}>
      {children}
    </span>
  );
}
