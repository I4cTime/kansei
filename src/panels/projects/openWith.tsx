// The Projects panel's "Open with..." action as a function, so the command
// palette's "Open <name> with related" opens the same sheet.
import { CLAUDE, openTab } from "../../app/tabs";
import { openSheet } from "../shared/Sheet";
import { tildify } from "../shared/paths";
import { PickerSheet } from "./sheets";
import type { PickItem } from "./workspace";

/**
 * Pick projects to pass as `claude --add-dir` and open `path` in a new Claude
 * tab titled `label`. `items` minus `exclude` (the project itself and its
 * aliases) are offered; the `related` ones start checked.
 */
export function openWithSheet(a: { path: string; label: string; items: PickItem[]; exclude: (string | undefined)[]; related: string[]; home?: string }): boolean {
  const own = new Set(a.exclude);
  const choices = a.items.filter((it) => !own.has(it.path));
  return openSheet((close) => (
    <PickerSheet
      title={`Open ${a.label} with...`}
      subtitle={`claude --add-dir for each checked project, in ${tildify(a.path, a.home)}`}
      items={choices}
      initial={a.related.filter((p) => choices.some((c) => c.path === p))}
      confirmLabel="Open"
      note="Related projects start checked. The new tab runs claude even when new tabs default to a shell."
      onConfirm={(paths) => {
        openTab({ cwd: a.path, command: CLAUDE, args: paths.flatMap((p) => ["--add-dir", p]), title: a.label });
      }}
      close={close}
    />
  ));
}
