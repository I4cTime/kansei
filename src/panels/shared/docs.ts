// Load a directory of frontmatter documents (agents, memories, workflows).
import { files, type Entry } from "../../lib/ipc";
import { parseFrontmatter } from "./frontmatter";

export type Doc = {
  path: string;
  file: string;
  meta: Record<string, string>;
  modifiedMs: number;
  /** first non-empty body line, for files without a description */
  firstLine: string;
};

export async function listDir(dir: string): Promise<Entry[]> {
  if (!(await files.exists(dir))) return [];
  return files.list(dir);
}

export async function readDoc(e: Pick<Entry, "path" | "name" | "modifiedMs">): Promise<Doc> {
  let meta: Record<string, string> = {};
  let firstLine = "";
  try {
    const text = await files.readText(e.path);
    const fm = parseFrontmatter(text);
    meta = fm.data;
    firstLine = fm.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("//") && !l.startsWith("/*")) ?? "";
  } catch {
    // unreadable file still lists by name
  }
  return { path: e.path, file: e.name, meta, modifiedMs: e.modifiedMs, firstLine };
}

/** All files in `dir` with one of `exts`, read and parsed, sorted by name. */
export async function loadDocs(dir: string, exts: string[], exclude: string[] = []): Promise<Doc[]> {
  const entries = (await listDir(dir)).filter((e) => !e.isDir && exts.some((x) => e.name.endsWith(x)) && !exclude.includes(e.name));
  const docs = await Promise.all(entries.map(readDoc));
  return docs.sort((a, b) => (a.meta.name || a.file).localeCompare(b.meta.name || b.file));
}

export function matches(q: string, ...fields: (string | undefined)[]): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return fields.some((f) => f?.toLowerCase().includes(s));
}
