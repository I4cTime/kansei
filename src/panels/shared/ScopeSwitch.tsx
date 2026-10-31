// User | Project segmented control for panels with a project scope
// (CONTRACT.md "Project scope"). The choice lives in the panel's own state.
import { useState } from "react";
import { useAtomValue } from "jotai";
import { projectAtom } from "../../app/project";
import type { ProjectInfo } from "../../lib/ipc";
import { cx } from "../ui";
import { usePaths } from "./hooks";
import { basename, tildify } from "./paths";

export type Scope = "user" | "project";

/**
 * Per-panel scope state. `scope` is the effective scope: it falls back to
 * "user" while there is no project, without forgetting the choice.
 */
export function useScope(): { scope: Scope; choice: Scope; setScope: (s: Scope) => void; project: ProjectInfo | null } {
  const project = useAtomValue(projectAtom);
  const [choice, setScope] = useState<Scope>("user");
  return { scope: project ? choice : "user", choice, setScope, project };
}

export function ScopeSwitch({ value, onChange, project }: { value: Scope; onChange: (s: Scope) => void; project: ProjectInfo | null }) {
  const paths = usePaths();
  const label = project ? basename(project.root) || "/" : "Project";
  const items: { id: Scope; label: string; title: string; disabled?: boolean }[] = [
    { id: "user", label: "User", title: "Your files in ~/.claude" },
    { id: "project", label, title: project ? `Project files in ${project.root}` : "Open a tab first", disabled: !project },
  ];
  return (
    <div className="px-3 pt-2">
      <div role="radiogroup" aria-label="Scope" className="flex rounded-ui border border-border bg-bg-sunken p-0.5">
        {items.map((it) => {
          const on = value === it.id;
          return (
            <button
              key={it.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={it.title}
              // aria-disabled instead of disabled so the "Open a tab first" tooltip still shows.
              aria-disabled={it.disabled || undefined}
              onClick={() => !it.disabled && onChange(it.id)}
              className={cx(
                "min-w-0 flex-1 truncate rounded-ui px-2 py-0.5 text-xs font-medium cursor-pointer",
                "aria-disabled:opacity-40 aria-disabled:cursor-default",
                on ? "bg-bg-raised text-fg shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {it.label}
            </button>
          );
        })}
      </div>
      {value === "project" && project && (
        <div className="truncate pt-1 font-mono text-[11px] text-fg-muted" title={project.root}>
          {tildify(project.root, paths?.home)}
        </div>
      )}
    </div>
  );
}
