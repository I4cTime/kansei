// Tiny shared controls. Panels may import these.
//   <Button variant="primary" size="sm" onClick={...}>Save</Button>
//   <IconButton icon={Trash2} label="Delete" variant="danger" onClick={...} />
import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

export type ButtonVariant = "ghost" | "primary" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ui font-medium select-none transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  ghost: "text-fg-muted hover:bg-bg-hover hover:text-fg",
  primary: "bg-accent text-accent-fg hover:brightness-110",
  danger: "text-danger hover:bg-danger/15",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-xs",
  md: "h-7 px-3 text-[13px]",
};

const iconSizes: Record<ButtonSize, { box: string; icon: number }> = {
  sm: { box: "h-6 w-6", icon: 14 },
  md: { box: "h-7 w-7", icon: 16 },
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({ variant = "ghost", size = "md", className = "", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest} />;
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: LucideIcon;
  /** Used for the tooltip (title) and aria-label. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  const s = iconSizes[size];
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={`${base} ${variants[variant]} ${s.box} ${className}`}
      {...rest}
    >
      <Icon size={s.icon} strokeWidth={1.75} />
    </button>
  );
}
