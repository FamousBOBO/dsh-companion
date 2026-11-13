// P2-C H3 activity adapters — the three foundational capabilities (`read`, `explore`,
// `write`) plus every extraction/hashing/containment helper they need (contract
// logs/p2-autonomous-day/contract-p2.md §5 rule 4, wiki 15 §5.1).
//
// Hard rules encoded here:
//  - this module performs **no IO of its own**: every byte comes from the injected
//    `ports` (`readFile`, `fetchPage`, `writeFile`), so the Lead can mount real or fake
//    ports and the tests never touch the network or a real host directory;
//  - nothing here writes `memory_outbox`, a message, a contact ledger, an agenda row or
//    `p2_share_candidates`; an adapter only produces *evidence* (a source hash, a
//    consumed interval, an artifact version) for `activities.mjs` to receipt;
//  - the unit of consumption is one character of *extracted plain text*. A chunk boundary
//    lands on a paragraph, then a line, then a sentence break, so resuming at
//    `consumedPrefix` re-reads exactly the offsets it left (wiki 15 §5.1);
//  - identical input always produces an identical `sourceHash`: extraction is
//    deterministic and markdown/HTML normalisation never depends on the clock, the locale
//    or object key order (P2-07/P2-08);
//  - containment is a refusal, not a warning: a path outside the character's own
//    workspace, an absolute target, `..`, a NUL byte, a non-http(s) URL, a private or
//    loopback host, a redirect off the allowlist and a domain outside
//    `config.p2.autonomy.allowedSources` are all rejected before a byte is read
//    (`workspace-denied` / `source-invalid`);
//  - an adapter never invents content: `write` only appends text the caller supplied,
//    `read`/`explore` only report what the port actually returned, and zero output is a
//    legal activity outcome (wiki 15 §5.2).
//
// Ports may be synchronous **or** return a Promise: every helper here is
// thenable-transparent (`then()`), so a sync port keeps the whole activity lifecycle
// synchronous inside the runtime's single-writer discipline, while a real async
// `fetchPage` still works by returning a Promise from the same call.
import crypto from 'node:crypto';
import path from 'node:path';
import { RuntimeError, ValidationError } from './errors.mjs';

/** The frozen adapter ids (contract §5 rule 4); `ACTIVITY_KINDS` in activities.mjs mirrors this. */
export const BILIBILI_TARGET = 'bilibili:duty';
export const ADAPTER_IDS = Object.freeze(['read', 'explore', 'write', 'bilibili']);

/** Capability directory key per adapter (contract §6: read/explore/write are P2's own). */
export const ADAPTER_CAPABILITY = Object.freeze({ read: 'read', explore: 'explore', write: 'write', bilibili: 'bilibili' });

/** Evidence every receipt may carry: these names are the actual receipt columns (+ reality in detail). */
export const EVIDENCE_FIELDS = Object.freeze(['sourceHash', 'consumedFrom', 'consumedTo', 'reality']);

const HASH_ALGORITHM = 'sha256';
const SLUG_LIMIT = 48;
const TITLE_LIMIT = 160;
const MAX_PROBE_VERSIONS = 16;
const MAX_DRAFT_SCAN = 4096;
const MAX_EXCERPT_FALLBACK = 4000;
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);
const DROP_ELEMENTS = Object.freeze(['script', 'style', 'noscript', 'template', 'svg', 'iframe']);

// --------------------------------------------------------------------- plumbing

export function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function';
}

/** Run `fn` now for a plain value, or after settlement for a Promise (sync stays sync). */
export function then(value, fn) {
  return isThenable(value) ? Promise.resolve(value).then(fn) : fn(value);
}

function clampInt(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(number)));
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function portAvailable(ports, name) {
  return Boolean(ports) && typeof ports[name] === 'function';
}

function describePort(ports, name) {
  if (!ports || typeof ports[name] !== 'function') return { available: false, port: name, reason: 'port-not-mounted' };
  return { available: true, port: name, reason: '' };
}

function portFailure(name, error) {
  // A port that *throws* (or rejects) gave us **no answer**: the request may well have reached the
  // server. That used to be indistinguishable from "the adapter read a 404", which let the
  // lifecycle record "we know what happened" about a call we know nothing about. `noAnswer` carries
  // the distinction to the lifecycle layer, which records it as `unknown` and blocks the retry
  // (round-3 ruling). A port that *returns* `{ok:false,status:404}` is the opposite case: the call
  // happened and produced a definite answer, so the adapter's own refusal stays `failed`.
  const failure = new RuntimeError('source-invalid', `${name} port failed: ${error instanceof Error ? error.message : String(error)}`);
  failure.noAnswer = true;
  return failure;
}

/**
 * Call an injected port. A port that throws (or rejects) is a *source* failure, never an
 * internal crash of the activity: it becomes `source-invalid` and leaves no state behind.
 */
export function callPort(ports, name, argument) {
  if (!portAvailable(ports, name)) throw new RuntimeError('adapter-unavailable', `the ${name} port is not mounted`);
  let result;
  try {
    result = ports[name](argument);
  } catch (error) {
    throw portFailure(name, error);
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(value => value, error => { throw portFailure(name, error); });
  }
  return result;
}

// ------------------------------------------------------------------ extraction

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', deg: '°', eacute: 'é', egrave: 'è', agrave: 'à',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
});

function codePointText(codePoint, fallback) {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return fallback;
  // Control characters would smuggle terminal/bidi tricks into stored evidence.
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) return ' ';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/** Decode the entity forms a fetched page actually uses; unknown entities stay verbatim. */
export function decodeEntities(text) {
  const source = textOf(text);
  if (!source.includes('&')) return source;
  return source
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => codePointText(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec) => codePointText(parseInt(dec, 10), match))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name) => NAMED_ENTITIES[name] ?? match);
}

