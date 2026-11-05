// Command palette commands (CONTRACT.md "Command palette", Commands). One pure
// builder per group: it takes the atoms' values and the actions to call, so
// commands.test.ts feeds fixtures and fake actions. index.ts wires the real
// actions; Palette.tsx reads the atoms.
import type { BoardItem, BoardSnapshot, BoardStatus, SearchHit, Session, WorkspaceNode } from "../../lib/ipc";
import type { Tab } from "../tabState";
import type { ThemePref } from "../prefs";
import { panelShortcut } from "../shortcuts";
import type { Preset } from "../theme/presets";
import { tildify } from "../../panels/shared/paths";
import { relativeTime } from "../../panels/shared/format";
import { projectLabel } from "../../panels/sessions/model";
import { snippetText } from "../../panels/sessions/search";
import { entryOf, indexTree, type Registry, type TreeRef } from "../../panels/projects/workspace";
import { isEpic, itemKey, laneOf, repoShort } from "../../panels/board/model";

/** "Transcripts" rows come from session search and are appended after the ranked rows (transcriptCommands). */
export type CommandGroup = "Tabs" | "Panels" | "Projects" | "Sessions" | "Board" | "Themes" | "Transcripts";

export type Command = {
  /** Stable: "tab:<key>", "panel:<id>", "project:<path>", ... (prefs.paletteRecent keeps these). */
  id: string;
  group: CommandGroup;
  /** What is matched and shown. */
  title: string;
  /** Muted, right of the title: path, time, lane. */
  hint?: string;
  /** Extra match terms, not shown. */
  keywords?: string[];
  /** Shown greyed with this reason, not runnable. */
  disabled?: string;
  run: () => void | Promise<void>;
};

/** What the commands do; index.ts passes the real ones, tests pass spies. */
export type PaletteActions = {
  activateTab: (key: string) => void;
  /** Folder picker, then prefs.newTabCommand (as Ctrl+Shift+T). */
  newTab: () => void | Promise<void>;
  /** A login shell in `cwd`. */
  newShellTab: (cwd: string) => void;
  closeTab: (key: string) => void;
  restartTab: (key: string) => void;
  /** Put the tab's rail item into edit mode. */
  renameTab: (key: string) => void;
  openPanel: (id: string) => void;
  toggleSidebar: () => void;
  /** claude in `path`, in a new tab titled `name`. */
  openProject: (path: string, name: string) => void;
  /** The Projects panel's Open with... sheet, related projects checked. */
  openProjectWith: (ref: TreeRef, related: string[]) => void;
  resumeSession: (s: Session) => void;
  setBoardStatus: (item: BoardItem, status: BoardStatus) => void | Promise<unknown>;
  refreshBoard: () => void | Promise<unknown>;
  setTheme: (theme: ThemePref) => void | Promise<void>;
  toggleEffects: () => void | Promise<void>;
  toggleClaudeTheme: () => void | Promise<void>;
};

const NO_TAB = "No tab open";

/** "Switch to <title>" per tab (the active one last), then the tab actions on the active tab. */
export function tabCommands(tabs: Tab[], activeKey: string | null, home: string | undefined, act: PaletteActions): Command[] {
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const ordered = [...tabs.filter((t) => t !== active), ...(active ? [active] : [])];
  const out: Command[] = ordered.map((t) => ({
    id: `tab:${t.key}`,
    group: "Tabs",
    title: `Switch to ${t.title}`,
    hint: tildify(t.cwd, home),
    keywords: [t.title],
    run: () => act.activateTab(t.key),
  }));
  const shellCwd = active?.cwd ?? home ?? "/";
  out.push(
    { id: "tab:new", group: "Tabs", title: "New tab", hint: "Ctrl+Shift+T", run: () => act.newTab() },
    { id: "tab:new-shell", group: "Tabs", title: "New shell tab", hint: tildify(shellCwd, home), keywords: ["terminal", "bash"], run: () => act.newShellTab(shellCwd) },
    {
      id: "tab:close",
      group: "Tabs",
      title: "Close tab",
      hint: active?.title ?? "Ctrl+Shift+W",
      disabled: active ? undefined : NO_TAB,
      run: () => {
        if (active) act.closeTab(active.key);
      },
    },
    {
      id: "tab:restart",
      group: "Tabs",
      title: "Restart tab",
      hint: active?.title,
      disabled: !active ? NO_TAB : active.status !== "dead" ? "Still running" : undefined,
      run: () => {
        if (active) act.restartTab(active.key);
      },
    },
    {
      id: "tab:rename",
      group: "Tabs",
      title: "Rename tab",
      hint: active?.title,
      disabled: active ? undefined : NO_TAB,
      run: () => {
        if (active) act.renameTab(active.key);
      },
    },
  );
  return out;
}

