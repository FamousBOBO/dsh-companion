/**
 * Bundle layout, hashing and atomic file IO for the migration CLI.
 *
 * A bundle is a plain directory, never a single archive: the operator can open
 * it, diff it and delete it without special tooling. Nothing is written in place
 * — every file goes to `.partial-<pid>` first and is renamed, so an interrupted
 * run leaves no half-written artifact that `check` would then accept.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FORMAT = 'dsh-companion-migration';
export const FORMAT_VERSION = 1;

/** Every path inside a bundle. Relative to the bundle root, always POSIX-style. */
export const BUNDLE_FILES = {
  manifest: 'MANIFEST.json',
  bundle: 'bundle.json',
  domains: 'domains',
};

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable identity fingerprint: no plaintext identifiers leave the machine's own files. */
export function fingerprint(parts) {
  return `sha256:${sha256Text(JSON.stringify(parts))}`;
}

export function readJson(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`缺少必需文件：${file}`);
    return null;
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error.message}`);
  }
}

/** Write JSON atomically (temp file in the same directory, then rename). */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Files below `dir`, as POSIX-style paths relative to `dir`. Symlinks are not followed. */
export function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

/** Build a manifest entry list from the files that were actually written. */
export function buildManifest(bundleRoot, entries) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    files: entries.map((entry) => ({
      path: toPosix(entry.path),
      domain: entry.domain,
      bytes: fs.statSync(path.join(bundleRoot, entry.path)).size,
      sha256: sha256File(path.join(bundleRoot, entry.path)),
      required: entry.required !== false,
    })),
  };
}

export const BUNDLE_DIRNAME_RE = /^dsh-companion-(\d+\.\d+\.\d+|\d+\.\d+\.\d+[-+][0-9A-Za-z.-]+)-(\d{8})-(\d{6})$/;

/** `dsh-companion-0.1.0-20261105-204000` */
export function defaultBundleDirname(suiteVersion, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const value = `${stamp.slice(0, 8)}-${stamp.slice(9, 15)}`;
  return `dsh-companion-${suiteVersion}-${value}`;
}

export function homeRelative(file) {
  const home = os.homedir();
  return file.startsWith(home) ? path.join('~', path.relative(home, file)) : file;
}

export default {
  FORMAT,
  FORMAT_VERSION,
  BUNDLE_FILES,
  sha256File,
  sha256Text,
  fingerprint,
  readJson,
  writeJson,
  writeText,
  ensureDir,
  listFiles,
  toPosix,
  buildManifest,
  defaultBundleDirname,
  homeRelative,
};
