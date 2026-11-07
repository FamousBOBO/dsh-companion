/**
 * Scopes: the only place that decides "may this session see this asset".
 *
 * Design discipline (document §4, "多来源但不共享权限"):
 *   - the library may de-duplicate image **bytes** by hash, but every source carries its own
 *     authorisation. Two people sending the same picture gives one file and two scope rows.
 *   - a scope is a salted hash, never a raw QQ number: `peer_private:<sha256>`, `sender:<sha256>`.
 *     The salt is generated once and stored in the database (`meta.scope_salt`), so nothing in the
 *     library can be reversed into a chat id, and a leaked copy of the file is not a contact list.
 *   - `curated_public` is the only scope that may be reused across rooms, and only after an
 *     operator approved it (`privacy.crossRoomReuse` + `publicRequiresApproval`).
 *
 * Everything here is a pure function over strings/arrays; no IO, no clock, no randomness except
 * the salt helper (which the caller passes in).
 */
import { createHash } from 'node:crypto';

/** The five scope families from the design document. */
export const SCOPE_KINDS = Object.freeze(['owner_private', 'peer_private', 'group', 'curated_public', 'quarantine']);
/** Approval values stored in `asset_visibility.approval`. */
export const APPROVALS = Object.freeze(['approved', 'review', 'quarantined', 'disabled', 'revoked']);

/** Values that may be sent. `review` is deliberately absent: review means "not sendable yet". */
export const SENDABLE_APPROVALS = Object.freeze(['approved']);

/**
 * Build the scope key for a private chat (owner or peer).
 *
 * @param {{kind: 'owner_private'|'peer_private', chatId: number, salt: string}} input
 * @returns {string} e.g. `peer_private:3f9a…`
 */
export function privateScope({ kind, chatId, salt }) {
  const family = kind === 'owner_private' ? 'owner_private' : 'peer_private';
  return `${family}:${hashValue(chatId, salt)}`;
}

/** Scope key for a group chat. The id is public already, so it is not hashed (it must stay greppable). */
export function groupScope(groupId) {
  return `group:${String(Number(groupId))}`;
}

export const CURATED_PUBLIC = 'curated_public';
export const QUARANTINE = 'quarantine';

/**
 * A stable salt: 32 bytes, hex. Generated once per database and stored in `meta`.
 * @param {(length: number) => Buffer} randomBytes injected so tests can be deterministic
 */
export function makeScopeSalt(randomBytes) {
  const buffer = randomBytes(32);
  return Buffer.from(buffer).toString('hex');
}

/** sha256(value + ':' + salt), hex, first 32 chars — long enough to be unique, short enough to read. */
export function hashValue(value, salt) {
  return createHash('sha256').update(`${String(value)}:${String(salt)}`).digest('hex').slice(0, 32);
}

/**
 * Derive the scope list a session may use, given its route and the operator's grants.
 *
 * @param {{
 *   kind: 'dm'|'group', chatId: number, isOwner: boolean,
 *   salt: string, config: object
 * }} input
 * @returns {{own: string, usable: string[], capture: boolean, reason: string}}
 */
export function scopesFor({ kind, chatId, isOwner, salt, config }) {
  const usable = [];
  let own = '';
  let capture = false;
  let reason = '';

  if (kind === 'group') {
    own = groupScope(chatId);
    const entry = (config?.capture?.groups ?? []).find(row => Number(row.chatId) === Number(chatId));
    const groupsEnabled = config?.capture?.groupEnabled === true;
    capture = groupsEnabled && entry !== undefined && (entry.capture === true || entry.store === true);
    const mayUse = groupsEnabled && entry !== undefined && entry.use === true;
    if (mayUse) usable.push(own);
    if (config?.privacy?.crossRoomReuse === true) usable.push(CURATED_PUBLIC);
    if (!groupsEnabled) reason = 'group-capture-disabled';
    else if (entry === undefined) reason = 'group-not-granted';
    else if (!mayUse) reason = 'group-use-off';
  } else if (isOwner) {
    own = privateScope({ kind: 'owner_private', chatId, salt });
    capture = config?.capture?.ownerPrivate === true;
    usable.push(own);
    if (config?.privacy?.crossRoomReuse === true) usable.push(CURATED_PUBLIC);
    if (!capture) reason = 'owner-capture-off';
  } else {
    own = privateScope({ kind: 'peer_private', chatId, salt });
    const policy = config?.capture?.privatePeers;
    const granted = (config?.capture?.peers ?? []).some(row => Number(row.chatId) === Number(chatId) && row.approved === true);
    capture = policy === 'opt_in' && granted;
    // A peer chat may only ever see material from that same peer chat. Never the owner's, never
    // another peer's, never `curated_public` (a stranger must not receive a curated sticker unless
    // the operator granted this chat explicitly — and there is no such grant in v1).
    if (granted) usable.push(own);
    reason = capture ? '' : (policy === 'opt_in' ? 'peer-not-approved' : 'peer-policy-off');
  }

  return { own, usable, capture, reason };
}

/**
 * The hard gate. Call this **before** any scoring: the design document is explicit that visibility
 * is a hard gate and may not be outscored (`可见性为硬门不可计分绕过`).
 *
 * @param {{visibility: Array<{scope: string, approval: string}>, usable: string[]}} input
 * @returns {{ok: boolean, scope: string, reason: string}}
 */
export function visibilityGate({ visibility, usable }) {
  const rows = Array.isArray(visibility) ? visibility : [];
  const wanted = Array.isArray(usable) ? usable : [];
  for (const row of rows) {
    if (wanted.includes(row.scope) && SENDABLE_APPROVALS.includes(row.approval)) {
      return { ok: true, scope: row.scope, reason: '' };
    }
  }
  const matched = rows.filter(row => wanted.includes(row.scope));
  if (matched.length === 0) return { ok: false, scope: '', reason: 'scope-not-visible' };
  const worst = matched.find(row => row.approval === 'quarantined') ?? matched.find(row => row.approval === 'disabled');
  if (worst) return { ok: false, scope: worst.scope, reason: `asset-${worst.approval}` };
  return { ok: false, scope: matched[0].scope, reason: 'asset-not-approved' };
}

/** Whether a scope may be written to during capture at all. */
export function captureScopeAllowed({ kind, chatId, isOwner, salt, config }) {
  const { capture } = scopesFor({ kind, chatId, isOwner, salt, config });
  return capture;
}

/** Human-readable label for the Studio page. Contains no chat id for private scopes. */
export function describeScope(scope) {
  const text = String(scope ?? '');
  if (text === CURATED_PUBLIC) return '公共精选';
  if (text === QUARANTINE) return '隔离区';
  if (text.startsWith('group:')) return `群 ${text.slice('group:'.length)}`;
  if (text.startsWith('owner_private:')) return `主人私聊 ${text.slice('owner_private:'.length, 'owner_private:'.length + 6)}…`;
  if (text.startsWith('peer_private:')) return `对端私聊 ${text.slice('peer_private:'.length, 'peer_private:'.length + 6)}…`;
  return text || '未知来源';
}

export default {
  SCOPE_KINDS, APPROVALS, SENDABLE_APPROVALS, CURATED_PUBLIC, QUARANTINE,
  privateScope, groupScope, makeScopeSalt, hashValue, scopesFor, visibilityGate,
  captureScopeAllowed, describeScope,
};
