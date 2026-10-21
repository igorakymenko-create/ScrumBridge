import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeSession, sleep } from './helpers.mjs';

describe('MCP tools: reading the plan', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));

  it('lists the tools and prompts the agent needs', async () => {
    const res = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = [...(await res.text()).matchAll(/"name":"([a-z_]+)"/g)].map(m => m[1]);
    for (const n of ['get_next_story', 'get_story', 'get_decisions', 'get_spec', 'get_status', 'update_story', 'ask_po', 'get_answer', 'report_blocker', 'submit_project_context', 'get_project_context']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });

  it('starts with the first story and gives it everything needed to implement it', async () => {
    const r = await s.mcp('get_next_story');
    assert.match(r.text, /^# S-1\. Storage/);
    assert.match(r.text, /## Acceptance criteria/);
    assert.match(r.text, /## Technical brief/);
    assert.match(r.text, /D-1: Use plain files/);
    assert.match(r.text, /## Definition of Done/);
  });

  it('does not offer a story whose dependencies are not done, but offers an independent one', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    assert.match((await s.mcp('get_next_story')).text, /^# S-1\./, 'a story already in progress comes first');
    await s.mcp('update_story', { id: 'S-1', status: 'blocked' });
    // S-2 and S-3 wait for S-1; S-4 has no dependencies
    assert.match((await s.mcp('get_next_story')).text, /^# S-4\./);
  });

  it('follows the dependencies once they are done', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: true });
    assert.match((await s.mcp('get_next_story')).text, /^# S-2\./);
  });

  it('reports completion when every story is done', async () => {
    for (const id of ['S-1', 'S-2', 'S-3', 'S-4']) await s.mcp('update_story', { id, status: 'done', testsPassed: true });
    assert.match((await s.mcp('get_next_story')).text, /All stories are done/);
  });

  it('explains why nothing can start when the rest is blocked', async () => {
    await s.mcp('update_story', { id: 'S-4', status: 'done', testsPassed: true });
    await s.mcp('update_story', { id: 'S-1', status: 'blocked' });
    const r = await s.mcp('get_next_story');
    assert.match(r.text, /No story can be started/);
    assert.match(r.text, /S-1 \(blocked\)/);
  });

  it('returns a story, its absence, the decisions and the status overview', async () => {
    assert.match((await s.mcp('get_story', { id: 'S-3' })).text, /Depends on: S-2/);
    const missing = await s.mcp('get_story', { id: 'S-99' });
    assert.ok(missing.isError);
    assert.match((await s.mcp('get_decisions')).text, /D-1: Use plain files — simple/);
    assert.match((await s.mcp('get_status')).text, /- S-1 Storage: todo/);
  });

  it('says so when the hand-off document does not exist yet', async () => {
    const r = await s.mcp('get_spec');
    assert.ok(r.isError);
  });
});

describe('MCP tools: reporting progress', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));

  it('records status, notes and the test result', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: true, notes: 'storage.js + tests' });
    const p = (await s.api('GET', '/api/progress')).json.stories['S-1'];
    assert.equal(p.status, 'done');
    assert.equal(p.testsPassed, true);
    assert.equal(p.notes[0].text, 'storage.js + tests');
  });

  it('refuses to finish a story whose tests fail', async () => {
    const r = await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: false });
    assert.ok(r.isError);
    assert.notEqual((await s.api('GET', '/api/progress')).json.stories['S-1']?.status, 'done');
  });

  it('refuses an unknown story and an unknown status', async () => {
    assert.ok((await s.mcp('update_story', { id: 'S-77', status: 'done' })).isError);
    const bad = await s.mcp('update_story', { id: 'S-1', status: 'finished' });
    assert.ok(bad.isError || /error|invalid/i.test(bad.text));
  });
});

