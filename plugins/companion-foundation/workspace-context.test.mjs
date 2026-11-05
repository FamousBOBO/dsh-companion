import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCompanionAdapter, isCompanionWorkspace, workspaceRoute, loadGuardConfig,
  COMPANION_PROVIDER, SOURCE_PROVIDER, COMPANION_WINDOW,
} from './workspace-context.mjs';

// The guard compares paths, so the test owns both sides of the comparison instead
// of borrowing a machine layout.
const workspace = 'C:/synthetic/suite/data/workspace';
const config = { provider: SOURCE_PROVIDER, model: 'synthetic-model', reasoningEffort: 'max' };

test('only the exact companion workspace gets the alias provider', () => {
  assert.equal(workspaceRoute(config, workspace, workspace).provider, COMPANION_PROVIDER);
  assert.equal(workspaceRoute(config, 'c:\\SYNTHETIC\\suite\\data\\workspace\\', workspace).provider, COMPANION_PROVIDER);
  for (const cwd of ['C:/synthetic/suite/data', workspace + '-other', undefined]) {
    assert.equal(workspaceRoute(config, cwd, workspace).provider, SOURCE_PROVIDER);
    assert.equal(workspaceRoute({ ...config, provider: COMPANION_PROVIDER }, cwd, workspace).provider, SOURCE_PROVIDER);
  }
  assert.equal(workspaceRoute({ provider: 'other' }, workspace, workspace).provider, 'other');
  assert.equal(isCompanionWorkspace(workspace + '/child', workspace), false);
});

test('adapter changes metadata only and forwards original route, headers, images and controls', async () => {
  let streamed;
  const model = { provider: SOURCE_PROVIDER, id: 'synthetic-model', name: 'Synthetic',
    context: { contextWindow: 524288 }, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'max', name: 'Max' }] } };
  const source = { resolveModel: async () => model, listModels: async () => [model],
    providerRetryPolicy: () => undefined, imagePricing: () => ({ base: 5 }), imageRequestTarget: (_p, _m, image) => image,
    prepareCall: async () => ({ model, stream: options => { streamed = options; return 'original-dispatch' } }) };
  const alias = createCompanionAdapter(
    { registration: provider => { assert.equal(provider, SOURCE_PROVIDER); return { adapter: source } } },
    { sourceProvider: SOURCE_PROVIDER, aliasProvider: COMPANION_PROVIDER, window: COMPANION_WINDOW },
  );
  assert.equal((await alias.resolveModel(COMPANION_PROVIDER, model.id)).context.contextWindow, COMPANION_WINDOW);
  assert.equal(model.context.contextWindow, 524288, 'other workspaces keep original metadata');
  const prepared = await alias.prepareCall(COMPANION_PROVIDER, model.id);
  assert.equal(prepared.model.context.contextWindow, COMPANION_WINDOW);
  const input = { provider: COMPANION_PROVIDER, model: model.id, reasoningEffort: 'max', maxTokens: 2048,
    sessionId: 'qq-dm-test', headers: { 'x-test': 'kept' }, messages: [{ content: [{ type: 'image' }] }] };
  assert.equal(prepared.stream(input), 'original-dispatch');
  assert.deepEqual(streamed, { ...input, provider: SOURCE_PROVIDER });
  assert.deepEqual(prepared.model.reasoning, model.reasoning);
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image']);
});

test('the guard is off unless a config file explicitly enables it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-context-'));
  try {
    const missing = loadGuardConfig({ dataRoot: root });
    assert.equal(missing.enabled, false, 'no config file means no adapter and no route rewrite');

    const file = path.join(root, 'home', 'companion', 'workspace-context.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ enabled: false })}\n`, 'utf8');
    assert.equal(loadGuardConfig({ dataRoot: root }).enabled, false, 'enabled:false stays off');

    fs.writeFileSync(file, `${JSON.stringify({ enabled: true, window: 131072, workspace: 'custom-workspace' })}\n`, 'utf8');
    const on = loadGuardConfig({ dataRoot: root });
    assert.equal(on.enabled, true);
    assert.equal(on.window, 131072);
    assert.equal(on.workspace, path.resolve(root, 'custom-workspace'));
    assert.equal(on.sourceProvider, SOURCE_PROVIDER);
    assert.equal(on.aliasProvider, COMPANION_PROVIDER);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
