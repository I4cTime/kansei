// Claude Code rules: Markdown files under ~/.claude/rules or <project>/.claude/rules,
// nested folders allowed. Optional frontmatter `paths:` (a list of globs, or one
// string) limits a rule to matching files; without it the rule always loads.
import { files } from "../../lib/ipc";
import { parseFrontmatter, splitInline } from "../shared/frontmatter";
import { slugify } from "../shared/paths";

export type Rule = {
  path: string;
  /** Path relative to the rules dir without `.md`, e.g. `frontend/react`. */
  name: string;
  summary: string;
  globs: string[];
  /** A leading `---` block that never closes. Treated as no paths. */
  failed: boolean;
  unreadable: boolean;
  modifiedMs: number;
};

const SUMMARY_MAX = 100;
const MAX_DEPTH = 8;

/** Globs, summary line and parse failure for one rule file's text. Pure. */
export function parseRule(text: string): { globs: string[]; summary: string; failed: boolean } {
  const src = text.replace(/^﻿/, "");
  const fm = parseFrontmatter(src);
  const failed = !fm.present && /^---[ \t]*\r?\n/.test(src);
  let globs: string[] = [];
  if (!failed) {
    const list = fm.lists.paths;
    if (list) globs = list;
    else if (fm.data.paths) globs = splitInline(fm.data.paths).map((g) => g.trim());
  }
  globs = [...new Set(globs.filter(Boolean))];
  // An unclosed block: skip the `---` line and the YAML lines up to the first blank line.
  const body = failed ? src.replace(/^---[ \t]*\r?\n(?:[^\n]*\S[^\n]*\r?\n)*/, "") : fm.body;
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && l !== "---") ?? "";
  const summary = line.length > SUMMARY_MAX ? line.slice(0, SUMMARY_MAX - 3).trimEnd() + "..." : line;
  return { globs, summary, failed };
}

/** "Frontend/React Hooks.md" -> "frontend/react-hooks". Empty when nothing usable is left. */
export function ruleSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\.md$/i, "")
    .split("/")
    .map(slugify)
    .filter(Boolean)
    .join("/");
}

export function ruleTemplate(name: string): string {
  return `---
paths:
  - "src/**/*.ts"
---

# ${name}

Describe the rule. Remove the paths block to apply it to every file.
`;
}

async function walk(dir: string, rel: string, depth: number, out: { path: string; name: string; modifiedMs: number }[]) {
  // Subfolders that cannot be listed (a symlink leaving the allowlist) are skipped.
  const entries = depth === 0 ? await files.list(dir) : await files.list(dir).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDir) {
      if (depth < MAX_DEPTH) await walk(e.path, r, depth + 1, out);
    } else if (e.name.toLowerCase().endsWith(".md")) {
      out.push({ path: e.path, name: r.replace(/\.md$/i, ""), modifiedMs: e.modifiedMs });
    }
  }
}

/** Every `*.md` below `dir` (recursive, symlinks followed), read and parsed, sorted by name. */
export async function loadRules(dir: string): Promise<Rule[]> {
  const found: { path: string; name: string; modifiedMs: number }[] = [];
  await walk(dir, "", 0, found);
  const rules = await Promise.all(
    found.map(async (f): Promise<Rule> => {
      try {
        const text = await files.readText(f.path);
        return { ...f, ...parseRule(text), unreadable: false };
      } catch {
        return { ...f, summary: "", globs: [], failed: false, unreadable: true };
      }
    }),
  );
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}