/** "Open <label>" per panel in nav order (hint: its shortcut), then Toggle sidebar. */
export function panelCommands(panels: { id: string; label: string }[], act: PaletteActions): Command[] {
  const out: Command[] = panels.map((p, i) => ({
    id: `panel:${p.id}`,
    group: "Panels",
    title: `Open ${p.label}`,
    hint: panelShortcut(p.id, i) ?? undefined,
    keywords: [p.label],
    run: () => act.openPanel(p.id),
  }));
  out.push({ id: "sidebar:toggle", group: "Panels", title: "Toggle sidebar", hint: "Ctrl+Shift+B", run: () => act.toggleSidebar() });
  return out;
}

/**
 * Every project and subproject in the trees (not roots or groups), in tree
 * order: "Open <name>" (hint: path relative to its root), plus "Open <name>
 * with related" when the registry lists related projects for it.
 */
export function projectCommands(tree: WorkspaceNode[], registry: Registry, act: PaletteActions): Command[] {
  const out: Command[] = [];
  for (const ref of indexTree(tree).values()) {
    const { node } = ref;
    out.push({
      id: `project:${node.path}`,
      group: "Projects",
      title: `Open ${node.name}`,
      hint: ref.rel,
      keywords: [node.name, ref.rel],
      run: () => act.openProject(node.path, node.name),
    });
    const related = entryOf(registry, ref.root, node.path).related;
    if (related.length > 0) {
      out.push({
        id: `project-related:${node.path}`,
        group: "Projects",
        title: `Open ${node.name} with related`,
        hint: ref.rel,
        keywords: [node.name],
        run: () => act.openProjectWith(ref, related),
      });
    }
  }
  return out;
}

/** Sessions the palette lists (the most recent ones). */
export const SESSION_ROWS = 40;

/** "Resume <title>" for the 40 most recent sessions (hint: project and relative time); live ones disabled. */
export function sessionCommands(list: Session[] | null, now: number, home: string | undefined, act: PaletteActions): Command[] {
  if (!list) return [];
  return [...list]
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, SESSION_ROWS)
    .map((s) => {
      const project = projectLabel(s.project, home);
      return {
        id: `session:${s.id}`,
        group: "Sessions" as const,
        title: `Resume ${s.title}`,
        hint: `${project} - ${relativeTime(s.lastTs, now)}`,
        keywords: [project],
        disabled: s.live ? "Already running" : undefined,
        run: () => act.resumeSession(s),
      };
    });
}

/** Transcript hits the palette shows at most. */
export const TRANSCRIPT_ROWS = 5;
/** The palette searches transcripts while a query of this length shows fewer than this many rows. */
export const TRANSCRIPT_BELOW_ROWS = 5;
/** Characters of the snippet shown as the hint. */
const TRANSCRIPT_HINT_CHARS = 60;

/**
 * "Resume <title>" per transcript hit (hint: the snippet start), at most
 * TRANSCRIPT_ROWS. A hit whose session is in `list` resumes that session (and
 * is disabled while it runs); otherwise a session is made from the hit.
 */
export function transcriptCommands(hits: SearchHit[], list: Session[] | null, act: PaletteActions): Command[] {
  const byId = new Map((list ?? []).map((s) => [s.id, s]));
  return hits.slice(0, TRANSCRIPT_ROWS).map((h) => {
    const s: Session = byId.get(h.sessionId) ?? {
      id: h.sessionId,
      project: h.project,
      title: h.title,
      firstTs: null,
      lastTs: h.ts,
      prompts: 0,
      transcriptPath: h.transcriptPath,
      transcriptBytes: 0,
      live: null,
    };
    return {
      id: `transcript:${h.sessionId}`,
      group: "Transcripts" as const,
      title: `Resume ${h.title}`,
      hint: snippetText(h.snippet, TRANSCRIPT_HINT_CHARS),
      disabled: s.live ? "Already running" : undefined,
      run: () => act.resumeSession(s),
    };
  });
}

