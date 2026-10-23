import { testRoot } from './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_AT_TOKENS, COMPACTION_RESERVE_TOKENS, MODEL_OUTPUT_TOKENS, listProviderPresets, nativeModelDefinition } from '../src/provider-presets.mjs';
import { Providers, readProviders, testProvider } from '../src/providers.mjs';
import { getAppSettings, putAppSettings } from '../src/app-settings.mjs';
import { ConnectorManager } from '../src/connectors.mjs';

test('the shared catalog has usable, unique provider templates and distinguishes text from vision', () => {
  const presets = listProviderPresets();
  assert.equal(new Set(presets.map(p => p.id)).size, presets.length);
  assert.ok(presets.length >= 10);
  for (const p of presets) {
    assert.equal(new URL(p.baseUrl).protocol, 'https:');
    assert.ok(['openai', 'anthropic'].includes(p.protocol));
    assert.ok(p.models.length >= 1 && p.models.length <= 20);
    assert.equal(new Set(p.models.map(m => m.id)).size, p.models.length);
    assert.ok(!JSON.stringify(p).includes('apiKey'));
  }
  const silicon = presets.find(p => p.id === 'siliconflow');
  const multimodal = nativeModelDefinition(silicon, silicon.models.find(m => m.id === 'zai-org/GLM-5.3-Flash'));
  const textOnly = nativeModelDefinition(silicon, silicon.models.find(m => m.id === 'zai-org/GLM-5.3'));
  assert.deepEqual(multimodal.input, ['text', 'image']);
  assert.deepEqual(textOnly.input, ['text']);
  assert.equal(multimodal.compat.maxTokensField, 'max_tokens');
  assert.equal(multimodal.compat.requiresReasoningContentOnAssistantMessages, true);
  for (const id of ['deepseek-ai/DeepSeek-V4.1-Flash', 'zai-org/GLM-5.3-Flash', 'zai-org/GLM-5.3']) {
    assert.equal(nativeModelDefinition(silicon, silicon.models.find(m => m.id === id)).contextWindow, 1048576);
  }
  const gemini = presets.find(p => p.id === 'gemini');
  assert.equal(nativeModelDefinition(gemini, gemini.models[0]).compat.requiresReasoningContentOnAssistantMessages, false);
});

test('the 272K compaction point excludes native reserve and leaves room for the selected output policy', () => {
  const silicon = listProviderPresets().find(p => p.id === 'siliconflow');
  const model = nativeModelDefinition(silicon, silicon.models[0]);
  assert.equal(COMPACT_AT_TOKENS, 272000);
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.contextTokens - COMPACTION_RESERVE_TOKENS, 272000);
  assert.equal(model.maxTokens, MODEL_OUTPUT_TOKENS);
  const small = nativeModelDefinition({ protocol: 'openai', baseUrl: 'https://models.example/v1' }, { id: 'small', name: 'Small' });
  assert.equal(small.contextTokens - COMPACTION_RESERVE_TOKENS, COMPACT_AT_TOKENS);
  assert.ok(small.contextWindow >= small.contextTokens + small.maxTokens);
});

test('the Anthropic endpoint of a known vendor retains its reasoning and image capabilities', () => {
  const provider = { protocol: 'anthropic', baseUrl: 'https://zenmux.ai/api/anthropic' };
  const model = nativeModelDefinition(provider, { id: 'z-ai/glm-5.3-flash', name: 'GLM' });
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.contextTokens - COMPACTION_RESERVE_TOKENS, COMPACT_AT_TOKENS);
});

test('templates become accounts only after probing, preserve custom models and never return credentials', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'presets-'));
  const connectors = new ConnectorManager({ root, definitions: [] });
  const initial = getAppSettings(root);
  assert.equal(initial.providers.length, 1);
  assert.ok(initial.providerPresets.some(p => p.id === 'siliconflow'));
  assert.throws(() => putAppSettings(root, { model: { provider: 'siliconflow', id: 'deepseek-ai/DeepSeek-V4.1-Flash' } }));
  let probed;
  const manager = new Providers({ root, connectors, selected: () => getAppSettings(root).model, probe: async input => { probed = input; return { ok: true }; } });
  const preset = initial.providerPresets.find(p => p.id === 'siliconflow');
  const apiKey = 'fixture-provider-preset-secret';
  const input = { name: preset.name, baseUrl: preset.baseUrl, protocol: preset.protocol, apiKey,
    models: preset.models.map(({ id, name }) => ({ id, name })) };
  input.models.push({ id: 'my/new-model', name: '自定义模型' });
  const account = await manager.create(input);
  assert.equal(probed.model, preset.models[0].id);
  assert.equal(probed.protocol, 'openai');
  assert.notEqual(account.id, preset.id);
  assert.equal(account.models.at(-1).id, 'my/new-model');
  assert.ok(account.models[0].note.includes('图片'));
  const saved = putAppSettings(root, { model: { provider: account.id, id: preset.models[0].id } });
  assert.equal(saved.model.provider, account.id);
  assert.ok(!JSON.stringify(saved).includes(apiKey));
  assert.equal(readProviders(root).find(p => p.id === account.id).apiKey, apiKey);
  assert.equal(fs.statSync(path.join(root, 'system/providers.json')).mode & 0o777, 0o600);
  await assert.rejects(manager.remove(account.id), /先换/);
});

test('a failed preset probe does not save an account', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'preset-failed-'));
  const manager = new Providers({ root, connectors: new ConnectorManager({ root, definitions: [] }), selected: () => ({}), probe: async () => { throw new Error('HTTP 401'); } });
  await assert.rejects(manager.create({ name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', apiKey: 'fixture-rejected-key', models: [{ id: 'model', name: '模型' }] }), /401/);
  assert.equal(readProviders(root).length, 1);
});

test('the probe uses the OpenAI token parameter only on the official endpoint and redacts SiliconFlow errors', async () => {
  for (const [baseUrl, field] of [['https://api.openai.com/v1', 'max_completion_tokens'], ['https://api.siliconflow.cn/v1', 'max_tokens']]) {
    let sent;
    await testProvider({ protocol: 'openai', baseUrl, apiKey: 'fixture-probe-key', model: 'test' }, { request: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ choices: [] }); } });
    assert.equal(sent[field], 256);
    assert.equal(Object.keys(sent).filter(k => k.startsWith('max_')).length, 1);
  }
  await assert.rejects(testProvider({ protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'fixture-probe-key', model: 'test' },
    { request: async () => Response.json({ code: 20041, message: 'Unavailable fixture-probe-key' }, { status: 400 }) }), e => /HTTP 400.*Unavailable/.test(e.message) && !e.message.includes('fixture-probe-key'));
});
