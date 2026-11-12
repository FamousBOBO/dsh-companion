/**
 * P0-B regression: a **preset must not re-declare a host-plane registry service**.
 *
 * The failure this pins down, found by the real-host acceptance run
 * (`docs/15-wardrobe-host-acceptance.md` §8):
 *
 *   session/create { agentPreset: "companion" }
 *   → agent-preset/invalid — skill (@deepseek-ai/dsh-skill):
 *     service "skills" has been registered at <SkillRegistry>
 *
 * The cause is one line: `config/profile/companion.patch.template.yml` declared `- id: skill`
 * inside `preset-companion.plugins`. `@deepseek-ai/dsh-skill` is the skill **registry service**,
 * and the host plane already mounts it (`dsh-web-app/cordis.patch.yml` keeps `skill` and only
 * disables `skill-filesystem` / `tool-skill`). A preset that mounts it again tries to register
 * the same service into a realm that already has it, and *the whole preset fails to mount* — so
 * no companion session could be created at all.
 *
 * The shipped presets (`standard`, `ptc`, `minimal`, `cordis`) declare only:
 *   - `skill-filesystem` — this preset's own skill discovery, into the preset's layer;
 *   - `tool-skill`       — the catalog + loader tools for this preset's agent.
 *
 * No YAML dependency is used on purpose: the suite ships no YAML parser, and these assertions
 * only need indentation, which a two-space scanner reads exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const PROFILE_DIR = path.join(repositoryRoot, 'config', 'profile');
const TEMPLATE = path.join(PROFILE_DIR, 'companion.patch.template.yml');
const GENERATED = path.join(PROFILE_DIR, 'companion.patch.yml');

/** Services that live on the host plane and must never be re-declared by a preset. */
const HOST_PLANE_SERVICES = ['skill'];

/**
 * Read `plugins:` rows out of a profile patch, per preset.
 *
 * Returns `Map<presetId, {ids, entries}>` where `entries` keeps the package name declared next
 * to each `- id:` row, which is what makes a "same service, different plugin" mistake visible.
 */
function readPresets(text) {
  const lines = text.split(/\r?\n/);
  const presets = new Map();
  let current = null;
  let inPlugins = false;
  let pending = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    // `        id: companion` inside a `- id: preset-companion` block names the preset.
    const presetId = /^id:\s*(\S+)\s*$/.exec(trimmed);
    if (presetId && indent <= 10 && current === null && !inPlugins) {
      current = presetId[1];
      presets.set(current, { ids: [], entries: [] });
      continue;
    }
    if (trimmed === 'plugins:') {
      inPlugins = true;
      continue;
    }
    if (!inPlugins || current === null) continue;

    const pluginId = /^-\s*id:\s*(\S+)\s*$/.exec(trimmed);
    if (pluginId) {
      pending = { id: pluginId[1], name: '' };
      presets.get(current).ids.push(pluginId[1]);
      presets.get(current).entries.push(pending);
      continue;
    }
    const pluginName = /^name:\s*['"]?([^'"]+?)['"]?\s*$/.exec(trimmed);
    if (pluginName && pending && !pending.name) {
      pending.name = pluginName[1];
      continue;
    }
    // A top-level list item at column 0 starts a new patch entry; the preset block is over.
    if (indent === 0 && trimmed.startsWith('-')) {
      inPlugins = false;
      current = null;
      pending = null;
    }
  }
  return presets;
}

/** Read the generated profile and the template; the generated file may be absent. */
function readProfiles() {
  const out = { template: fs.readFileSync(TEMPLATE, 'utf8'), generated: null };
  if (fs.existsSync(GENERATED)) out.generated = fs.readFileSync(GENERATED, 'utf8');
  return out;
}

test('P0-B：companion 预设不声明宿主 plane 的 skill 注册表服务', () => {
  const { template } = readProfiles();
  const presets = readPresets(template);
  const companion = presets.get('companion');
  assert.ok(companion, '模板里必须有 preset-companion 块');

  for (const service of HOST_PLANE_SERVICES) {
    assert.ok(
      !companion.ids.includes(service),
      `preset companion 不得声明 - id: ${service}（宿主 plane 已经注册了该服务，重复声明会让整个预设挂载失败）`,
    );
    assert.ok(
      !companion.entries.some(entry => entry.name.includes(`dsh-${service}`) && !entry.name.includes(`${service}-`)),
      `preset companion 不得引入 @deepseek-ai/dsh-${service} 包`,
    );
  }
});

