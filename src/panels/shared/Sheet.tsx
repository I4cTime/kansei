// Small dialog-style sheets in the overlay host (the editor sheet's smaller
// sibling): a centred card with a header, a scrolling body and a footer.
// Esc or a backdrop click closes them (the shell handles both).
import { Fragment, type ReactNode } from "react";
import { X } from "lucide-react";
import { overlayAtom } from "../../lib/overlay";
import { store, toastError } from "../../app/store";
import { IconButton } from "../ui";

let seq = 0;

/**
 * Show `render(close)` as the overlay. Refuses (and returns false) while another
 * overlay is open, so an editor with unsaved changes is never replaced.
 */
export function openSheet(render: (close: () => void) => ReactNode): boolean {
  if (store.get(overlayAtom)) {
    toastError("Close the open sheet first");
    return false;
  }
  const key = `sheet-${++seq}`;
  let node: ReactNode = null;
  const close = () => {
    if (store.get(overlayAtom)?.node === node) store.set(overlayAtom, null);
  };
  node = <Fragment key={key}>{render(close)}</Fragment>;
  store.set(overlayAtom, { node, onEscape: () => true });
  return true;
}

export function Sheet({
  title,
  subtitle,
  onClose,
  footer,
  children,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className={`m-auto flex max-h-full min-h-0 w-full ${wide ? "max-w-2xl" : "max-w-md"} flex-col overflow-hidden rounded-ui border border-border bg-bg shadow-2xl`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-bg-raised px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{title}</div>
          {subtitle && <div className="truncate font-mono text-[11px] text-fg-muted">{subtitle}</div>}
        </div>
        <IconButton icon={X} title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="flex items-center justify-end gap-1.5 border-t border-border bg-bg-raised px-3 py-2">{footer}</div>}
    </div>
  );
}
