// Pure helpers between an MCP server config object and the inline form.
import type { McpScope } from "../../lib/ipc";

export type Transport = "stdio" | "http" | "sse";

export type McpForm = {
  name: string;
  scope: McpScope;
  project: string;
  type: Transport;
  command: string;
  args: string; // one per line
  env: string; // KEY=VALUE lines
  url: string;
  headers: string; // "Name: value" lines
};

const KNOWN = ["type", "command", "args", "env", "url", "headers"];

export function transportOf(config: Record<string, unknown>): string {
  if (typeof config.type === "string") return config.type;
  if (typeof config.command === "string") return "stdio";
  if (typeof config.url === "string") return "http";
  return "?";
}

export function summaryOf(config: Record<string, unknown>): string {
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    return [config.command, ...args].join(" ");
  }
  if (typeof config.url === "string") return config.url;
  return "";
}

function recordLines(v: unknown, sep: string): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k}${sep}${typeof x === "string" ? x : JSON.stringify(x)}`)
    .join("\n");
}

export function parseLines(text: string, sep: "=" | ":"): { value: Record<string, string>; error: string | null } {
  const value: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(sep);
    if (at <= 0) return { value, error: `Line ${i + 1}: expected ${sep === "=" ? "KEY=VALUE" : "Name: value"}` };
    value[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { value, error: null };
}

export function formFromConfig(name: string, scope: McpScope, project: string, config: Record<string, unknown>): McpForm {
  const t = transportOf(config);
  return {
    name,
    scope,
    project,
    type: t === "http" || t === "sse" ? t : "stdio",
    command: typeof config.command === "string" ? config.command : "",
    args: Array.isArray(config.args) ? config.args.map(String).join("\n") : "",
    env: recordLines(config.env, "="),
    url: typeof config.url === "string" ? config.url : "",
    headers: recordLines(config.headers, ": "),
  };
}

/** Build the config object. Unknown keys from `original` are kept after the known ones. */
export function configFromForm(f: McpForm, original: Record<string, unknown> = {}): { config: Record<string, unknown>; error: string | null } {
  const extra = Object.fromEntries(Object.entries(original).filter(([k]) => !KNOWN.includes(k)));
  if (f.type === "stdio") {
    if (!f.command.trim()) return { config: {}, error: "Command is required for stdio" };
    const env = parseLines(f.env, "=");
    if (env.error) return { config: {}, error: `Env ${env.error}` };
    const config: Record<string, unknown> = {
      type: "stdio",
      command: f.command.trim(),
      args: f.args.split("\n").map((a) => a.trim()).filter(Boolean),
    };
    if (Object.keys(env.value).length || "env" in original) config.env = env.value;
    return { config: { ...config, ...extra }, error: null };
  }
  if (!f.url.trim()) return { config: {}, error: "URL is required for http and sse" };
  const headers = parseLines(f.headers, ":");
  if (headers.error) return { config: {}, error: `Headers ${headers.error}` };
  const config: Record<string, unknown> = { type: f.type, url: f.url.trim() };
  if (Object.keys(headers.value).length || "headers" in original) config.headers = headers.value;
  return { config: { ...config, ...extra }, error: null };
}

export const emptyForm = (): McpForm => ({
  name: "",
  scope: "user",
  project: "",
  type: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
});
