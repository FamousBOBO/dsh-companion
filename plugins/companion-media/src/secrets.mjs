/**
 * Secret handling.
 *
 * Two independent rules, because one alone has been proven insufficient:
 *  1. By **key name**: any field named token/key/secret/password/cookie/auth/
 *     credential is replaced before a config leaves this module.
 *  2. By **value shape**: if a credential-looking string shows up under an
 *     innocent name (an upstream error body quoting the request, a URL with a
 *     token in the query), it is redacted too.
 *
 * Nothing in this plugin logs a header map, so an Authorization header can only
 * leak through (1) a copied request description or (2) an error string. Both
 * paths go through `redactText`.
 */

const SECRET_KEY = /(token|key|secret|password|passwd|cookie|authorization|auth|credential)/i;

const SECRET_VALUE = new RegExp(
  [
    '\\bBearer\\s+[A-Za-z0-9._~+/-]{8,}=*',
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\bpst-[A-Za-z0-9_-]{16,}',
    '\\boc_sk_[A-Za-z0-9_-]{8,}',
    '\\bfish_[A-Za-z0-9_-]{12,}',
    '\\b[A-Za-z0-9_-]{32,}\\b(?=[\\s"\'&,;]*(?:$|&|"))',
  ].join('|'),
  'g',
);

/** Remove credential-shaped substrings from arbitrary text. */
export function redactText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(SECRET_VALUE, '[redacted]');
}

/** Keep the last four characters so an operator can tell two keys apart. */
export function maskSecret(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}…${text.slice(-4)}`;
}

/** How a stored key is reported: never the value, only whether it exists. */
export function describeSecret(value, { envVar = null } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) return { configured: true, mask: maskSecret(text), source: 'config' };
  if (envVar) return { configured: false, mask: '', source: 'env', envVar, note: '未在配置文件里写入；将尝试读取该环境变量' };
  return { configured: false, mask: '', source: 'none' };
}

function stripSecrets(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[depth-limit]';
  if (Array.isArray(value)) return value.map(item => stripSecrets(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : stripSecrets(item, depth + 1);
  }
  return out;
}

/** Any object as it may be returned by an API, logged, or shown in a report. */
export function sanitize(value) {
  return stripSecrets(value);
}

/** Redact every secret-shaped part of a URL (query tokens, userinfo). */
export function redactUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return redactText(rawUrl);
  }
}