/** Collapse horizontal whitespace, drop control characters, keep paragraph structure. */
export function normalizeWhitespace(text) {
  const lines = textOf(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let blanks = 0;
  for (const raw of lines) {
    const line = raw
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/[ \t\f\v\u00a0]+/g, ' ')
      .trimEnd();
    if (line === '') {
      blanks += 1;
      if (blanks > 1) continue;
      out.push('');
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** HTML → plain text: dropped elements, block tags as line breaks, entities, whitespace. */
export function stripHtml(html) {
  let source = textOf(html);
  for (const element of DROP_ELEMENTS) {
    source = source.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, 'gi'), ' ');
    source = source.replace(new RegExp(`<${element}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  source = source.replace(/<!--[\s\S]*?-->/g, ' ');
  source = source.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g, (match, closing, tagName) => {
    const name = String(tagName).toLowerCase();
    if (name === 'br' || name === 'hr') return '\n';
    if (!BLOCK_TAGS.has(name)) return '';
    return closing ? '\n' : '\n';
  });
  return normalizeWhitespace(decodeEntities(source));
}

/**
 * Markdown → plain text. Link targets, emphasis markers, list bullets and heading hashes
 * are removed; fenced code blocks keep their content (it is real published text) but lose
 * the fence. Fenced regions are tracked line-wise so no regex can swallow the document.
 */
export function stripMarkdown(markdown) {
  const lines = textOf(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fenceMatch) {
      if (fence === null) { fence = fenceMatch[1][0]; continue; }
      if (fenceMatch[1][0] === fence) { fence = null; continue; }
    }
    if (fence !== null) { out.push(line); continue; }
    if (/^\s{0,3}([-*_]\s*){3,}$/.test(line)) { out.push(''); continue; }            // horizontal rule
    let text = line;
    text = text.replace(/^\s{0,3}#{1,6}\s+/, '');                                    // heading
    text = text.replace(/^\s{0,3}>\s?/, '');                                         // blockquote
    text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '');                     // list marker
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                            // image
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                             // link
    text = text.replace(/`([^`]*)`/g, '$1');                                         // inline code
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
    text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2');
    out.push(text);
  }
  return normalizeWhitespace(out.join('\n'));
}

/**
 * Detect the format and return `{ format, title, text }`.
 *
 * `contentType` wins when the port reported one; otherwise the first 2 KiB are sniffed.
 * The title is metadata and is never part of the hash, so a page whose `<title>` changes
 * does not silently invalidate a consumed offset inside the body.
 */
export function extractPlainText({ contentType = '', text = '' } = {}) {
  const raw = textOf(text);
  const type = textOf(contentType).toLowerCase();
  const sniff = raw.slice(0, 2048);
  let format;
  if (type.includes('html') || type.includes('xhtml') || /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(sniff)) format = 'html';
  else if (type.includes('markdown') || type.includes('md')) format = 'markdown';
  else if (/^\s{0,3}(#{1,6}\s|```|~~~|[-*+]\s|>\s)/m.test(sniff)) format = 'markdown';
  else format = 'text';

  let title = '';
  let body;
  if (format === 'html') {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    title = titleMatch ? normalizeWhitespace(decodeEntities(titleMatch[1])).slice(0, TITLE_LIMIT) : '';
    body = stripHtml(raw);
  } else if (format === 'markdown') {
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(raw);
    title = heading ? normalizeWhitespace(heading[1]).slice(0, TITLE_LIMIT) : '';
    body = stripMarkdown(raw);
  } else {
    body = normalizeWhitespace(raw);
    const first = body.split('\n').find(line => line.trim() !== '') ?? '';
    title = first.slice(0, TITLE_LIMIT);
  }
  return Object.freeze({ format, title, text: body });
}

/**
 * Section-aware chunk end: `from + size` moved back to a paragraph break, then a line
 * break, then a sentence end, and only as a last resort taken verbatim. The 40% floor
 * stops a pathological single-line source from producing 3-character chunks.
 */
export function chunkEnd(text, from, size) {
  const source = textOf(text);
  const start = clampInt(from, 0, source.length, 0);
  const window = clampInt(size, 1, source.length || 1, 1);
  const hardEnd = Math.min(source.length, start + window);
  if (hardEnd >= source.length) return source.length;
  const slice = source.slice(start, hardEnd);
  const floor = Math.max(1, Math.floor(window * 0.4));
  const paragraph = slice.lastIndexOf('\n\n');
  if (paragraph >= floor) return start + paragraph + 2;
  const line = slice.lastIndexOf('\n');
  if (line >= floor) return start + line + 1;
  let sentence = -1;
  for (const marker of ['。', '！', '？', '. ', '! ', '? ', '; ']) {
    const index = slice.lastIndexOf(marker);
    if (index > sentence) sentence = index;
  }
  if (sentence >= floor) return start + sentence + 1;
  // A hard cut may split a surrogate pair; move back one unit rather than emit half a pair.
  const code = source.charCodeAt(hardEnd - 1);
  if (code >= 0xd800 && code <= 0xdbff && hardEnd - 1 > start) return hardEnd - 1;
  return hardEnd;
}

// --------------------------------------------------------------------- subjects

export function sha256Hex(text) {
  return crypto.createHash(HASH_ALGORITHM).update(String(text ?? ''), 'utf8').digest('hex');
}

/** Deterministic, filesystem-safe draft slug: ascii base + short content hash. */
export function slugFor(title) {
  const raw = textOf(title).trim().slice(0, TITLE_LIMIT);
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/g, '');
  const suffix = crypto.createHash(HASH_ALGORITHM).update(raw, 'utf8').digest('hex').slice(0, 8);
  return `${base || 'draft'}-${suffix}`;
}

const PRIVATE_HOST_PATTERNS = Object.freeze([
  /^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /\.home\.arpa$/,
  /^0\.0\.0\.0$/, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^f[cd][0-9a-f]{2}:/, /^fe80:/,
]);

function isPrivateHost(host) {
  const value = textOf(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Parse a target URL for `explore`. Refuses anything that is not an absolute http(s) URL
 * with a host, credentials in the authority, or a malformed authority.
 *
 * A private / loopback / link-local host is refused **unless** it is named explicitly in
 * `config.p2.autonomy.allowedSources`. The allowlist is the operator's decision, so an
 * isolated demo or a local mirror that says `allowedSources:['127.0.0.1']` must be honoured;
 * without such an entry no automatic exploration can reach a private address.
 */
export function parseSourceUrl(raw, { allowedSources = null } = {}) {
  const value = textOf(raw).trim();
  if (!value) throw new RuntimeError('source-invalid', 'explore requires an absolute http(s) URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeError('source-invalid', `not an absolute URL: ${value.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RuntimeError('source-invalid', `only http(s) sources are allowed, got ${url.protocol}`);
  }
  if (url.username || url.password) throw new RuntimeError('source-invalid', 'credentials in the URL are not allowed');
  if (!url.hostname) throw new RuntimeError('source-invalid', 'the URL has no host');
  const explicitlyAllowed = Array.isArray(allowedSources) && sourceAllowed(url.hostname, allowedSources);
  if (isPrivateHost(url.hostname) && !explicitlyAllowed) {
    throw new RuntimeError('source-invalid', `private or loopback host is not a public source: ${url.hostname}`);
  }
  return Object.freeze({
    href: url.href,
    protocol: url.protocol,
    host: url.hostname.toLowerCase(),
    pathname: url.pathname,
  });
}

/**
 * Domain allowlist check against `config.p2.autonomy.allowedSources`.
 *
 * Entries may be a bare domain (`example.com`), a leading-dot domain (`.example.com`), a
 * leading wildcard (`*.example.com`) or a full URL. An **empty** allowlist allows
 * nothing: an unconfigured autonomous scope must refuse to open public pages rather than
 * silently read "no list" as "any host" (wiki 15 §5).
 */
export function sourceAllowed(host, allowedSources) {
  const list = Array.isArray(allowedSources) ? allowedSources : [];
  const target = textOf(host).toLowerCase();
  if (!target) return false;
  if (list.includes('*') && !isPrivateHost(target)) return true;
  for (const entry of list) {
    let candidate = textOf(entry).trim().toLowerCase();
    if (!candidate) continue;
    if (candidate.startsWith('*.')) candidate = candidate.slice(2);
    if (candidate.startsWith('.')) candidate = candidate.slice(1);
    if (candidate.includes('://')) {
      try {
        candidate = new URL(candidate).hostname.toLowerCase();
      } catch {
        continue;
      }
    }
    candidate = candidate.replace(/[/:].*$/, '');
    if (!candidate) continue;
    if (target === candidate || target.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ containment

/**
 * Resolve a workspace-relative reference inside the character's own artifact root.
 *
 * Refusals (typed `workspace-denied`, never a silent clamp): a missing root, an empty
 * reference, a NUL byte, an absolute path (POSIX, Windows drive or UNC), any `..`
 * segment, or a resolved path that escapes `root`.
 */
export function resolveInsideWorkspace(root, relative) {
  const base = textOf(root);
  if (!base) throw new RuntimeError('workspace-denied', 'no workspace root is configured for this activity');
  const ref = textOf(relative).trim();
  if (!ref) throw new RuntimeError('workspace-denied', 'a workspace-relative target is required');
  if (ref.includes('\u0000')) throw new RuntimeError('workspace-denied', 'the target contains a NUL byte');
  if (path.isAbsolute(ref) || /^[a-zA-Z]:[\\/]/.test(ref) || /^[\\/]{1,2}/.test(ref)) {
    throw new RuntimeError('workspace-denied', `absolute targets are refused: ${ref.slice(0, 200)}`);
  }
  if (ref.replace(/\\/g, '/').split('/').some(part => part === '..')) {
    throw new RuntimeError('workspace-denied', `parent traversal is refused: ${ref.slice(0, 200)}`);
  }
  const absoluteRoot = path.resolve(base);
  const resolved = path.resolve(absoluteRoot, ref);
  const withSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  if (resolved !== absoluteRoot && !resolved.startsWith(withSep)) {
    throw new RuntimeError('workspace-denied', `the target escapes the workspace: ${ref.slice(0, 200)}`);
  }
  const relativeNormalized = resolved === absoluteRoot ? '' : path.relative(absoluteRoot, resolved).split(path.sep).join('/');
  return Object.freeze({ absolute: resolved, relative: relativeNormalized });
}

/** Normalise a caller-supplied target into a resolved workspace reference. */
export function workspaceRefOf(root, target) {
  const value = typeof target === 'string' ? target : (target?.path ?? target?.ref ?? '');
  return resolveInsideWorkspace(root, value);
}

// -------------------------------------------------------------------- context

/**
 * Normalise the injected activity context once, so every adapter reads the same bounds.
 * `workspace` is the character's own artifact root and the only writable directory.
 */
export function adapterContext({ ports = {}, config = null, workspace = '' } = {}) {
  const activities = config?.p2?.activities ?? {};
  const autonomy = config?.p2?.autonomy ?? {};
  return Object.freeze({
    ports: ports ?? {},
    workspace: textOf(workspace),
    readRoots: Object.freeze(Array.isArray(activities.readRoots) ? activities.readRoots.map(String).filter(Boolean) : []),
    chunkUnits: clampInt(activities.chunkUnits, 100, 20000, 1200),
    maxUnitsPerStep: clampInt(activities.maxUnitsPerStep, 100, 50000, 4000),
    maxTotalUnits: clampInt(activities.maxTotalUnits, 1000, 2000000, 200000),
    readFullSource: activities.readFullSource === true,
    maxSourceBytes: clampInt(activities.maxSourceBytes, 1000, 2000000, 200000),
    maxExcerptChars: clampInt(activities.maxExcerptChars, 200, 20000, MAX_EXCERPT_FALLBACK),
    defaultReality: activities.defaultReality === 'simulated' ? 'simulated' : 'actual',
    allowedSources: Object.freeze(Array.isArray(autonomy.allowedSources) ? autonomy.allowedSources.map(String) : []),
    draftsDir: textOf(activities.draftsDir).trim() || 'drafts',
  });
}

/** Requested step size in characters, capped by `maxUnitsPerStep`. */
export function stepWindow(ctx, units) {
  const requested = Number(units);
  const base = Number.isFinite(requested) && requested > 0 ? requested : ctx.chunkUnits;
  return Math.max(1, Math.min(ctx.maxUnitsPerStep, Math.trunc(base)));
}

// ------------------------------------------------------------------- file ports

function readWorkspaceText(ctx, relative) {
  const resolved = resolveInsideWorkspace(ctx.workspace, relative);
  return then(callPort(ctx.ports, 'readFile', { path: resolved.absolute }), result => {
    if (!result || result.ok !== true) {
      throw new RuntimeError('source-invalid', `the source could not be read: ${resolved.relative}`);
    }
    const text = typeof result.text === 'string' ? result.text : '';
    if (Buffer.byteLength(text, 'utf8') > ctx.maxSourceBytes) {
      throw new RuntimeError('source-invalid', `the source is larger than maxSourceBytes (${ctx.maxSourceBytes})`);
    }
    return { text, contentType: textOf(result.contentType), relative: resolved.relative, absolute: resolved.absolute };
  });
}

function writeWorkspaceText(ctx, relative, text) {
  const resolved = resolveInsideWorkspace(ctx.workspace, relative);
  return then(readOptional(ctx, resolved.absolute), existing => {
    if (existing !== null) {
      // A version file is immutable evidence: writing one twice would rewrite history.
      throw new RuntimeError('workspace-denied', `refusing to overwrite an existing artifact: ${resolved.relative}`);
    }
    return then(callPort(ctx.ports, 'writeFile', { path: resolved.absolute, text }), result => {
      if (!result || result.ok !== true) {
        throw new RuntimeError('workspace-denied', `the artifact could not be written: ${resolved.relative}`);
      }
      return {
        relative: resolved.relative,
        absolute: resolved.absolute,
        bytes: Number.isFinite(Number(result.bytes)) ? Number(result.bytes) : Buffer.byteLength(text, 'utf8'),
      };
    });
  });
}

function readOptional(ctx, absolute) {
  if (!portAvailable(ctx.ports, 'readFile')) return null;
  let result;
  try {
    result = ctx.ports.readFile({ path: absolute });
  } catch {
    return null;
  }
  const pick = value => (value && value.ok === true && typeof value.text === 'string' ? value.text : null);
  if (isThenable(result)) return Promise.resolve(result).then(pick, () => null);
  return pick(result);
}

function basenameOf(relative) {
  const parts = String(relative).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function excerptOf(text, limit) {
  const value = textOf(text);
  const cap = clampInt(limit, 200, 20000, MAX_EXCERPT_FALLBACK);
  return value.length > cap ? value.slice(0, cap) : value;
}

/**
 * A draft that would exceed the configured byte ceiling is refused, never silently
 * truncated: truncating would make the recorded version hash cover text the caller never
 * asked for (and the consumed interval would lie about what was written).
 */
function assertDraftFits(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    // A caller request that does not fit is `invalid-input`, not `source-invalid`: the
    // source is fine, and mistaking the two would park a perfectly healthy draft for review.
    throw new ValidationError(`the draft would exceed maxSourceBytes (${maxBytes})`);
  }
  return value;
}

function fileRefOf(sourceRef) {
  const value = textOf(sourceRef);
  const index = value.indexOf(':');
  if (index < 0) throw new RuntimeError('source-invalid', 'the activity has no usable source reference');
  const scheme = value.slice(0, index);
  if (scheme !== 'file') throw new RuntimeError('source-invalid', `a read activity cannot consume a ${scheme || 'unknown'} source`);
  return value.slice(index + 1);
}

// --------------------------------------------------------------------- adapters

/**
 * `read` — a local text / Markdown / HTML source inside the character's own shelf.
 *
 * Resumable by character offset: the extracted plain text is re-read and re-hashed on
 * **every** step (never cached, never persisted), so a restart can only continue when the
 * source still hashes to the recorded `source_hash`. A changed source is a refusal
 * (`source-changed`), never an old offset silently applied to new text (wiki 15 §5.1;
 * reference `role_work/reading.py`: 读取到文本 ≠ 模型已处理，回执必须覆盖消费区间).
 */
const readAdapter = {
  id: 'read',
  capability: ADAPTER_CAPABILITY.read,
  requires: Object.freeze(['ports.readFile', 'workspace']),
  produces: Object.freeze(['plainText', 'sourceHash', 'segments']),
  evidenceFields: EVIDENCE_FIELDS,
  describe(ctx) {
    const port = describePort(ctx?.ports, 'readFile');
    if (!port.available) return port;
    if (!ctx?.workspace) return { available: false, port: 'readFile', reason: 'workspace-not-mounted' };
    return { available: true, port: 'readFile', reason: '' };
  },
  /** Bind the source and the start of the consumption interval. No database work. */
  prepare(ctx, { target, now } = {}) {
    const resolved = workspaceRefOf(ctx.workspace, target);
    return then(readWorkspaceText(ctx, resolved.relative), loaded => {
      const extracted = extractPlainText({ contentType: loaded.contentType, text: loaded.text });
      if (!extracted.text.trim()) throw new RuntimeError('source-invalid', `the source has no readable text: ${resolved.relative}`);
      const sourceHash = sha256Hex(extracted.text);
      return {
        sourceRef: `file:${resolved.relative}`,
        sourceHash,
        totalUnits: extracted.text.length,
        consumedFrom: 0,
        artifactRef: '',
        artifactVersion: 0,
        excerpt: excerptOf(extracted.text, ctx.maxExcerptChars),
        checkpoint: {
          unit: 'chars',
          adapter: 'read',
          format: extracted.format,
          title: extracted.title || basenameOf(resolved.relative),
          position: 0,
          at: Number(now) || 0,
        },
      };
    });
  },
  /** Produce the next bounded segment; `units` is a request, the segment is what is consumed. */
  consume(ctx, activity, { units } = {}) {
    return then(readWorkspaceText(ctx, fileRefOf(activity.sourceRef)), loaded => {
      const extracted = extractPlainText({ contentType: loaded.contentType, text: loaded.text });
      const sourceHash = sha256Hex(extracted.text);
      if (sourceHash !== activity.sourceHash) {
        throw new RuntimeError('source-changed', 'the source content changed since this activity started; the consumed offset is not reusable');
      }
      const from = Math.max(0, Math.trunc(Number(activity.consumedPrefix) || 0));
      if (from >= extracted.text.length) return { units: 0, from, to: from, text: '', sourceHash, checkpoint: {} };
      const to = chunkEnd(extracted.text, from, stepWindow(ctx, units));
      return {
        units: to - from,
        from,
        to,
        text: extracted.text.slice(from, to),
        sourceHash,
        checkpoint: {
          position: to,
          lastConsumed: { from, to },
          title: extracted.title || basenameOf(loaded.relative),
          format: extracted.format,
        },
      };
    });
  },
  /**
   * Read-only view of the next window. Never advances anything: the caller (the model-gated
   * execution path) decides whether the window is consumed.
   */
  segment(ctx, activity, { units } = {}) {
    return readAdapter.consume(ctx, activity, { units });
  },
  /** Re-verify the recorded hash without consuming anything (resume / reconcile). */
  verify(ctx, activity) {
    return then(readWorkspaceText(ctx, fileRefOf(activity.sourceRef)), loaded => {
      const extracted = extractPlainText({ contentType: loaded.contentType, text: loaded.text });
      const sourceHash = sha256Hex(extracted.text);
      const ok = sourceHash === activity.sourceHash;
      return { ok, sourceHash, code: ok ? '' : 'source-changed' };
    });
  },
};

/**
 * `explore` — one public page: fetch through the port, extract title + text, hash it and
 * keep a **bounded** excerpt as the evidence and as the text the activity reads.
 *
 * Recovery can never re-verify a remote page (a network call from a recovery path is
 * exactly what the contract forbids), so the stored excerpt hash is the local anchor.
 */
const exploreAdapter = {
  id: 'explore',
  capability: ADAPTER_CAPABILITY.explore,
  requires: Object.freeze(['ports.fetchPage', 'config.p2.autonomy.allowedSources']),
  produces: Object.freeze(['title', 'plainText', 'sourceHash', 'boundedExcerpt']),
  evidenceFields: EVIDENCE_FIELDS,
  describe(ctx) {
    const port = describePort(ctx?.ports, 'fetchPage');
    if (!port.available) return port;
    if (!Array.isArray(ctx?.allowedSources) || ctx.allowedSources.length === 0) {
      return { available: false, port: 'fetchPage', reason: 'source-allowlist-empty' };
    }
    return { available: true, port: 'fetchPage', reason: '' };
  },
  prepare(ctx, { target, now } = {}) {
    // Everything in this block runs **before** the port is called: no request has been made, so a
    // refusal here provably did not reach the outside world (`noEffect`). Anything raised inside
    // the callback below happens after the fetch and must stay `unknown` (round-2 review §二.1).
    let url;
    try {
      url = parseSourceUrl(typeof target === 'string' ? target : (target?.url ?? ''), { allowedSources: ctx.allowedSources });
      if (!sourceAllowed(url.host, ctx.allowedSources)) {
        throw new RuntimeError('source-invalid', `the host is not in config.p2.autonomy.allowedSources: ${url.host}`);
      }
    } catch (error) {
      if (error && typeof error === 'object') Object.defineProperty(error, 'noEffect', { value: true, enumerable: false });
      throw error;
    }
    return then(callPort(ctx.ports, 'fetchPage', { url: url.href }), fetched => {
      if (!fetched || fetched.ok !== true) {
        // A1: the FD web ports answer `{ok:false, noAnswer:true}` when they could not get an answer
        // (DNS/TLS/timeout, or no transport mounted). That must become `unknown` — the request may
        // have reached the site — and must NOT be a definite failure, because a definite failure is
        // what authorises a retry, and a retry is a second outward call.
        const status = Number(fetched?.status);
        const code = /^[a-z0-9_-]{1,64}$/i.test(fetched?.code ?? '') ? fetched.code : '';
        // A transport error may contain request internals; persist only its machine code.
        const reason = !fetched?.noAnswer && /^[a-z0-9 _-]{1,64}$/i.test(fetched?.reason ?? '') ? fetched.reason : '';
        const details = [status > 0 ? `HTTP ${status}` : '', code, reason].filter(Boolean).join('; ');
        const failure = new RuntimeError('source-invalid', `the page could not be fetched${details ? ` (${details})` : ''}`);
        if (fetched?.noAnswer === true) failure.noAnswer = true;
        throw failure;
      }
      const declared = Number(fetched.bytes ?? fetched.length ?? 0);
      if (Number.isFinite(declared) && declared > ctx.maxSourceBytes) {
        throw new RuntimeError('source-invalid', `the page body is larger than maxSourceBytes (${ctx.maxSourceBytes})`);
      }
      const raw = typeof fetched.text === 'string' ? fetched.text : '';
      if (Buffer.byteLength(raw, 'utf8') > ctx.maxSourceBytes) {
        throw new RuntimeError('source-invalid', `the page body is larger than maxSourceBytes (${ctx.maxSourceBytes})`);
      }
      const extracted = extractPlainText({ contentType: textOf(fetched.contentType), text: raw });
      if (!extracted.text.trim()) throw new RuntimeError('source-invalid', `the page has no readable text: ${url.host}`);
      const finalUrl = textOf(fetched.finalUrl) || url.href;
      const finalHost = (() => { try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return url.host; } })();
      // A redirect off the allowlist must not be silently followed into another domain.
      if (!sourceAllowed(finalHost, ctx.allowedSources)) {
        throw new RuntimeError('source-invalid', `a redirect left the allowlist: ${finalHost}`);
      }
      const sourceHash = sha256Hex(extracted.text);
      if (ctx.readFullSource && (fetched.truncated === true || extracted.text.length > ctx.maxTotalUnits)) {
        throw new RuntimeError('source-truncated', 'full reading requires an untruncated source within maxTotalUnits');
      }
      const excerpt = ctx.readFullSource ? extracted.text : excerptOf(extracted.text, ctx.maxExcerptChars);
      return {
        sourceRef: `url:${finalUrl}`,
        sourceHash,
        totalUnits: excerpt.length,
        consumedFrom: 0,
        artifactRef: '',
        artifactVersion: 0,
        excerpt,
        checkpoint: {
          unit: 'chars',
          adapter: 'explore',
          fullSource: ctx.readFullSource,
          sourceChars: extracted.text.length,
          host: finalHost,
          title: (fetched.title || extracted.title || finalHost).slice(0, TITLE_LIMIT),
          status: Number(fetched.status ?? 0) || 0,
          contentType: textOf(fetched.contentType),
          excerpt,
          excerptHash: sha256Hex(excerpt),
          position: 0,
          at: Number(now) || 0,
        },
      };
    });
  },
  consume(ctx, activity, { units } = {}) {
    const checkpoint = activity.checkpoint ?? {};
    const excerpt = typeof checkpoint.excerpt === 'string' ? checkpoint.excerpt : '';
    if (!excerpt) throw new RuntimeError('source-invalid', 'this explore activity has no stored excerpt to read');
    if (sha256Hex(excerpt) !== checkpoint.excerptHash) {
      throw new RuntimeError('source-changed', 'the stored excerpt no longer matches its hash');
    }
    const from = Math.max(0, Math.trunc(Number(activity.consumedPrefix) || 0));
    if (from >= excerpt.length) return { units: 0, from, to: from, text: '', sourceHash: activity.sourceHash, checkpoint: {} };
    const to = chunkEnd(excerpt, from, stepWindow(ctx, units));
    return {
      units: to - from,
      from,
      to,
      text: excerpt.slice(from, to),
      sourceHash: activity.sourceHash,
      checkpoint: { position: to, lastConsumed: { from, to } },
    };
  },
  /** Read-only view of the next excerpt window (no advance, no write). */
  segment(ctx, activity, { units } = {}) {
    return exploreAdapter.consume(ctx, activity, { units });
  },
  /** No network in a recovery path: the excerpt hash is the local anchor. */
  verify(ctx, activity) {
    void ctx;
    const checkpoint = activity.checkpoint ?? {};
    const excerpt = typeof checkpoint.excerpt === 'string' ? checkpoint.excerpt : '';
    const ok = Boolean(excerpt) && sha256Hex(excerpt) === checkpoint.excerptHash;
    return { ok, sourceHash: activity.sourceHash, code: ok ? '' : 'excerpt-changed' };
  },
};

/**
 * `write` — a markdown draft inside `workspace/<draftsDir>/<slug>/`.
 *
 * A version is immutable: `start` creates `v1`, every step writes the next `vN` as a
 * **new** file and keeps the previous versions in the checkpoint history. The version hash
 * is the activity's `source_hash`, so the artifact itself is the evidence (wiki 15 §5).
 */
const writeAdapter = {
  id: 'write',
  capability: ADAPTER_CAPABILITY.write,
  requires: Object.freeze(['ports.readFile', 'ports.writeFile', 'workspace']),
  produces: Object.freeze(['markdownArtifact', 'artifactVersion', 'versionHash']),
  evidenceFields: Object.freeze([...EVIDENCE_FIELDS, 'artifactRef']),
  describe(ctx) {
    const read = describePort(ctx?.ports, 'readFile');
    const write = describePort(ctx?.ports, 'writeFile');
    if (!read.available) return read;
    if (!write.available) return write;
    if (!ctx?.workspace) return { available: false, port: 'writeFile', reason: 'workspace-not-mounted' };
    return { available: true, port: 'writeFile', reason: '' };
  },
  prepare(ctx, { target, now } = {}) {
    // A plan slot names its document as a workspace-relative path (`drafts/<slug>`), while a
    // direct caller names it as a title plus an optional slug. Both must open the *same*
    // document, otherwise a continuation would silently start a second draft.
    const rawTarget = textOf(typeof target === 'string' ? target : (target?.title ?? target?.name ?? '')).trim();
    const document = documentRefOf(rawTarget);
    const title = (document.title || rawTarget).slice(0, TITLE_LIMIT);
    if (!title) throw new ValidationError('a write activity requires a non-empty title');
    const explicitSlug = typeof target?.slug === 'string' && target.slug.trim() ? target.slug : '';
    // One document can be named several ways (`drafts/<slug>`, `drafts/<slug>/v2.md`, a bare
    // title, an explicit slug). The slug candidates below are tried in order and the first one
    // that already has a draft version wins — so a continuation can never silently start a
    // second document. When nothing exists yet, the first candidate creates it.
    const slugs = dedupeStrings([
      explicitSlug ? slugFor(explicitSlug) : '',
      document.slugSource ? slugFor(document.slugSource) : '',
      slugFor(rawTarget),
    ].filter(Boolean));
    const seed = typeof target?.seed === 'string' ? target.seed : (typeof target?.body === 'string' ? target.body : '');
    const boundedSeed = seed.slice(0, ctx.maxSourceBytes);
    return then(existingDraftOf(ctx, slugs), found => {
      const slug = found?.slug ?? slugs[0];
      const existing = found?.existing ?? null;
      const version = existing ? existing.version + 1 : 1;
      const base = existing ? existing.text : `# ${title}\n`;
      const content = assertDraftFits(boundedSeed.trim() ? `${base.trimEnd()}\n\n${boundedSeed.trimEnd()}\n` : `${base.trimEnd()}\n`, ctx.maxSourceBytes);
      const ref = `${ctx.draftsDir}/${slug}/v${version}.md`;
      return then(writeWorkspaceText(ctx, ref, content), written => {
        const hash = sha256Hex(content);
        const history = existing ? [...existing.history, { version, hash, ref, bytes: written.bytes }] : [{ version, hash, ref, bytes: written.bytes }];
        return {
          sourceRef: `draft:${slug}`,
          sourceHash: hash,
          // The artifact itself is the evidence (amendment BLOCK-5): every version records
          // its own sha256, and `finish` refuses a write activity without one.
          artifactHash: hash,
          totalUnits: content.length,
          consumedFrom: content.length,
          artifactRef: ref,
          artifactVersion: version,
          excerpt: excerptOf(content, ctx.maxExcerptChars),
          checkpoint: {
            unit: 'chars',
            adapter: 'write',
            title,
            slug,
            position: content.length,
            versions: history,
            extended: Boolean(existing),
            at: Number(now) || 0,
          },
        };
      });
    });
  },
  consume(ctx, activity, { append } = {}) {
    const text = textOf(append).trim();
    if (!text) return { units: 0, from: 0, to: 0, text: '', skipped: 'empty-append' };
    const checkpoint = activity.checkpoint ?? {};
    const slug = textOf(checkpoint.slug) || slugFor(checkpoint.title ?? 'draft');
    const currentRef = textOf(activity.artifactRef) || `${ctx.draftsDir}/${slug}/v${Math.max(1, Math.trunc(Number(activity.artifactVersion) || 1))}.md`;
    return then(readWorkspaceText(ctx, currentRef), current => {
      if (sha256Hex(current.text) !== activity.sourceHash) {
        throw new RuntimeError('source-changed', 'the current artifact version does not match the recorded version hash');
      }
      const version = Math.max(1, Math.trunc(Number(activity.artifactVersion) || 0)) + 1;
      const content = assertDraftFits(`${current.text.trimEnd()}\n\n${text.trimEnd()}\n`, ctx.maxSourceBytes);
      if (content.length <= current.text.length) throw new RuntimeError('source-invalid', 'the appended text produced no new content');
      const ref = `${ctx.draftsDir}/${slug}/v${version}.md`;
      return then(writeWorkspaceText(ctx, ref, content), written => {
        const hash = sha256Hex(content);
        const from = Math.max(0, Math.trunc(Number(activity.consumedPrefix) || 0));
        const history = Array.isArray(checkpoint.versions) ? checkpoint.versions.slice(-MAX_PROBE_VERSIONS) : [];
        return {
          units: content.length - from,
          from,
          to: content.length,
          text,
          sourceHash: hash,
          artifactHash: hash,
          artifactRef: ref,
          artifactVersion: version,
          checkpoint: {
            position: content.length,
            lastConsumed: { from, to: content.length },
            versions: [...history, { version, hash, ref, bytes: written.bytes }],
          },
        };
      });
    });
  },
  /**
   * Read-only view of what the model must write *next*: the current version's text and the
   * version number the next append would produce. It never writes a file — only
   * `consume()` (via `applyModelProgress`) commits a new version.
   */
  segment(ctx, activity) {
    const checkpoint = activity.checkpoint ?? {};
    const slug = textOf(checkpoint.slug) || slugFor(checkpoint.title ?? 'draft');
    const currentRef = textOf(activity.artifactRef) || `${ctx.draftsDir}/${slug}/v${Math.max(1, Math.trunc(Number(activity.artifactVersion) || 1))}.md`;
    return then(readWorkspaceText(ctx, currentRef), current => {
      const hash = sha256Hex(current.text);
      const artifactVersion = Math.max(1, Math.trunc(Number(activity.artifactVersion) || 1));
      return {
        units: 0,
        from: Math.max(0, Math.trunc(Number(activity.consumedPrefix) || 0)),
        to: Math.max(0, Math.trunc(Number(activity.consumedPrefix) || 0)),
        text: '',
        existingText: current.text.length > ctx.maxExcerptChars ? current.text.slice(-ctx.maxExcerptChars) : current.text,
        sourceHash: textOf(activity.sourceHash) || hash,
        currentHash: hash,
        artifactRef: currentRef,
        artifactVersion,
        nextArtifactVersion: artifactVersion + 1,
        checkpoint: {},
      };
    });
  },
  verify(ctx, activity) {
    const ref = textOf(activity.artifactRef);
    if (!ref) return { ok: false, sourceHash: activity.sourceHash, code: 'artifact-missing' };
    const resolved = resolveInsideWorkspace(ctx.workspace, ref);
    return then(readOptional(ctx, resolved.absolute), text => {
      if (text === null) return { ok: false, sourceHash: activity.sourceHash, code: 'artifact-missing' };
      const hash = sha256Hex(text);
      const ok = hash === activity.sourceHash;
      return { ok, sourceHash: hash, code: ok ? '' : 'artifact-changed' };
    });
  },
};

/**
 * Resolve a write target to the document it names (v1.2 §2 write completion / slot targetRef).
 *
 *   `drafts/city-observation`              → document `city-observation`
 *   `drafts/city-observation-9c765084/v2.md` → document `city-observation` (same document!)
 *   `城市观察`                              → no path, so the title itself names it
 *
 * A trailing `-<8 hex>` directory suffix is stripped before hashing, so a re-derived slug is
 * stable: naming the same document twice can never open a second draft.
 */
/** Small helpers for the write adapter's document resolution (v1.2 §2). */
function dedupeStrings(values) {
  const out = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

/** First slug that already has a draft on disk, else null (sync or async ports). */
function existingDraftOf(ctx, slugs, index = 0) {
  if (index >= slugs.length) return null;
  return then(latestDraftOnDisk(ctx, slugs[index]), existing => (
    existing ? { slug: slugs[index], existing } : existingDraftOf(ctx, slugs, index + 1)
  ));
}
function documentRefOf(rawTarget) {
  const ref = textOf(rawTarget);
  if (!ref.includes('/')) return { title: '', slugSource: '' };
  const parts = ref.split('/').filter(Boolean);
  if (!parts.length) return { title: '', slugSource: '' };
  const last = parts[parts.length - 1];
  const isVersionFile = /^v\d+\.md$/i.test(last);
  const documentSegment = isVersionFile && parts.length >= 2 ? parts[parts.length - 2] : last;
  const stem = documentSegment.replace(/\.md$/i, '').replace(/-[0-9a-f]{8}$/i, '');
  return { title: stem, slugSource: stem };
}
/** Latest existing draft version for a slug, probed sequentially (sync or async ports). */
function latestDraftOnDisk(ctx, slug, version = 1, latest = null) {
  const ref = `${ctx.draftsDir}/${slug}/v${version}.md`;
  let resolved;
  try {
    resolved = resolveInsideWorkspace(ctx.workspace, ref);
  } catch {
    return latest;
  }
  return then(readOptional(ctx, resolved.absolute), text => {
    if (text === null) return latest;
    const entry = { version, text, history: [...(latest?.history ?? []), { version, hash: sha256Hex(text), ref }].slice(-MAX_PROBE_VERSIONS) };
    if (version >= MAX_DRAFT_SCAN) throw new RuntimeError('workspace-denied', 'draft version scan limit reached; manual review required');
    return latestDraftOnDisk(ctx, slug, version + 1, entry);
  });
}

const bilibiliAdapter = {
  id: 'bilibili',
  capability: ADAPTER_CAPABILITY.bilibili,
  requires: Object.freeze(['ports.runBilibili']),
  produces: Object.freeze(['roundEvidence']),
  evidenceFields: Object.freeze(['roundEvidence', 'reality']),
  describe(ctx) {
    const port = describePort(ctx?.ports, 'runBilibili');
    if (port.available && ctx.ports.runBilibili.available?.() === false) {
      return { available: false, port: port.port, reason: 'provider-not-ready' };
    }
    return port;
  },
  prepare(_ctx, { target } = {}) {
    if (target !== BILIBILI_TARGET) throw new RuntimeError('source-invalid', 'Bilibili requires its duty target');
    return {
      sourceRef: BILIBILI_TARGET,
      sourceHash: sha256Hex(BILIBILI_TARGET),
      totalUnits: 0,
      consumedFrom: 0,
      checkpoint: { unit: 'round' },
    };
  },
  verify(_ctx, activity) {
    // Recovery validates the binding. Execution still has to consult the durable round journal.
    return activity.target === BILIBILI_TARGET && activity.sourceRef === BILIBILI_TARGET
      && activity.sourceHash === sha256Hex(BILIBILI_TARGET)
      ? { ok: true }
      : { ok: false, code: 'source-changed' };
  },
};

export const ADAPTERS = Object.freeze({ read: readAdapter, explore: exploreAdapter, write: writeAdapter, bilibili: bilibiliAdapter });

export function adapterFor(id) {
  const adapter = ADAPTERS[String(id ?? '')];
  if (!adapter) throw new RuntimeError('adapter-unavailable', `unknown activity adapter: ${String(id)}`);
  return adapter;
}

/** All three adapters with their availability, requirements, products and evidence fields. */
export function listAdapters(context = null) {
  const ctx = context ?? adapterContext({});
  return ADAPTER_IDS.map(id => {
    const adapter = ADAPTERS[id];
    const described = adapter.describe(ctx);
    return Object.freeze({
      id,
      capability: adapter.capability,
      available: described.available === true,
      port: described.port,
      reason: described.reason ?? '',
      requires: [...adapter.requires],
      produces: [...adapter.produces],
      evidenceFields: [...adapter.evidenceFields],
    });
  });
}

/**
 * Capability directory for `read`/`explore`/`write` (contract §6). A missing port reports
 * `{available:false, reason:'port-not-mounted'}`: an adapter never claims to be usable
 * just because its code exists.
 */
export function describeAdapters({ ports = {}, config = null, workspace = '' } = {}) {
  const ctx = adapterContext({ ports, config, workspace });
  const out = {};
  for (const entry of listAdapters(ctx)) {
    out[entry.id] = { available: entry.available, port: entry.port, reason: entry.reason };
  }
  return out;
}

/** The adapter contract table used by tests and the implementation notes (P2-21). */
export function adapterContract(context = null) {
  return listAdapters(context);
}
