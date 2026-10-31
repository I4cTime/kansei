// Path helpers. Paths from the backend are absolute POSIX paths.

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .join("/");
}

export function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export function dirname(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "/";
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

/** Replace the home prefix with `~` for display. */
export function tildify(p: string, home: string | undefined): string {
  if (!home) return p;
  const h = home.replace(/\/+$/, "");
  if (p === h) return "~";
  return p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

/** lower-case, a-z0-9 and single hyphens. */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
