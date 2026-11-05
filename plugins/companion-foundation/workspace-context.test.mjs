import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionAdapter, isCompanionWorkspace, workspaceRoute, COMPANION_PROVIDER, SOURCE_PROVIDER } from './workspace-context.mjs';

const workspace = 'C:/Users/bobo/Documents/Bot/dsh-companion/workspace';
test('only exact companion workspace receives 256k route, independent of preset', () => {
  const config = { provider: SOURCE_PROVIDER, model: 'deepseek-v4.1-flash', reasoningEffort: 'max' };
  assert.equal(workspaceRoute(config, workspace).provider, COMPANION_PROVIDER);
  assert.equal(workspaceRoute(config, 'c:\\USERS\\bobo\\Documents\\Bot\\dsh-companion\\workspace\\').provider, COMPANION_PROVIDER);
  for (const cwd of ['C:/Users/bobo/Documents/Bot/dsh-companion', workspace + '-other', undefined]) {
    assert.equal(workspaceRoute(config, cwd).provider, SOURCE_PROVIDER);
    assert.equal(workspaceRoute({ ...config, provider: COMPANION_PROVIDER }, cwd).provider, SOURCE_PROVIDER);
  }
  assert.equal(workspaceRoute({ provider: 'other' }, workspace).provider, 'other');
  assert.equal(isCompanionWorkspace(workspace + '/child'), false);
});
test('adapter changes metadata only and forwards original route, headers, images and controls', async () => {
  let streamed;
  const model = { provider: SOURCE_PROVIDER, id: 'deepseek-v4.1-flash', name: 'Flash',
    context: { contextWindow: 524288 }, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'max', name: 'Max' }] } };
  const source = { resolveModel: async () => model, listModels: async () => [model],
    providerRetryPolicy: () => undefined, imagePricing: () => ({ base: 5 }), imageRequestTarget: (_p, _m, image) => image,
    prepareCall: async () => ({ model, stream: options => { streamed = options; return 'original-dispatch' } }) };
  const alias = createCompanionAdapter({ registration: provider => { assert.equal(provider, SOURCE_PROVIDER); return { adapter: source } } });
  assert.equal((await alias.resolveModel(COMPANION_PROVIDER, model.id)).context.contextWindow, 262144);
  assert.equal(model.context.contextWindow, 524288, 'other workspaces keep original metadata');
  const prepared = await alias.prepareCall(COMPANION_PROVIDER, model.id);
  assert.equal(prepared.model.context.contextWindow, 262144);
  const input = { provider: COMPANION_PROVIDER, model: model.id, reasoningEffort: 'max', maxTokens: 2048,
    sessionId: 'qq-dm-test', headers: { 'x-test': 'kept' }, messages: [{ content: [{ type: 'image' }] }] };
  assert.equal(prepared.stream(input), 'original-dispatch');
  assert.deepEqual(streamed, { ...input, provider: SOURCE_PROVIDER });
  assert.deepEqual(prepared.model.reasoning, model.reasoning);
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image']);
});
