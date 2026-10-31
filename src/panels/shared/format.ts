// Small display formatters shared by the panels (times, sizes, counts).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Oct", "12 Oct 2025". */
export function relativeTime(ts: number, now: number): string {
  if (!ts) return "unknown";
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)} min ago`;
  const today = startOfDay(now);
  // Today, or late last night: hours. Earlier yesterday: "yesterday".
  if (ts >= today || diff < 12 * hour) return `${Math.floor(diff / hour)} h ago`;
  if (ts >= startOfDay(today - 1)) return "yesterday";
  const d = new Date(ts);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Full local date and time for tooltips. */
export function absoluteTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "512 B", "3.4 KB", "120 KB", "2.1 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
