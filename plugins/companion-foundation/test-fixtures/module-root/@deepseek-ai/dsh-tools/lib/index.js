// Minimal stand-ins for the two host modules the foundation plugin imports. Tests use
// these when the installed desktop runtime is not readable (CI, sandboxed review, or a
// machine without the app), so the integration test proves our own wiring instead of
// silently depending on an installed app. Production never uses this directory.
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string') throw new Error('defineTool requires a name');
  return spec;
}
