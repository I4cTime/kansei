// Tiny frontmatter parser. Reads a leading `---` block of YAML-ish lines into a
// flat record. Nested maps flatten to dotted keys (`metadata.type`), lists join
// with ", ", block scalars (`>` / `|`) fold their indented lines. Pure, no deps.

export type Frontmatter = {
  data: Record<string, string>;
  body: string;
  /** True when a leading `---` block was found. */
  present: boolean;
};

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  // inline list: [a, b]
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => unquote(x))
      .filter(Boolean)
      .join(", ");
  }
  return s;
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, present: false };
  const lines = m[1].split(/\r?\n/);
  const body = src.slice(m[0].length);
  const data: Record<string, string> = {};
  // stack of [indent, keyPrefix]
  const stack: { indent: number; prefix: string }[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop();
    const prefix = stack.length ? stack[stack.length - 1].prefix : "";
    const kv = /^[ \t]*([^:#][^:]*?)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = prefix + kv[1].trim().replace(/^["']|["']$/g, "");
    const raw = (kv[2] ?? "").trim();

    if (raw === "") {
      // nested map, list, or empty value: decide from the next non-empty line
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j] : undefined;
      if (next !== undefined && /^[ \t]*- /.test(next) && indentOf(next) >= ind) {
        const items: string[] = [];
        let k = j;
        while (k < lines.length) {
          const l = lines[k];
          if (!l.trim()) {
            k++;
            continue;
          }
          const lm = /^[ \t]*- (.*)$/.exec(l);
          if (!lm || indentOf(l) < ind) break;
          items.push(unquote(lm[1]));
          k++;
        }
        data[key] = items.join(", ");
        i = k;
        continue;
      }
      if (next !== undefined && indentOf(next) > ind) {
        stack.push({ indent: ind, prefix: key + "." });
      } else {
        data[key] = "";
      }
      i++;
      continue;
    }

    if (/^[>|][+-]?\d*$/.test(raw)) {
      const folded = raw[0] === ">";
      const parts: string[] = [];
      let k = i + 1;
      while (k < lines.length && (!lines[k].trim() || indentOf(lines[k]) > ind)) {
        parts.push(lines[k].trim());
        k++;
      }
      while (parts.length && !parts[parts.length - 1]) parts.pop();
      data[key] = folded ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n");
      i = k;
      continue;
    }

    data[key] = unquote(raw);
    i++;
  }
  return { data, body, present: true };
}
