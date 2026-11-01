import type { BoardItem, BoardStatus } from "../../lib/ipc";
import { cx } from "../ui";
import { laneOf } from "./model";

const DOT: Record<BoardStatus, string> = {
  Backlog: "bg-fg-muted/60",
  Ready: "bg-accent",
  "In progress": "bg-warn",
  "In review": "bg-[var(--t-magenta)]",
  Done: "bg-ok",
};

/** A small dot in the lane's colour, with the lane as tooltip. */
export function StatusDot({ item, className }: { item: BoardItem; className?: string }) {
  const lane = laneOf(item);
  return <span title={lane} aria-label={lane} className={cx("inline-block h-2 w-2 shrink-0 rounded-full", DOT[lane], className)} />;
}