const MOVES: { from: BoardStatus; verb: string; to: BoardStatus }[] = [
  { from: "Ready", verb: "Start", to: "In progress" },
  { from: "In progress", verb: "Review", to: "In review" },
  { from: "In progress", verb: "Finish", to: "Done" },
  { from: "In review", verb: "Finish", to: "Done" },
];

/**
 * Lane moves for tasks (Start a Ready task, Review or Finish one In progress,
 * Finish one In review; hint repo#number) and Refresh board. Nothing without a
 * connected board and a snapshot.
 */
export function boardCommands(connected: boolean, snapshot: BoardSnapshot | null, act: PaletteActions): Command[] {
  if (!connected || !snapshot) return [];
  const out: Command[] = [];
  for (const m of MOVES) {
    for (const i of snapshot.items) {
      if (isEpic(i) || laneOf(i) !== m.from) continue;
      out.push({
        id: `board:${m.verb.toLowerCase()}:${i.itemId}`,
        group: "Board",
        title: `${m.verb} ${i.title}`,
        hint: `${repoShort(i.repo)}#${i.number}`,
        keywords: [i.title, itemKey(i.repo, i.number)],
        run: async () => {
          await act.setBoardStatus(i, m.to);
        },
      });
    }
  }
  out.push({
    id: "board:refresh",
    group: "Board",
    title: "Refresh board",
    run: async () => {
      await act.refreshBoard();
    },
  });
  return out;
}

export type ThemeState = { theme: ThemePref; effects: boolean; claudeTheme: boolean };

const onOff = (v: boolean) => (v ? "on" : "off");

/** "Theme: <name>" per source and preset (the active one hinted), Toggle visual effects, Toggle Claude Code theme. */
export function themeCommands(state: ThemeState, presets: Pick<Preset, "id" | "name">[], act: PaletteActions): Command[] {
  const sources: { value: ThemePref; name: string }[] = [
    { value: "system", name: "Match system" },
    { value: "dark", name: "Dark" },
    { value: "light", name: "Light" },
    { value: "omarchy", name: "Follow Omarchy" },
    ...presets.map((p) => ({ value: `preset:${p.id}` as ThemePref, name: p.name })),
  ];
  const out: Command[] = sources.map((s) => ({
    id: `theme:${s.value}`,
    group: "Themes",
    title: `Theme: ${s.name}`,
    hint: s.value === state.theme ? "active" : undefined,
    keywords: [s.name],
    run: () => act.setTheme(s.value),
  }));
  out.push(
    { id: "theme:effects", group: "Themes", title: "Toggle visual effects", hint: onOff(state.effects), keywords: ["glow", "scanlines"], run: () => act.toggleEffects() },
    { id: "theme:claude", group: "Themes", title: "Toggle Claude Code theme", hint: onOff(state.claudeTheme), run: () => act.toggleClaudeTheme() },
  );
  return out;
}

export type PaletteInput = {
  tabs: Tab[];
  activeKey: string | null;
  home?: string;
  panels: { id: string; label: string }[];
  tree: WorkspaceNode[];
  registry: Registry;
  /** null while not loaded. */
  sessions: Session[] | null;
  now: number;
  boardConnected: boolean;
  snapshot: BoardSnapshot | null;
  theme: ThemeState;
  presets: Pick<Preset, "id" | "name">[];
};

/** Every command, groups in order (Tabs, Panels, Projects, Sessions, Board, Themes). */
export function buildCommands(input: PaletteInput, act: PaletteActions): Command[] {
  return [
    ...tabCommands(input.tabs, input.activeKey, input.home, act),
    ...panelCommands(input.panels, act),
    ...projectCommands(input.tree, input.registry, act),
    ...sessionCommands(input.sessions, input.now, input.home, act),
    ...boardCommands(input.boardConnected, input.snapshot, act),
    ...themeCommands(input.theme, input.presets, act),
  ];
}
