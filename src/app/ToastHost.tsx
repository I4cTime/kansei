import { useAtom } from "jotai";
import { CircleAlert, Info } from "lucide-react";
import { toastsAtom } from "../lib/overlay";

export function ToastHost() {
  const [toasts, setToasts] = useAtom(toastsAtom);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-[340px] max-w-[calc(100vw-24px)] flex-col gap-2">
      {toasts.map((t) => {
        const error = t.kind === "error";
        const Icon = error ? CircleAlert : Info;
        return (
          <div
            key={t.id}
            role={error ? "alert" : "status"}
            title="Click to dismiss"
            onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}
            className={`pointer-events-auto flex cursor-default items-start gap-2 rounded-ui border bg-bg-raised px-3 py-2 text-xs shadow-lg shadow-black/30 ${
              error ? "border-danger/50 text-danger" : "border-border text-fg"
            }`}
          >
            <Icon size={14} strokeWidth={2} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
