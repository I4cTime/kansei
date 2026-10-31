// CodeMirror 6 wrapper themed from the design tokens (CSS variables), so it
// follows dark/light without rebuilding the view.
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { yaml } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import { extname } from "./paths";

export type Lang = "markdown" | "json" | "javascript" | "yaml" | "text";

export function langForPath(path: string): Lang {
  switch (extname(path)) {
    case "md":
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "js":
    case "mjs":
    case "cjs":
    case "ts":
      return "javascript";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "text";
  }
}

function langExt(lang: Lang): Extension {
  switch (lang) {
    case "markdown":
      return markdown();
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

const tokenTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--fg)", height: "100%", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--bg-sunken)", color: "var(--fg-muted)", border: "none", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent) !important",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { color: "var(--fg)" },
  ".cm-textfield": { backgroundColor: "var(--bg-sunken)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", border: "none", color: "var(--fg-muted)" },
});

const tokenHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--t-magenta)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--t-green)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--t-yellow)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--t-blue)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--t-cyan)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.tagName], color: "var(--t-cyan)" },
  { tag: t.heading, color: "var(--accent)", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--t-cyan)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--t-yellow)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--fg-muted)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

export function CodeEditor({
  value,
  lang,
  wrap,
  onChange,
  autoFocus,
  className,
}: {
  /** Initial document. Changing it later does not reset the editor; remount with a key instead. */
  value: string;
  lang: Lang;
  wrap?: boolean;
  onChange?: (doc: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          syntaxHighlighting(tokenHighlight),
          basicSetup,
          langExt(lang),
          tokenTheme,
          wrap ? EditorView.lineWrapping : [],
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    if (autoFocus) view.focus();
    return () => view.destroy();
    // value is initial only; lang/wrap changes remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, wrap]);

  return <div ref={host} className={className ?? "h-full min-h-0 overflow-hidden"} />;
}