describe('MCP tools: questions to the Product Owner', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));
  const answer = (id, text, optionId = 'B') => s.api('POST', '/api/progress/answer', { id, optionId, text, decisionId: 'D-9' });

  it('waits for the answer inside the call and restores the story afterwards', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const asked = s.mcp('ask_po', { question: 'Which file name?', topic: 'Data file name', options: [{ label: 'todos.json', recommended: true }, { label: 'data.json' }] });
    await sleep(300);
    const mid = (await s.api('GET', '/api/progress')).json;
    assert.equal(mid.stories['S-1'].status, 'blocked', 'the story waits while the question is open');
    assert.equal(mid.questions[0].topic, 'Data file name');
    assert.equal(mid.blockers[0].prevStatus, 'in_progress');
    await answer('AQ-1', 'data.json');
    const r = await asked;
    assert.match(r.text, /AQ-1 is answered by the Product Owner: data\.json/);
    assert.match(r.text, /decision D-9/);
    const after = (await s.api('GET', '/api/progress')).json;
    assert.equal(after.stories['S-1'].status, 'in_progress', 'the story goes back to what it was');
    assert.ok(after.questions[0].answer.readAt, 'the chat can see that the agent read the answer');
  });

  it('tells the agent to stop and not to decide when no answer arrives in time', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const started = Date.now();
    const r = await s.mcp('ask_po', { question: 'Which exit code?' });
    assert.ok(Date.now() - started >= 1400, 'it waited for the configured time');
    assert.match(r.text, /NOT answered yet/);
    assert.match(r.text, /do not decide for the Product Owner/i);
    assert.match(r.text, /Stop here and tell the human/);
    assert.equal((await s.api('GET', '/api/progress')).json.stories['S-1'].status, 'blocked');
  });

  it('delivers a late answer through get_answer and unblocks the story', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    await s.mcp('ask_po', { question: 'Late question?' });
    assert.match((await s.mcp('get_answer', { id: 'AQ-1' })).text, /NOT answered yet/);
    await answer('AQ-1', 'Yes', 'A');
    assert.match((await s.mcp('get_answer', { id: 'AQ-1' })).text, /answered by the Product Owner: Yes/);
    assert.equal((await s.api('GET', '/api/progress')).json.stories['S-1'].status, 'in_progress');
  });

  it('get_answer can wait for an answer that arrives meanwhile', async () => {
    await s.mcp('ask_po', { question: 'Non blocking?', blocking: false });
    const waiting = s.mcp('get_answer', { id: 'AQ-1', wait: true });
    await sleep(400);
    await answer('AQ-1', 'Fine', 'A');
    assert.match((await waiting).text, /answered by the Product Owner: Fine/);
  });

  it('a non-blocking question returns at once and leaves the story alone', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    const started = Date.now();
    const r = await s.mcp('ask_po', { question: 'Optional?', blocking: false });
    assert.ok(Date.now() - started < 1000);
    assert.match(r.text, /NOT answered yet/);
    assert.equal((await s.api('GET', '/api/progress')).json.stories['S-1'].status, 'in_progress');
  });

  it('report_blocker blocks the story, asks the PO and releases it after the answer', async () => {
    const asked = s.mcp('report_blocker', { storyId: 'S-2', reason: 'D-1 conflicts with the plan', options: [{ label: 'Change D-1' }, { label: 'Keep D-1', recommended: true }] });
    await sleep(300);
    const p = (await s.api('GET', '/api/progress')).json;
    assert.equal(p.stories['S-2'].status, 'blocked');
    assert.equal(p.blockers[0].status, 'open');
    assert.equal(p.questions[0].options.find(o => o.recommended).label, 'Keep D-1');
    await answer('AQ-1', 'Keep D-1');
    await asked;
    const done = (await s.api('GET', '/api/progress')).json;
    assert.equal(done.blockers[0].status, 'resolved');
    assert.equal(done.stories['S-2'].status, 'todo');
  });

  it('answering an unknown question is reported, not invented', async () => {
    const r = await s.api('POST', '/api/progress/answer', { id: 'AQ-404', text: 'x' });
    assert.equal(r.json.ok, false);
    assert.equal((await s.api('POST', '/api/progress/answer', { id: 'AQ-1' })).status, 400);
  });
});
