// Refresh current capacity projections without generating a message or rewriting history.
export async function resolvedContext(llm, header, previous, routeFor) {
  const routed = routeFor(header, previous);
  if (!routed) return null;
  const info = await llm.resolveModelInfo(routed.provider, routed.model);
  const contextWindow = info.context?.contextWindow;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null;
  if (previous?.provider === routed.provider && previous?.model === routed.model && previous?.contextWindow === contextWindow) return null;
  return { ...previous, provider: routed.provider, model: routed.model, contextWindow };
}

export async function refreshStoredContexts(ctx, routeFor) {
  const storage = ctx.get('sessionPersistence');
  const sessions = ctx.get('sessions');
  const llm = ctx.get('llm');
  if (!storage || !sessions) return { updated: 0, skipped: 0 };
  let updated = 0; let skipped = 0;
  for (const item of await storage.list()) {
    const id = item.header.id;
    const live = sessions.get(id);
    if (live) {
      if (ctx.get('agents')?.get(id)?.status === 'running') { skipped++; continue; }
      const value = await resolvedContext(llm, live.header, live.requestContext(), routeFor);
      if (value) { live.append('request/context', value); await sessions.flush(live); updated++; }
      continue;
    }
    let handle;
    try {
      // The storage's exclusive writer lease prevents races with session resume.
      handle = await storage.open(id, 'write');
      const { events } = await handle.read();
      const previous = events.findLast(event => event.type === 'request/context')?.data;
      if (!previous) continue; // No request yet: there is no old capacity to correct.
      const value = await resolvedContext(llm, handle.header, previous, routeFor);
      if (!value) continue;
      await handle.append([{ type: 'request/context', seq: (events.at(-1)?.seq ?? -1) + 1, time: Date.now(), data: value }]);
      await handle.flush(); updated++;
    } catch (error) {
      if (!['SessionAlreadyOwnedError', 'SessionFormatUnsupportedError'].includes(error?.name)) {
        console.warn(`[workspace-context] capacity refresh skipped (${error?.name ?? 'error'})`);
      }
      skipped++;
    } finally { await handle?.close(); }
  }
  return { updated, skipped };
}
