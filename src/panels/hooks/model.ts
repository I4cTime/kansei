// Pure model for settings.json `hooks`.
// Shape: { [event]: [{ matcher?: string, hooks: [{ type: "command", command, timeout? }] }] }

export const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
] as const;

export const EVENT_INFO: Record<string, { about: string; matcher?: string }> = {
  PreToolUse: { about: "Before a tool runs. Exit code 2 blocks the call.", matcher: "Tool name or regex, e.g. Bash or Edit|Write. Empty matches every tool." },
  PostToolUse: { about: "After a tool call succeeds.", matcher: "Tool name or regex. Empty matches every tool." },
  PermissionRequest: { about: "When a permission dialog would be shown.", matcher: "Tool name or regex. Empty matches every tool." },
  Notification: { about: "When Claude Code sends a notification.", matcher: "Notification type, e.g. permission_prompt or idle_prompt. Empty matches all." },
  UserPromptSubmit: { about: "When you submit a prompt, before Claude sees it." },
  Stop: { about: "When the main agent finishes responding." },
  SubagentStop: { about: "When a subagent finishes." },
  SessionStart: { about: "When a session starts or resumes.", matcher: "startup, resume, clear or compact. Empty matches all." },
  SessionEnd: { about: "When a session ends.", matcher: "Reason, e.g. clear, logout or other. Empty matches all." },
  PreCompact: { about: "Before the context is compacted.", matcher: "manual or auto. Empty matches both." },
};

export type HookEntry = { type: string; command?: string; timeout?: number; [k: string]: unknown };
export type MatcherGroup = { matcher?: string; hooks: HookEntry[]; [k: string]: unknown };
export type HooksMap = Record<string, MatcherGroup[]>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate and copy the raw `hooks` value. Throws when the shape is not editable here. */
export function readHooks(raw: unknown): HooksMap {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw new Error("settings.json hooks is not an object; use Raw to fix it");
  const out: HooksMap = {};
  for (const [event, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not an array; use Raw to fix it`);
    out[event] = groups.map((g, i) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) throw new Error(`hooks.${event}[${i}] has no hooks array; use Raw to fix it`);
      return {
        ...g,
        hooks: g.hooks.map((h, j) => {
          if (!isObj(h) || typeof h.type !== "string") throw new Error(`hooks.${event}[${i}].hooks[${j}] has no type; use Raw to fix it`);
          return { ...h } as HookEntry;
        }),
      } as MatcherGroup;
    });
  }
  return out;
}

/** Drop empty matchers, empty groups and empty events; normalise timeouts. */
export function cleanHooks(h: HooksMap): HooksMap {
  const out: HooksMap = {};
  for (const [event, groups] of Object.entries(h)) {
    const gs = groups
      .map((g) => {
        const { matcher, hooks, ...rest } = g;
        const entries = hooks.map((e) => {
          const x: HookEntry = { ...e };
          if (x.type === "command") x.command = (x.command ?? "").trim();
          if (x.timeout === undefined || x.timeout === null || Number.isNaN(x.timeout) || (x.timeout as number) <= 0) delete x.timeout;
          return x;
        }).filter((e) => e.type !== "command" || e.command);
        const m = (matcher ?? "").trim();
        return { ...(m ? { matcher: m } : {}), hooks: entries, ...rest } as MatcherGroup;
      })
      .filter((g) => g.hooks.length > 0);
    if (gs.length) out[event] = gs;
  }
  return out;
}

/** Return a new settings object with `hooks` replaced, keeping every other key and the key order. */
export function applyHooks(settings: Record<string, unknown>, hooks: HooksMap): Record<string, unknown> {
  const clean = cleanHooks(hooks);
  const empty = Object.keys(clean).length === 0;
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(settings)) {
    if (k === "hooks") {
      if (!empty) out.hooks = clean;
      placed = true;
    } else out[k] = v;
  }
  if (!placed && !empty) out.hooks = clean;
  return out;
}

export const sameHooks = (a: HooksMap, b: HooksMap) => JSON.stringify(cleanHooks(a)) === JSON.stringify(cleanHooks(b));
