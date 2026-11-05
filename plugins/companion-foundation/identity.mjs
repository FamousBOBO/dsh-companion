import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePersonaId, resolveSuiteRoot } from './suite-paths.mjs';

/** Default owner recorded on a first run; the operator can edit the file afterwards. */
export const DEFAULT_OWNER = Object.freeze({ id: 'local-owner', displayName: '本地主人', platform: 'local' });

/**
 * Bind the local owner identity stored in `home/companion/identity.json`.
 *
 * Two rules make this safe on a brand-new data directory:
 *
 * 1. **A missing file is first run, not an error.** `npm run setup` does not create
 *    the identity (it only handles suite config and the persona), and a profile may
 *    mount the Studio bundle before anything else has ever written here. So the
 *    first read provisions a documented default local owner
 *    (`DSH_COMPANION_OWNER_ID` / `DSH_COMPANION_OWNER_NAME` override it) and writes
 *    the file atomically. Every later read validates it strictly.
 * 2. **A broken file is still an error.** Wrong schema, a missing owner, a persona
 *    mismatch or an owner change all keep failing closed — silently replacing a
 *    user's identity would mis-scope their memory.
 *
 * The persona id is not a character name baked into the source: it is resolved once
 * per mount (`DSH_COMPANION_PERSONA_ID` → `config/suite.json` `persona.id` → `bot`)
 * and every session row is checked against that value.
 *
 * @param root companion root (the data root: it contains `home/`)
 * @param options.personaId already-resolved persona id; omit to resolve it here
 * @param options.owner overrides for the provisioned default owner (tests / setup)
 * @param options.provision set `false` to disable writing the default file
 */
export function createIdentity(root, { personaId = null, owner = null, provision = true, onProvision = null } = {}) {
  const file = path.join(root, 'home/companion', 'identity.json');
  const expectedPersonaId = String(personaId ?? resolvePersonaId({ suiteRoot: resolveSuiteRoot() }).personaId).trim();
  let expectedOwner;

  const defaults = () => {
    const env = process.env;
    const id = String(owner?.id ?? env.DSH_COMPANION_OWNER_ID ?? '').trim() || DEFAULT_OWNER.id;
    const displayName = String(owner?.displayName ?? env.DSH_COMPANION_OWNER_NAME ?? '').trim() || DEFAULT_OWNER.displayName;
    const platform = String(owner?.platform ?? env.DSH_COMPANION_OWNER_PLATFORM ?? '').trim() || DEFAULT_OWNER.platform;
    return {
      schemaVersion: 1,
      owner: { id, displayName, platform },
      persona: expectedPersonaId,
      desktop: { mode: 'local-owner', userId: id },
      sessions: {},
      provisionedAt: new Date().toISOString(),
      provisionedBy: 'companion-foundation/identity',
    };
  };

  /** Create the file once, atomically. Returns the value that was written. */
  const provisionFile = () => {
    const value = defaults();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    const message = `[companion-foundation] no identity.json under ${path.dirname(file)}; created the default local owner (owner=${value.owner.id}, persona=${value.persona}). Edit that file if this is not the right owner.`;
    try { (onProvision ?? console.log)(message); } catch { /* logging only */ }
    return value;
  };

  const read = () => {
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // First run. Provisioning keeps a bare data directory usable; the strict
      // validation below then runs against what was just written.
      if (!provision) throw new Error('Companion user identity is not configured.');
      provisionFile();
      text = fs.readFileSync(file, 'utf8');
    }
    const value = JSON.parse(text);
    if (value.schemaVersion !== 1 || !value.owner?.id || !value.owner?.displayName || value.persona !== expectedPersonaId || value.desktop?.mode !== 'local-owner' || value.desktop.userId !== value.owner.id || !value.sessions) throw new Error('Companion user identity is not configured.');
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
    file,
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
