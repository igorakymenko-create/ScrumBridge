import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeSession, sleep } from './helpers.mjs';

describe('how long the agent waits for the answer of the Product Owner', () => {
  let s;
  // AIST_WAIT_MS is empty: the setting of the user counts, as in real life
  before(async () => { s = await startServer({ session: makeSession(), env: { AIST_WAIT_MS: '' } }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));

  it('is 10 minutes by default, and the setting is read from the user config, not from the project', async () => {
    const r = (await s.api('GET', '/api/settings')).json;
    assert.deepEqual([r.waitSeconds, r.defaultWaitSeconds, r.fromEnvironment], [600, 600, false]);
  });

  it('can be changed, is kept outside the project, and must stay within sensible limits', async () => {
    assert.equal((await s.api('PUT', '/api/settings', { waitSeconds: 45 })).json.waitSeconds, 45);
    assert.equal((await s.api('GET', '/api/settings')).json.waitSeconds, 45);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.config, 'settings.json'), 'utf8')).waitSeconds, 45);
    assert.ok(!s.exists('.ai-team/settings.json'));
    for (const bad of [1, 4, 3601, 'abc', null]) assert.equal((await s.api('PUT', '/api/settings', { waitSeconds: bad })).status, 400, `rejects ${bad}`);
    assert.equal((await s.api('GET', '/api/settings')).json.waitSeconds, 45, 'a rejected value changes nothing');
  });

  it('can be changed from a browser tab of any project: it is not a setting of a project', async () => {
    const r = await s.api('PUT', '/api/settings', { waitSeconds: 60 }, { ...s.cookie, 'X-Aist-Project': 'ffffffffffff' });
    assert.equal(r.status, 200);
  });

  it('is what ask_po really waits for', async () => {
    await s.api('PUT', '/api/settings', { waitSeconds: 5 });
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const started = Date.now();
    const r = await s.mcp('ask_po', { question: 'How long?' });
    const took = Date.now() - started;
    assert.ok(took >= 4800 && took < 8000, `waited ${took} ms`);
    assert.match(r.text, /NOT answered yet \(the app waited 0\.1 min\)/);
  });

  it('is cut short by the answer: the call returns as soon as the Product Owner answers', async () => {
    await s.api('PUT', '/api/settings', { waitSeconds: 600 });
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const started = Date.now();
    const asked = s.mcp('ask_po', { question: 'Slow answer?' });
    await sleep(2500);
    await s.api('POST', '/api/progress/answer', { id: 'AQ-1', optionId: 'A', text: 'Yes', decisionId: 'D-5' });
    const r = await asked;
    assert.ok(Date.now() - started < 6000);
    assert.match(r.text, /AQ-1 is answered by the Product Owner: Yes/);
  });
});

describe('progress notifications while the agent waits', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession(), env: { AIST_WAIT_MS: '2500', AIST_PROGRESS_MS: '400' } }); });
  after(() => s.stop());

  const call = async (name, args, withToken) => {
    const res = await fetch(s.base + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(withToken ? { _meta: { progressToken: 'tok-1' } } : {}) } }),
    });
    return res.text();
  };

  it('are sent to a client that asked for them, so that clients which reset their timeout on progress keep waiting', async () => {
    const out = await call('ask_po', { question: 'Notify me?' }, true);
    const n = (out.match(/notifications\/progress/g) || []).length;
    assert.ok(n >= 2, `got ${n} notifications`);
    assert.match(out, /"progressToken":"tok-1"/);
    assert.match(out, /Waiting for the Product Owner to answer in the chat/);
    assert.match(out, /NOT answered yet/, 'and the final result still arrives');
  });

  it('are not sent to a client that did not ask for them', async () => {
    await s.api('DELETE', '/api/progress');
    const out = await call('ask_po', { question: 'Silent?' }, false);
    assert.ok(!out.includes('notifications/progress'));
  });
});

describe('the same question asked again', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());

  it('is not a second question: the Product Owner is asked once, and both calls wait for the same answer', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const first = s.mcp('ask_po', { question: 'Which exit code?' });
    await sleep(300);
    const second = s.mcp('ask_po', { question: 'Which exit code?' }); // the agent retried after a timeout of its own
    await sleep(300);
    const p = (await s.api('GET', '/api/progress')).json;
    assert.equal(p.questions.length, 1);
    assert.equal(p.blockers.length, 1);
    await s.api('POST', '/api/progress/answer', { id: 'AQ-1', optionId: 'A', text: '2', decisionId: 'D-7' });
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.text, /AQ-1 is answered by the Product Owner: 2/);
    assert.match(b.text, /AQ-1 is answered by the Product Owner: 2/);
    assert.equal((await s.api('GET', '/api/progress')).json.questions.length, 1, 'still one question');
  });

  it('is a new question when the text differs', async () => {
    await s.api('DELETE', '/api/progress');
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    await s.mcp('ask_po', { question: 'A?' });
    await s.mcp('ask_po', { question: 'B?' });
    assert.equal((await s.api('GET', '/api/progress')).json.questions.length, 2);
  });
});
