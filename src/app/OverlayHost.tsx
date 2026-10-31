// Renders the overlay atom's node over the terminal column. The node sits in an
// absolutely positioned flex box (inset 0, 16 px padding) above a dim backdrop;
// give the sheet root `flex-1 min-w-0 min-h-0` (or w-full h-full) to fill it.
// Esc or a backdrop click closes it unless onEscape returns false.
import { useAtomValue } from "jotai";
import { overlayAtom } from "../lib/overlay";
import { dismissOverlay } from "./keyboard";

export function OverlayHost() {
  const overlay = useAtomValue(overlayAtom);
  if (!overlay) return null;
  return (
    <div className="absolute inset-0 z-30">
      <div className="absolute inset-0 bg-black/45" aria-hidden />
      <div
        className="absolute inset-0 flex p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) dismissOverlay();
        }}
      >
        {overlay.node}
      </div>
    </div>
  );
}
