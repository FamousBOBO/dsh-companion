import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeLiveQqSender } from './qq-conversation.mjs?v=sender-rebind-20261101';
const rootPath = fileURLToPath(new URL('../../', import.meta.url));
export const name = 'companion-qq-sender-refresh';
export const inject = ['tools', 'agents'];
export function apply(ctx) {
    const root = ctx.root;
    const agents = ctx.agents;
    const mounted = new WeakSet();
    const refresh = agent => {
      const changed = upgradeLiveQqSender(root, agent);
      if (String(agent?.session?.id ?? agent?.id) === 'qq-dm-10001' && !mounted.has(agent)) {
        const prompt = agent.ctx?.systemPrompt ?? agent.ctx?.get?.('systemPrompt');
        if (!prompt?.section) throw Error('QQ autonomy: scoped system prompt unavailable');
        prompt.section({ name: 'companion:qq-autonomy-20261102', order: 145, interpolate: false,
          text: () => fs.readFileSync(path.join(rootPath, 'plugins/companion-foundation/qq-autonomy-policy.txt'), 'utf8') });
        mounted.add(agent);
        console.log('[qq-autonomy] policy mounted on current owner QQ session');
      }
      return changed;
    };
    const updated = [];
    for (const agent of agents.list()) if (refresh(agent)) updated.push(agent.id ?? agent.session?.id);
    ctx.on('agent/pre-step', async (event, next) => { refresh(event.agent); return next(); }, { prepend: true });
    fs.writeFileSync(path.join(rootPath, 'logs/qq-sender-refresh.json'), JSON.stringify({ at: new Date().toISOString(), updated, hookInstalled: true }, null, 2) + '\n');
}
