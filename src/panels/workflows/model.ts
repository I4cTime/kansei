// Pure helpers for workflow scripts.

/** Pull name/description out of the `export const meta = {...}` literal without evaluating it. */
export function readMeta(src: string): { name?: string; description?: string } {
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(src) ?? /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}/.exec(src);
  if (!m) return {};
  const field = (k: string) => {
    const r = new RegExp(`\\b${k}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(m[1]);
    return r?.[2];
  };
  return { name: field("name"), description: field("description") };
}

export function workflowTemplate(name: string): string {
  return `export const meta = {
  name: '${name}',
  description: 'One line that says what this workflow does (shown in the permission dialog)',
  phases: [],
}

// Claude Code runs this by name ("run the ${name} workflow"). Plain JavaScript, not
// TypeScript. agent() spawns a subagent and resolves to its final text, or to a
// validated object when you pass { schema }. \`args\` is whatever the caller passed.
const target = args ?? 'the current repository'

const summary = await agent(\`List the open TODO comments in \${target}. Return a short bullet list with file paths.\`, {
  label: 'find TODOs',
})

log('done')
return summary
`;
}
