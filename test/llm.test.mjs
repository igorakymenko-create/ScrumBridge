import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, startMockProviders } from './helpers.mjs';

const gen = (s, provider, model, extra = {}) => s.api('POST', '/api/llm/generate', { provider, model, system: 'SYS', prompt: 'PROMPT', json: true, temperature: 0.7, ...extra });

describe('model providers', () => {
  let s, mock;
  before(async () => { mock = await startMockProviders(); s = await startServer(); });
  after(async () => { await s.stop(); await mock.close(); });

  const add = (type, label, baseUrl) => s.api('POST', '/api/llm/providers', { type, label, baseUrl });

  it('comes with Gemini, Anthropic and OpenAI ready to take a key', async () => {
    const r = await s.api('GET', '/api/llm/providers');
    assert.deepEqual(r.json.connections.map(c => c.id), ['gemini', 'anthropic', 'openai']);
    assert.ok(r.json.connections.every(c => c.hasKey === false));
    assert.deepEqual(r.json.types.map(t => t.type), ['gemini', 'anthropic', 'openai']);
  });

  it('adds and removes connections, rejecting a bad type or base URL', async () => {
    const c = (await add('openai', 'My Local', mock.url + '/openai/v1')).json;
    assert.equal(c.id, 'my-local');
    const again = (await add('openai', 'My Local', mock.url + '/openai/v1')).json;
    assert.equal(again.id, 'my-local-2', 'ids stay unique');
    assert.equal((await add('nope', 'X', '')).status, 400);
    assert.equal((await add('openai', 'X', 'ftp://host')).status, 400);
    assert.equal((await s.api('DELETE', '/api/llm/providers?id=my-local-2')).status, 200);
    assert.equal((await s.api('DELETE', '/api/llm/providers?id=my-local-2')).status, 404);
  });

  describe('keys', () => {
    it('never travel back to the browser', async () => {
      const put = await s.api('PUT', '/api/llm/key', { provider: 'anthropic', key: 'sk-ant-secret-value-0001' });
      assert.equal(put.json.ok, true);
      const list = await s.api('GET', '/api/llm/providers');
      assert.ok(!list.text.includes('secret-value'), 'the key must not appear in the provider list');
      assert.equal(list.json.connections.find(c => c.id === 'anthropic').hasKey, true);
    });

    it('go to the file fallback in the user config folder (not the project) when no credential store is used', () => {
      const file = path.join(s.config, 'credentials.json');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).anthropic, 'sk-ant-secret-value-0001');
      assert.ok(!fs.existsSync(path.join(s.project, '.ai-team', 'credentials.json')));
    });

    it('are validated and can be removed', async () => {
      assert.equal((await s.api('PUT', '/api/llm/key', { provider: 'anthropic', key: 'x' })).status, 400);
      assert.equal((await s.api('PUT', '/api/llm/key', { provider: 'ghost', key: 'sk-long-enough-key' })).status, 400);
      assert.equal((await s.api('DELETE', '/api/llm/key?provider=anthropic')).status, 200);
      const gone = (await s.api('GET', '/api/llm/providers')).json.connections.find(c => c.id === 'anthropic');
      assert.equal(gone.hasKey, false);
    });
  });

  it('refuses to call a provider that has no key', async () => {
    const r = await gen(s, 'gemini', 'm');
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /no API key/);
  });

  describe('OpenAI-compatible', () => {
    let id;
    before(async () => { id = (await add('openai', 'Mock OpenAI', mock.url + '/openai/v1')).json.id; });

    it('works against a local URL without a key and sends JSON mode, system and user messages', async () => {
      mock.seen.length = 0;
      const r = await gen(s, id, 'gpt-a');
      assert.deepEqual(r.json, { text: '{"ok":true}', usage: { in: 11, out: 7 } });
      const sent = mock.seen[0];
      assert.deepEqual(sent.body.response_format, { type: 'json_object' });
      assert.deepEqual(sent.body.messages.map(m => m.role), ['system', 'user']);
      assert.equal(sent.headers.authorization, undefined);
    });

    it('sends the key as a Bearer token when there is one', async () => {
      await s.api('PUT', '/api/llm/key', { provider: id, key: 'sk-local-key-12345' });
      mock.seen.length = 0;
      await gen(s, id, 'gpt-a');
      assert.equal(mock.seen[0].headers.authorization, 'Bearer sk-local-key-12345');
    });

    it('retries without JSON mode when the server does not support it', async () => {
      mock.seen.length = 0;
      const r = await gen(s, id, 'no-json-mode');
      assert.equal(r.status, 200);
      assert.equal(mock.seen.length, 2);
      assert.equal(mock.seen[1].body.response_format, undefined);
    });

    it('retries without temperature when the model fixes it', async () => {
      mock.seen.length = 0;
      const r = await gen(s, id, 'fixed-temp');
      assert.equal(r.status, 200);
      assert.equal(mock.seen[1].body.temperature, undefined);
    });

    it('marks an exhausted quota as final and passes the retry hint of a rate limit', async () => {
      const quota = await gen(s, id, 'quota');
      assert.equal(quota.status, 429);
      assert.equal(quota.json.error.daily, true);
      const rate = await gen(s, id, 'slow-down');
      assert.equal(rate.status, 429);
      assert.equal(rate.json.error.retryAfter, 3000);
      assert.equal(rate.json.error.daily, false);
    });

    it('reports an empty answer instead of returning nothing', async () => {
      const r = await gen(s, id, 'empty');
      assert.ok(r.status >= 400);
      assert.match(r.json.error.message, /empty answer/);
    });

    it('lists models sorted', async () => {
      assert.deepEqual((await s.api('GET', `/api/llm/models?provider=${id}`)).json.models, ['gpt-a', 'gpt-b']);
    });
  });

  describe('Anthropic', () => {
    let id;
    before(async () => { id = (await add('anthropic', 'Mock Claude', mock.url + '/claude/v1')).json.id; });

    it('needs a key, then sends the version header, max_tokens and the system prompt separately', async () => {
      assert.equal((await gen(s, id, 'claude-x')).status, 401);
      await s.api('PUT', '/api/llm/key', { provider: id, key: 'sk-ant-test-key-1234' });
      mock.seen.length = 0;
      const r = await gen(s, id, 'claude-x');
      assert.deepEqual(r.json, { text: '{"claude":true}', usage: { in: 21, out: 5 } });
      const sent = mock.seen[0];
      assert.equal(sent.headers['x-api-key'], 'sk-ant-test-key-1234');
      assert.equal(sent.headers['anthropic-version'], '2023-06-01');
      assert.equal(sent.body.system, 'SYS');
      assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'PROMPT' }]);
      assert.ok(sent.body.max_tokens > 1000);
    });

    it('passes a rejected key through as an error', async () => {
      await s.api('PUT', '/api/llm/key', { provider: id, key: 'sk-ant-wrong-key-9999' });
      const r = await gen(s, id, 'claude-x');
      assert.equal(r.status, 401);
      assert.match(r.json.error.message, /invalid x-api-key/);
    });

    it('lists models', async () => {
      await s.api('PUT', '/api/llm/key', { provider: id, key: 'sk-ant-test-key-1234' });
      assert.deepEqual((await s.api('GET', `/api/llm/models?provider=${id}`)).json.models, ['claude-x']);
    });
  });

  describe('Gemini', () => {
    let id;
    before(async () => { id = (await add('gemini', 'Mock Gemini', mock.url + '/gemini')).json.id; });

    it('sends the key in a header (never in the URL), skips thought parts and counts thinking tokens', async () => {
      await s.api('PUT', '/api/llm/key', { provider: id, key: 'AIzaMockGeminiKey123' });
      mock.seen.length = 0;
      const r = await gen(s, id, 'g-1');
      assert.deepEqual(r.json, { text: '{"gemini":true}', usage: { in: 5, out: 5 } });
      assert.ok(!mock.seen[0].url.includes('AIza'), 'the key must not be in the URL');
      assert.equal(mock.seen[0].headers['x-goog-api-key'], 'AIzaMockGeminiKey123');
      assert.equal(mock.seen[0].body.generationConfig.responseMimeType, 'application/json');
    });

    it('lists only models that can generate', async () => {
      assert.deepEqual((await s.api('GET', `/api/llm/models?provider=${id}`)).json.models, ['g-1']);
    });
  });
});

describe('keys from environment variables', () => {
  let s;
  before(async () => { s = await startServer({ env: { ANTHROPIC_API_KEY: 'sk-ant-from-environment-01' } }); });
  after(() => s.stop());

  it('are used for the default connection of the same type and reported as such', async () => {
    const c = (await s.api('GET', '/api/llm/providers')).json.connections;
    assert.deepEqual([c.find(x => x.id === 'anthropic').hasKey, c.find(x => x.id === 'anthropic').source], [true, 'env']);
    assert.equal(c.find(x => x.id === 'openai').hasKey, false);
  });
});
