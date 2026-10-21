import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeSession } from './helpers.mjs';

const tc = (id, story, level, extra = {}) => ({ id, story, criterion: 0, level, type: 'positive', title: `Case ${id}`, given: 'g', when: 'w', then: 't', ...extra });

function sessionWithTestPlan() {
  const s = makeSession();
  s.plan.testPlan = {
    strategy: { summary: 'pyramid', framework: 'node:test', runCommand: 'npm test', reportFile: '', namingRule: 'the test name starts with the case ID', levels: [{ level: 'unit', why: 'logic' }] },
    cases: [
      tc('TC-S1-1', 'S-1', 'unit'), tc('TC-S1-2', 'S-1', 'integration', { type: 'negative' }),
      tc('TC-S1-3', 'S-1', 'manual', { manualReason: 'looks and feel' }),
      tc('TC-S2-1', 'S-2', 'unit'),
    ],
    gates: ['all automated cases pass'],
    uncovered: [],
  };
  return s;
}

describe('QA test plan reaches the agent and gates "done"', () => {
  let s;
  before(async () => { s = await startServer({ session: sessionWithTestPlan() }); });
  after(() => s.stop());
  beforeEach(() => s.api('DELETE', '/api/progress'));

  const report = (id, status, file = 'test/x.test.js') => ({ id, status, file });

  it('gives the story its cases, the framework, the command and the naming rule', async () => {
    const t = (await s.mcp('get_next_story')).text;
    assert.match(t, /## Test plan \(made by QA/);
    assert.match(t, /Framework: node:test/);
    assert.match(t, /Run all automated tests with: `npm test`/);
    assert.match(t, /Naming rule: the test name starts with the case ID/);
    assert.match(t, /- TC-S1-1 \[unit, positive\]/);
    assert.match(t, /- TC-S1-2 \[integration, negative\]/);
    assert.ok(!t.includes('TC-S2-1'), 'cases of other stories are not shown');
  });

  it('tells the agent that quality gates are binding and must be asked about, not reinterpreted', async () => {
    const t = (await s.mcp('get_story', { id: 'S-1' })).text;
    assert.match(t, /Quality gates \(binding; if one is unclear or cannot be met, call ask_po/);
    assert.match(t, /- all automated cases pass/);
  });

  it('keeps manual cases apart: they are for the Product Owner, not to be automated', async () => {
    const t = (await s.mcp('get_story', { id: 'S-1' })).text;
    assert.match(t, /Manual cases — the Product Owner checks these, do NOT automate them/);
    assert.match(t, /TC-S1-3 \[manual[^\n]*manual because: looks and feel/);
  });

  it('refuses "done" when no test case was reported, and says which ones are missing', async () => {
    const r = await s.mcp('update_story', { id: 'S-1', status: 'done' });
    assert.ok(r.isError);
    assert.match(r.text, /Not reported: TC-S1-1, TC-S1-2/);
    assert.ok(!r.text.includes('TC-S1-3'), 'manual cases do not block');
    assert.notEqual((await s.api('GET', '/api/progress')).json.stories['S-1'].status, 'done');
  });

  it('keeps partial reports and refuses "done" while one case is failing', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress', testResults: [report('TC-S1-1', 'pass')] });
    const r = await s.mcp('update_story', { id: 'S-1', status: 'done', testResults: [report('TC-S1-2', 'fail')] });
    assert.ok(r.isError);
    assert.match(r.text, /Not passing: TC-S1-2 \(fail\)/);
    const p = (await s.api('GET', '/api/progress')).json.stories['S-1'];
    assert.equal(p.status, 'in_progress', 'the status did not change');
    assert.equal(p.testResults['TC-S1-1'].status, 'pass', 'earlier reports are kept');
    assert.equal(p.testsPassed, false);
  });

  it('does not accept "skipped" for an automated case', async () => {
    const r = await s.mcp('update_story', { id: 'S-1', status: 'done', testResults: [report('TC-S1-1', 'pass'), report('TC-S1-2', 'skipped')] });
    assert.ok(r.isError);
    assert.match(r.text, /TC-S1-2 \(skipped\)/);
  });

  it('accepts "done" when every automated case passes, whatever the manual ones', async () => {
    const r = await s.mcp('update_story', { id: 'S-1', status: 'done', testResults: [report('TC-S1-1', 'pass'), report('TC-S1-2', 'pass')] });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Automated cases passing: 2 of 2/);
    const p = (await s.api('GET', '/api/progress')).json.stories['S-1'];
    assert.equal(p.status, 'done');
    assert.equal(p.testsPassed, true);
    assert.equal(p.testResults['TC-S1-2'].file, 'test/x.test.js');
  });

  it('rejects IDs that do not belong to the story', async () => {
    const r = await s.mcp('update_story', { id: 'S-1', status: 'in_progress', testResults: [report('TC-S2-1', 'pass')] });
    assert.ok(r.isError);
    assert.match(r.text, /Unknown test case IDs for S-1: TC-S2-1/);
  });

  it('a story without any case of its own falls back to the agent summary', async () => {
    const r = await s.mcp('update_story', { id: 'S-4', status: 'done', testsPassed: true });
    assert.ok(!r.isError);
    assert.match((await s.mcp('get_story', { id: 'S-4' })).text, /QA defined no automated cases/);
  });
});

describe('plans without a QA test plan keep working as before', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());

  it('has no test plan section and accepts the agent summary', async () => {
    assert.ok(!(await s.mcp('get_story', { id: 'S-1' })).text.includes('Test plan'));
    assert.ok(!(await s.mcp('update_story', { id: 'S-1', status: 'done', testsPassed: true })).isError);
    assert.ok((await s.mcp('update_story', { id: 'S-2', status: 'done', testsPassed: false })).isError);
  });
});