test('P0-B：技能能力仍然完整——skill-filesystem 与 tool-skill 都还在', () => {
  const { template } = readProfiles();
  const companion = readPresets(template).get('companion');
  // Removing the registry row must not remove the ability to *read* skill files: that is what
  // these two rows do, and dropping either would silently empty the skill catalog.
  assert.ok(companion.ids.includes('skill-filesystem'), 'skill-filesystem 必须保留（预设自己的技能发现）');
  assert.ok(companion.ids.includes('tool-skill'), 'tool-skill 必须保留（把目录与加载工具交给 agent）');

  const names = companion.entries.map(entry => entry.name);
  assert.ok(names.includes('@deepseek-ai/dsh-skill-filesystem'));
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'));

  // And nothing unrelated was dropped along the way: these are the tools the preset promised.
  for (const id of ['tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-schedule', 'time-context', 'agent-instructions']) {
    assert.ok(companion.ids.includes(id), `preset companion 仍应声明 ${id}`);
  }
});

test('P0-B：每个 id 在一个预设里只出现一次（重复声明本身就是这类故障）', () => {
  const { template } = readProfiles();
  for (const [presetId, preset] of readPresets(template)) {
    const seen = new Set();
    for (const id of preset.ids) {
      assert.ok(!seen.has(id), `preset ${presetId} 重复声明了 - id: ${id}`);
      seen.add(id);
    }
  }
});

test('P0-B：生成的 profile 里同样没有 skill 注册表行', () => {
  const { generated } = readProfiles();
  if (!generated) {
    // `config/profile/companion.patch.yml` is generated by `npm run setup` and is git-ignored
    // locally; on a clean checkout it does not exist. Absent is fine, stale is not.
    return;
  }
  const companion = readPresets(generated).get('companion');
  assert.ok(companion, '生成的 profile 里必须有 preset-companion 块');
  for (const service of HOST_PLANE_SERVICES) {
    assert.ok(!companion.ids.includes(service), `生成的 profile 不得声明 - id: ${service}；重新跑 npm run setup`);
  }
  // The generated profile legitimately differs from the template: `npm run setup` strips the
  // optional blocks (`#@@begin:media` …) of every module the operator switched off. What must
  // never differ is whether the host-plane registry row is re-declared, and whether the two
  // skill rows that carry the actual ability survive whenever the template has them.
  if (companion.ids.includes('tool-skill') || companion.ids.includes('skill-filesystem')) {
    assert.ok(companion.ids.includes('skill-filesystem'), '生成的 profile 仍需要 skill-filesystem');
    assert.ok(companion.ids.includes('tool-skill'), '生成的 profile 仍需要 tool-skill');
  }
});

test('P0-B：与宿主自带预设的声明方式一致（声明了 tool-skill 的预设也不声明 skill）', () => {
  const shippedDir = process.env.DSH_COMPANION_MODULE_ROOT
    ? path.join(String(process.env.DSH_COMPANION_MODULE_ROOT), '@deepseek-ai', 'dsh-web-app', 'presets')
    : '';
  if (!shippedDir || !fs.existsSync(shippedDir)) {
    // Without the desktop app there is nothing to compare against; the assertions above already
    // pin the invariant, so this comparison is a bonus rather than the load-bearing check.
    return;
  }
  const files = fs.readdirSync(shippedDir).filter(name => name.endsWith('.patch.yml'));
  assert.ok(files.length >= 4, `宿主自带预设数量异常：${JSON.stringify(files)}`);
  let sawSkillPair = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(shippedDir, file), 'utf8');
    // `minimal` deliberately ships no skill surface at all, so the pair is asserted only where
    // the preset does give its agent the loader. What holds for every preset: never the registry.
    for (const service of HOST_PLANE_SERVICES) {
      assert.doesNotMatch(
        text,
        new RegExp(`^\\s*-\\s*id:\\s*${service}\\s*$`, 'm'),
        `宿主自带的 ${file} 也不应声明 - id: ${service}；若它变了，本套件的判断依据要一起复核`,
      );
    }
    if (/-\s*id:\s*tool-skill/.test(text)) {
      sawSkillPair += 1;
      assert.match(text, /-\s*id:\s*skill-filesystem/, `${file} 声明了 tool-skill，就应同时声明 skill-filesystem`);
    }
  }
  assert.ok(sawSkillPair >= 3, `应有至少三个自带预设声明 tool-skill，实际 ${sawSkillPair}`);
});
