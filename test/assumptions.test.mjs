import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeSession } from './helpers.mjs';

describe('assumptions of the agent', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));

  const progress = async () => (await s.api('GET', '/api/progress')).json;
  const resolve = (id, action, note) => s.api('POST', '/api/progress/assumption', { id, action, note });

  it('records an assumption for the story in progress without stopping the agent', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const r = await s.mcp('record_assumption', { text: 'The data file is called todos.json', why: 'matches the existing code; the alternative was data.json' });
    assert.ok(!r.isError);
    assert.match(r.text, /Assumption AS-1 recorded/);
    const p = await progress();
    assert.deepEqual([p.assumptions[0].id, p.assumptions[0].storyId, p.assumptions[0].status], ['AS-1', 'S-1', 'open']);
    assert.equal(p.stories['S-1'].status, 'in_progress', 'the story is not blocked');
    assert.match((await s.mcp('get_status')).text, /Assumptions waiting for the Product Owner: AS-1/);
    assert.match((await s.mcp('get_assumptions')).text, /AS-1 \[S-1\] open: The data file is called todos\.json/);
  });

  it('can be given a story explicitly and ignores an unknown one', async () => {
    await s.mcp('record_assumption', { text: 'a', why: 'b', storyId: 'S-3' });
    await s.mcp('record_assumption', { text: 'c', why: 'd', storyId: 'S-99' });
    const p = await progress();
    assert.equal(p.assumptions[0].storyId, 'S-3');
    assert.equal(p.assumptions[1].storyId, undefined);
  });

  it('is confirmed by the Product Owner without any change to the story', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    await s.mcp('record_assumption', { text: 'x', why: 'y' });
    assert.equal((await resolve('AS-1', 'confirm')).json.ok, true);
    const p = await progress();
    assert.equal(p.assumptions[0].status, 'confirmed');
    assert.equal(p.stories['S-1'].status, 'in_progress');
    assert.equal(p.stories['S-1'].rework, undefined);
    assert.doesNotMatch((await s.mcp('get_status')).text, /Assumptions waiting/);
  });

  it('sends a finished story back with the instruction of the Product Owner when rejected', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: true });
    await s.mcp('record_assumption', { text: 'The list hides finished tasks', why: 'guess', storyId: 'S-1' });
    assert.equal((await resolve('AS-1', 'reject', 'Show all tasks, finished ones too')).json.ok, true);
    const p = await progress();
    assert.equal(p.assumptions[0].status, 'rejected');
    assert.equal(p.stories['S-1'].status, 'todo', 'the story is back in the queue');
    const next = (await s.mcp('get_next_story')).text;
    assert.match(next, /^# S-1\./, 'it comes first again');
    assert.match(next, /## Rework required — instruction of the Product Owner \(binding, do this first\)/);
    assert.match(next, /Show all tasks, finished ones too/);
    assert.match((await s.mcp('get_assumptions')).text, /rejected: The list hides finished tasks — Product Owner: Show all tasks/);
  });

  it('keeps a story that is in progress in progress when its assumption is rejected, and clears the rework once it is done', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    await s.mcp('record_assumption', { text: 'x', why: 'y' });
    await resolve('AS-1', 'reject', 'Do it the other way');
    assert.equal((await progress()).stories['S-1'].status, 'in_progress');
    assert.match((await s.mcp('get_story', { id: 'S-1' })).text, /Do it the other way/);
    await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: true });
    assert.equal((await progress()).stories['S-1'].rework, undefined);
    assert.doesNotMatch((await s.mcp('get_story', { id: 'S-1' })).text, /Rework required/);
  });

  it('refuses a rejection without an instruction and answers for an unknown assumption', async () => {
    await s.mcp('record_assumption', { text: 'x', why: 'y' });
    assert.equal((await resolve('AS-1', 'reject', '   ')).status, 400);
    assert.equal((await resolve('AS-1', 'maybe')).status, 400);
    assert.equal((await resolve('AS-404', 'confirm')).json.ok, false);
    assert.equal((await progress()).assumptions[0].status, 'open', 'nothing changed');
  });

  it('is decided once: a second verdict does not change the first', async () => {
    await s.mcp('record_assumption', { text: 'x', why: 'y', storyId: 'S-1' });
    await resolve('AS-1', 'confirm');
    await resolve('AS-1', 'reject', 'too late');
    assert.equal((await progress()).assumptions[0].status, 'confirmed');
  });

  it('is cleared together with the progress', async () => {
    await s.mcp('record_assumption', { text: 'x', why: 'y' });
    await s.api('DELETE', '/api/progress');
    assert.deepEqual((await progress()).assumptions, []);
  });
});

describe('the agent is told to ask, not to leave choices for the final message', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());

  it('says in the descriptions of the tools when to ask and when an assumption is enough', async () => {
    const res = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = JSON.parse((await res.text()).match(/data: (.*)/)[1]).result.tools;
    const d = n => tools.find(t => t.name === n).description;
    assert.match(d('ask_po'), /ALWAYS when the story conflicts with the existing code/);
    assert.match(d('record_assumption'), /SMALL detail/);
    assert.match(d('record_assumption'), /is NOT an assumption: use ask_po/);
  });
});

describe('versions of the page', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());

  it('tells the version of the page file, the same one that is injected into the page', async () => {
    const b = (await s.api('GET', '/api/build')).json.build;
    assert.match(b, /^[0-9a-f]{12}$/);
    const html = await (await fetch(s.base + '/', { headers: s.bearer })).text();
    assert.ok(html.includes(`window.__AIST_BUILD__="${b}"`));
  });

  it('needs the access token like the rest of the API', async () => {
    assert.equal((await s.api('GET', '/api/build', undefined, {})).status, 401);
  });
});
