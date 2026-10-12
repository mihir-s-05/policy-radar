const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), clear: () => data.clear() };
}

function load(localStorage, sessionStorage) {
  function module(file, imports = {}) {
    const exports = {};
    const source = fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, require: name => imports[name], localStorage, sessionStorage });
    return exports;
  }
  return module('settingsStorage.ts', { './modelCatalog': module('modelCatalog.ts') });
}

function settings(api) {
  const value = JSON.parse(JSON.stringify(api.DEFAULT_SETTINGS));
  value.apiKeys.openai = 'synthetic-model-key';
  value.embedding.apiKeys.openai = 'synthetic-embedding-key';
  value.customModels = [{base_url:'https://synthetic.example/v1', model_name:'test', api_key:'synthetic-custom-key'}];
  return value;
}

test('credentials survive tab reloads but never enter persistent settings', () => {
  const local = storage(), tab = storage(), api = load(local, tab);
  api.saveSettings(settings(api));
  const persistent = local.getItem('policy-radar-settings');
  assert.equal(persistent.includes('synthetic-'), false);
  assert.equal(load(local, tab).loadSettings().apiKeys.openai, 'synthetic-model-key');
  assert.equal(load(local, tab).loadSettings().embedding.apiKeys.openai, 'synthetic-embedding-key');
  assert.equal(load(local, tab).loadSettings().customModels[0].api_key, 'synthetic-custom-key');
  tab.clear();
  assert.equal(load(local, tab).loadSettings().apiKeys.openai, undefined);
});

test('legacy credentials and picker models are removed on migration', () => {
  const local = storage(), tab = storage(), api = load(local, tab);
  const legacy = settings(api);
  legacy.model = 'retired-model';
  legacy.providerModels = { openai: ['retired-model'] };
  local.setItem('policy-radar-settings', JSON.stringify(legacy));
  const restored = api.loadSettings();
  assert.equal(restored.model, 'gpt-6.1-sol');
  assert.equal(JSON.stringify(restored.providerModels), '{}');
  assert.equal(restored.apiKeys.openai, undefined);
  assert.equal(local.getItem('policy-radar-settings').includes('synthetic-'), false);
});

test('blocked tab storage uses memory and still sanitizes legacy persistent keys', () => {
  const local = storage(), blocked = { getItem() {throw Error('denied');}, setItem() {throw Error('denied');} };
  const api = load(local, blocked);
  local.setItem('policy-radar-settings', JSON.stringify(settings(api)));
  api.loadSettings();
  assert.equal(local.getItem('policy-radar-settings').includes('synthetic-'), false);
  api.saveSettings(settings(api));
  assert.equal(api.loadSettings().apiKeys.openai, 'synthetic-model-key');
  assert.equal(local.getItem('policy-radar-settings').includes('synthetic-'), false);
});
