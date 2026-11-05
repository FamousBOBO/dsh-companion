import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { upgradeLiveQqSender } from './qq-conversation.mjs?v=sender-rebind-20261101';
const { Service } = await import(pathToFileURL(path.join(process.env.DSH_COMPANION_MODULE_ROOT, '@deepseek-ai/cordis/lib/index.js')).href);
const rootPath = fileURLToPath(new URL('../../', import.meta.url));
export default class QqSenderRefresh extends Service {
  static inject = ['tools', 'agents'];
  constructor(ctx) { super(ctx, 'companionQqSenderRefresh'); }
  *[Service.init]() {
    const root = this.ctx.root;
    const agents = this.ctx.agents;
    const refresh = agent => upgradeLiveQqSender(root, agent);
    const updated = [];
    for (const agent of agents.list()) if (refresh(agent)) updated.push(agent.id ?? agent.session?.id);
    this.ctx.on('agent/pre-step', async (event, next) => { refresh(event.agent); return next(); }, { prepend: true });
    fs.writeFileSync(path.join(rootPath, 'logs/qq-sender-refresh.json'), JSON.stringify({ at: new Date().toISOString(), updated, hookInstalled: true }, null, 2) + '\n');
  }
}
