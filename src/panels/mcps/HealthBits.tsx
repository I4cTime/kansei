// MCP health pieces for the server rows (CONTRACT.md "MCP health"): the 7 px
// status dot, the "checking" badge, the per-row Check button and the
// expandable failure detail.
import { useState } from "react";
import { useAtomValue } from "jotai";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { Badge, IconButton, cx } from "../ui";
import { checkServers, checkingAtom, detailOf, dotTitle, dotTone, healthAtom, healthKey, isStale, type DotTone, type McpHealthTarget } from "./health";

const TONE: Record<DotTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-fg-muted",
};

export function HealthDot({ k }: { k: string }) {
  const h = useAtomValue(healthAtom)[k];
  const now = Date.now();
  const tone = dotTone(h, now);
  return (
    <span
      data-health={h?.status ?? "none"}
      data-health-stale={h && isStale(h, now) ? "" : undefined}
      title={dotTitle(h, now)}
      className={cx("inline-block h-[7px] w-[7px] shrink-0 rounded-full", TONE[tone], !h && "opacity-50")}
    />
  );
}

export function CheckingBadge({ k }: { k: string }) {
  const on = useAtomValue(checkingAtom)[k];
  return on ? (
    <span data-health-checking="" className="contents">
      <Badge>checking</Badge>
    </span>
  ) : null;
}

export function CheckButton({ target }: { target: McpHealthTarget }) {
  const key = healthKey(target);
  const busy = !!useAtomValue(checkingAtom)[key];
  return <IconButton icon={Activity} title={busy ? `Checking ${target.name}` : `Check ${target.name}`} disabled={busy} onClick={() => void checkServers([target])} />;
}

/** For failed and timeout results: the first line, expandable to the detail (6 lines, then scroll). */
export function HealthDetail({ k }: { k: string }) {
  const h = useAtomValue(healthAtom)[k];
  const [open, setOpen] = useState(false);
  const detail = detailOf(h);
  if (!h || !detail) return null;
  const stale = isStale(h, Date.now());
  const first = detail.split("\n").find((l) => l.trim()) ?? detail;
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="px-3 pb-1.5 pl-[23px]" data-health-detail={k}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? "Hide the detail" : "Show the detail"}
        className={cx("flex w-full min-w-0 cursor-pointer items-center gap-1 text-left text-[11px] hover:text-fg", stale ? "text-fg-muted" : "text-danger")}
      >
        <Icon size={11} className="shrink-0" />
        <span className="min-w-0 truncate font-mono">{h.status === "timeout" ? `timed out: ${first}` : first}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-[104px] overflow-auto whitespace-pre-wrap break-words rounded-ui border border-border bg-bg-sunken px-1.5 py-1 font-mono text-[11px] leading-4 text-fg">
          {detail}
        </pre>
      )}
    </div>
  );
}
