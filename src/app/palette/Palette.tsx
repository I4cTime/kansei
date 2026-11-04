// The command palette sheet (CONTRACT.md "Command palette", UI): 560 px wide,
// 10 % down the terminal column, at most 60 % of its height. One input, the
// ranked rows under it. Up/Down move (disabled rows skipped), Enter or a click
// runs; Esc and the backdrop close it through the overlay host.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { sessions as sessionsIpc, type Session } from "../../lib/ipc";
import { boardConfigAtom, snapshotAtom } from "../../panels/board/model";
import { registryAtom, treeAtom } from "../../panels/projects/workspaceStore";
import { sessionsListAtom } from "../../panels/sessions/model";
import { TextInput, cx } from "../../panels/ui";
import { prefsAtom } from "../prefs";
import { getPaths, store, toastError } from "../store";
import { activeKeyAtom, tabsAtom } from "../tabState";
import { focusTerminal } from "../terminals";
import { overlayAtom } from "../../lib/overlay";
import type { Command } from "./commands";
import { rank } from "./fuzzy";
import { commandsNow, runCommand, setPaletteHome } from "./index";

/** Index of the next enabled row from `from` in direction `dir` (wrapping), or -1. */
function step(rows: Command[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!rows[i].disabled) return i;
  }
  return -1;
}

export function Palette() {
  const tabs = useAtomValue(tabsAtom);
  const activeKey = useAtomValue(activeKeyAtom);
  const prefs = useAtomValue(prefsAtom);
  const tree = useAtomValue(treeAtom);
  const registry = useAtomValue(registryAtom);
  const snapshot = useAtomValue(snapshotAtom);
  const boardConfig = useAtomValue(boardConfigAtom);
  const shared = useAtomValue(sessionsListAtom);
  const [home, setHome] = useState<string | undefined>(undefined);
  const [fetched, setFetched] = useState<Session[] | null>(null);
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getPaths().then(
      (p) => {
        setPaletteHome(p.home);
        if (live) setHome(p.home);
      },
      () => {},
    );
    // The Sessions panel's list when it has one; otherwise fetch once for this palette.
    if (!store.get(sessionsListAtom)) {
      sessionsIpc.list().then(
        (l) => live && setFetched(l),
        (e) => live && toastError(e, "Could not list sessions"),
      );
    }
    return () => {
      live = false;
      // Closed without moving focus anywhere (Esc, backdrop): back to the terminal.
      requestAnimationFrame(() => {
        const key = store.get(activeKeyAtom);
        const idle = !document.activeElement || document.activeElement === document.body;
        if (key && idle && !store.get(overlayAtom)) focusTerminal(key);
      });
    };
  }, []);

  const commands = useMemo(
    () => commandsNow(fetched),
    // commandsNow reads these atoms from the store; they are listed so the rows follow them.
    [tabs, activeKey, prefs.theme, prefs.effects, prefs.claudeTheme, tree, registry, snapshot, boardConfig, shared, fetched, home],
  );
  const rows = useMemo(() => rank(commands, query, prefs.paletteRecent), [commands, query, prefs.paletteRecent]);

  const found = selId ? rows.findIndex((r) => r.id === selId && !r.disabled) : -1;
  const sel = found >= 0 ? found : rows.length ? step(rows, -1, 1) : -1;

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-palette-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const move = (dir: 1 | -1) => {
    if (rows.length === 0) return;
    const i = step(rows, sel < 0 ? (dir === 1 ? -1 : 0) : sel, dir);
    if (i >= 0) setSelId(rows[i].id);
  };

  return (
    <div className="pointer-events-none relative min-h-0 min-w-0 flex-1">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-palette
        className="pointer-events-auto absolute left-1/2 top-[10%] flex max-h-[60%] w-[560px] max-w-full -translate-x-1/2 flex-col overflow-hidden rounded-ui border border-border bg-bg shadow-2xl"
      >
        <div className="border-b border-border bg-bg-raised p-2">
          <TextInput
            autoFocus
            data-palette-input
            placeholder="Type a command"
            aria-label="Type a command"
            aria-controls="palette-list"
            aria-activedescendant={sel >= 0 ? `palette-row-${sel}` : undefined}
            className="py-1.5 text-[13px]"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (sel >= 0) runCommand(rows[sel]);
              }
            }}
          />
        </div>
        <div ref={list} id="palette-list" role="listbox" aria-label="Commands" data-palette-list className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 && <div className="px-3 py-2 text-xs text-fg-muted">No matching commands</div>}
          {rows.map((c, i) => (
            <Row key={c.id} c={c} index={i} selected={i === sel} onRun={() => runCommand(c)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ c, index, selected, onRun }: { c: Command; index: number; selected: boolean; onRun: () => void }) {
  return (
    <div
      id={`palette-row-${index}`}
      role="option"
      aria-selected={selected}
      aria-disabled={c.disabled ? true : undefined}
      data-palette-index={index}
      data-palette-id={c.id}
      title={c.disabled ?? undefined}
      // Keep focus in the input.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!c.disabled) onRun();
      }}
      className={cx(
        "flex min-w-0 items-baseline gap-2 px-3 py-1 text-[12.5px]",
        c.disabled ? "cursor-default opacity-50" : "cursor-pointer",
        selected ? "bg-accent/15 text-fg shadow-[inset_2px_0_0_var(--color-accent)]" : !c.disabled && "hover:bg-bg-hover",
      )}
    >
      <span data-palette-title className="min-w-0 shrink truncate text-fg">
        {c.title}
      </span>
      {(c.disabled || c.hint) && (
        <span data-palette-hint className={cx("min-w-0 flex-1 truncate text-[11px]", c.disabled ? "text-warn" : "text-fg-muted")}>
          {c.disabled ?? c.hint}
        </span>
      )}
      {!c.disabled && !c.hint && <span className="flex-1" />}
      <span data-palette-group className={cx("shrink-0 text-[11px]", selected ? "text-accent" : "text-fg-muted")}>
        {c.group}
      </span>
    </div>
  );
}
