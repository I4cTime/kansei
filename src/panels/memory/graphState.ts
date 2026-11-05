// Memory graph state (CONTRACT.md "Memory graph"): the last memory_graph result
// and its reload. The layout is cached by the graph's content hash in graph.ts.
import { atom } from "jotai";
import { memory, type MemoryGraph } from "../../lib/ipc";
import { store, toastError } from "../../app/store";

/** The last graph read; null until the graph view first loads it. */
export const graphAtom = atom<MemoryGraph | null>(null);
/** True while memory_graph runs. */
export const graphLoadingAtom = atom(false);

let inflight: Promise<MemoryGraph | null> | null = null;

/** Read every memory dir again (memory_graph) and update graphAtom. Read only. */
export function reload(): Promise<MemoryGraph | null> {
  if (inflight) return inflight;
  store.set(graphLoadingAtom, true);
  inflight = memory
    .graph()
    .then((g) => {
      store.set(graphAtom, g);
      return g;
    })
    .catch((e) => {
      toastError(e, "Could not read the memory graph");
      return null;
    })
    .finally(() => {
      inflight = null;
      store.set(graphLoadingAtom, false);
    });
  return inflight;
}
