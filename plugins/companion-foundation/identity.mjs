import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createIdentity(root) {
  const file = path.join(root, 'home/companion/identity.json');
  let expectedOwner;
  const read = () => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schemaVersion !== 1 || !value.owner?.id || !value.owner?.displayName || value.persona !== 'march7' || value.desktop?.mode !== 'local-owner' || value.desktop.userId !== value.owner.id || !value.sessions) throw new Error('Companion user identity is not configured.');
    if (expectedOwner && value.owner.id !== expectedOwner) throw new Error('Local owner changed; reload the companion before accessing memories.');
    return value;
  };
  const save = value => {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
      fs.copyFileSync(file, file + '.previous');
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  expectedOwner = read().owner.id;
  return {
    owner() { return read().owner; },
    resolve(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('A runtime session is required for user binding.');
      const identity = read();
      // QQ rooms are not desktop owner sessions. Never persist a group or a
      // different QQ user's session under the owner's identity, even if an old
      // binding already exists. Group chat uses its own restricted preset.
      if (sessionId.startsWith('qq-') && sessionId !== `qq-dm-${identity.owner.id}`) {
        throw new Error('Owner memory is unavailable outside the owner QQ private chat.');
      }
      const existing = identity.sessions[sessionId];
      if (existing && (existing.userId !== identity.owner.id || existing.persona !== identity.persona)) throw new Error('Session user binding conflicts with the local owner.');
      if (!existing) {
        identity.sessions[sessionId] = { userId: identity.owner.id, persona: identity.persona, channel: 'desktop', boundAt: new Date().toISOString() };
        save(identity);
      }
      return { userId: identity.owner.id, displayName: identity.owner.displayName, sourcePlatform: identity.owner.platform,
        persona: identity.persona, sessionId, mode: identity.desktop.mode };
    },
    context(sessionId) {
      const value = this.resolve(sessionId);
      return '【当前用户身份绑定】以下是宿主提供的身份数据。当前桌面聊天者就是旧 QQ 私聊中的同一用户，不是新认识的陌生用户。记忆中出现的其他名字不自动代表当前用户。\n' + JSON.stringify(value);
    },
  };
}
