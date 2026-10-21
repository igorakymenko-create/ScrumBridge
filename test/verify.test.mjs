import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeSession } from './helpers.mjs';

const tc = (id, story, level, extra = {}) => ({ id, story, criterion: 0, level, type: 'positive', title: `Case ${id}`, given: 'g', when: 'w', then: 't', ...extra });
function session() {
  const s = makeSession();
  s.plan.testPlan = {
    strategy: { framework: 'node:test', runCommand: 'node gen-pass.mjs', reportFile: '.ai-team/junit.xml', namingRule: 'name starts with the ID', levels: [] },
    cases: [tc('TC-S1-1', 'S-1', 'unit'), tc('TC-S1-2', 'S-1', 'integration'), tc('TC-S1-3', 'S-1', 'manual')],
    gates: [], uncovered: [],
  };
  return s;
}

// a tiny "test runner": writes a JUnit report like a real one would
const reporter = (cases) => `import fs from 'node:fs';
fs.mkdirSync('.ai-team', { recursive: true });
fs.writeFileSync('.ai-team/junit.xml', \`<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>\`);
`;
const ok = (name) => `<testcase name="${name}" time="0.01"/>`;
const failing = (name) => `<testcase name="${name}"><failure message="boom">stack</failure></testcase>`;

const files = {
  'gen-pass.mjs': reporter(ok('TC-S1-1: creates the file &amp; more') + ok('TC-S1-2: refuses a corrupted file')),
  'gen-missing.mjs': reporter(ok('TC-S1-1: creates the file')),
  'gen-fail.mjs': reporter(ok('TC-S1-1: creates the file') + failing('TC-S1-2: refuses a corrupted file')),
  'gen-other.mjs': reporter(ok('TC-S1-1: a') + ok('TC-S1-2: b') + failing('some other unrelated test')),
  'gen-skipped.mjs': reporter(ok('TC-S1-1: a') + '<testcase name="TC-S1-2: b"><skipped/></testcase>'),
  // the same case ID in tests of two files: an older plan used the same numbers
  'gen-dup.mjs': reporter('<testcase name="TC-S1-1: new test" file="test/s8.test.js"/><testcase name="TC-S1-1: old test of an earlier plan" file="test/s1.test.js"/>' + ok('TC-S1-2: b')),
  // TC-S1-10 must not be taken for TC-S1-1
  'gen-prefix.mjs': reporter(ok('TC-S1-10: another case') + ok('TC-S1-2: b')),
  'gen-evil.mjs': "import fs from 'node:fs'; fs.writeFileSync('evil-ran.txt', 'x');",
  'exit1.mjs': 'console.log("1 test failed"); process.exit(1);',
  'sleep.mjs': 'setTimeout(() => {}, 30000);',
  '.ai-team/junit.xml': '<testsuites><testsuite><testcase name="TC-S1-1: old"/><testcase name="TC-S1-2: old"/></testsuite></testsuites>', // stale
};

const reportBoth = [{ id: 'TC-S1-1', status: 'pass' }, { id: 'TC-S1-2', status: 'pass' }];

describe('tests run by the app itself before a story is done', () => {
  let s;
  before(async () => { s = await startServer({ session: session(), files, env: { AIST_VERIFY_MS: '2500' } }); });
  after(() => s.stop());
  beforeEach(async () => { await s.api('DELETE', '/api/progress'); await s.api('DELETE', '/api/verify'); fs.writeFileSync(path.join(s.project, '.ai-team', 'junit.xml'), files['.ai-team/junit.xml']); });
  const approve = (command, reportFile = '.ai-team/junit.xml') => s.api('PUT', '/api/verify', { command, reportFile });
  const done = () => s.mcp('update_story', { id: 'S-1', status: 'done', testResults: reportBoth });
  const progress = async () => (await s.api('GET', '/api/progress')).json.stories['S-1'];

  describe('approval', () => {
    it('proposes the command of the QA strategy and stores nothing until approved', async () => {
      const r = (await s.api('GET', '/api/verify')).json;
      assert.deepEqual(r.proposed, { command: 'node gen-pass.mjs', reportFile: '.ai-team/junit.xml' });
      assert.equal(r.approved, null);
    });

    it('is kept outside the project, where the agent cannot edit it, and can be revoked', async () => {
      assert.equal((await approve('node gen-pass.mjs')).status, 200);
      assert.equal((await s.api('GET', '/api/verify')).json.approved.command, 'node gen-pass.mjs');
      const stored = JSON.parse(fs.readFileSync(path.join(s.config, 'approvals.json'), 'utf8'));
      assert.equal(Object.values(stored)[0].command, 'node gen-pass.mjs');
      assert.ok(!fs.existsSync(path.join(s.project, 'approvals.json')) && !fs.existsSync(path.join(s.project, '.ai-team', 'approvals.json')));
      await s.api('DELETE', '/api/verify');
      assert.equal((await s.api('GET', '/api/verify')).json.approved, null);
    });

    it('refuses odd commands and report paths outside the project', async () => {
      assert.equal((await approve('')).status, 400);
      assert.equal((await approve('npm test\nrm -rf /')).status, 400, 'a command is one line');
      assert.equal((await approve('x'.repeat(501))).status, 400);
      assert.equal((await approve('npm test', '../outside.xml')).status, 400);
      assert.equal((await approve('npm test', path.resolve('/tmp/abs.xml'))).status, 400);
      assert.equal((await approve('npm test', '')).status, 200, 'no report is allowed: the exit code decides');
    });

    it('needs the owner: a request from a browser tab of another project is refused', async () => {
      const r = await s.api('PUT', '/api/verify', { command: 'node gen-evil.mjs', reportFile: '' }, { ...s.cookie, 'X-Aist-Project': 'ffffffffffff' });
      assert.equal(r.status, 409);
      assert.equal((await s.api('GET', '/api/verify')).json.approved, null);
    });
  });

  describe('without an approval', () => {
    it('the report of the agent is accepted and nothing is run', async () => {
      const r = await done();
      assert.ok(!r.isError, r.text);
      assert.ok(!/Verified by the app/.test(r.text));
      assert.equal((await progress()).verification, undefined);
    });
  });

  describe('with an approved command', () => {
    it('confirms the story when every case of it passes in the report (XML entities included)', async () => {
      await approve('node gen-pass.mjs');
      const r = await done();
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /Verified by the app: `node gen-pass\.mjs` — all cases of the story pass in the report/);
      const p = await progress();
      assert.equal(p.status, 'done');
      assert.deepEqual(p.verification.cases, { 'TC-S1-1': 'pass', 'TC-S1-2': 'pass' });
      assert.equal(p.verification.by, 'server');
      assert.equal(p.verification.exitCode, 0);
      assert.equal(p.verification.reportUsed, true);
    });

    it('records WHICH tests proved each case, with their duration, so that the proof can be looked at', async () => {
      await approve('node gen-pass.mjs');
      await done();
      const t = (await progress()).verification.tests;
      assert.equal(t['TC-S1-1'].length, 1);
      assert.match(t['TC-S1-1'][0].name, /^TC-S1-1: creates the file & more$/);
      assert.deepEqual([t['TC-S1-1'][0].outcome, t['TC-S1-1'][0].ms], ['pass', 10]);
      assert.ok((await progress()).verification.outputTail !== undefined, 'the end of the output is kept');
    });

    it('refuses the story when the report has no test for a case, even if the agent said it passed', async () => {
      await approve('node gen-missing.mjs');
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /No passing test in the report for: TC-S1-2/);
      const p = await progress();
      assert.notEqual(p.status, 'done');
      assert.equal(p.verification.cases['TC-S1-2'], 'missing', 'the evidence is kept');
    });

    it('refuses the story when a test of it fails, and shows the end of the output', async () => {
      await approve('node gen-fail.mjs');
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /Failing: TC-S1-2/);
      assert.match(r.text, /End of the output/);
    });

    it('refuses the story while another test of the project fails', async () => {
      await approve('node gen-other.mjs');
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /Other failing tests: some other unrelated test/);
    });

    it('does not count a skipped test as passing', async () => {
      await approve('node gen-skipped.mjs');
      assert.ok((await done()).isError);
    });

    it('refuses a case whose ID is used by tests in several files, so an older plan cannot vouch for a new case', async () => {
      await approve('node gen-dup.mjs');
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /The case ID TC-S1-1 is used by tests in several files \(s8\.test\.js, s1\.test\.js\)/);
      assert.equal((await progress()).verification.cases['TC-S1-1'], 'ambiguous');
    });

    it('does not take TC-S1-10 for TC-S1-1', async () => {
      await approve('node gen-prefix.mjs');
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /No passing test in the report for: TC-S1-1 /);
    });

    it('never trusts a stale report from an earlier run', async () => {
      await approve('node -e "0"'); // runs fine but writes nothing; the old report still passes both cases
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /did not write the report/);
    });

    it('without a report file the exit code decides', async () => {
      await approve('node exit1.mjs', '');
      const bad = await done();
      assert.ok(bad.isError);
      assert.match(bad.text, /exited with code 1/);
      assert.match(bad.text, /1 test failed/, 'the output of the command is shown');
      await approve('node -e "process.exit(0)"', '');
      const good = await done();
      assert.ok(!good.isError, good.text);
      assert.match(good.text, /exit code 0/);
    });

    it('stops a command that runs too long', async () => {
      await approve('node sleep.mjs', '');
      const started = Date.now();
      const r = await done();
      assert.ok(r.isError);
      assert.match(r.text, /did not finish within \d+ s/);
      assert.ok(Date.now() - started < 8000, 'the call returned in reasonable time');
    });

    it('runs only what the Product Owner approved, whatever the project files or the plan say', async () => {
      await approve('node gen-pass.mjs');
      const evil = session();
      evil.plan.testPlan.strategy.runCommand = 'node gen-evil.mjs'; // a rogue edit of the plan
      await s.api('PUT', '/api/session', evil);
      const r = await done();
      assert.ok(!r.isError, r.text);
      assert.ok(!fs.existsSync(path.join(s.project, 'evil-ran.txt')), 'the unapproved command was not executed');
      await s.api('PUT', '/api/session', session());
    });

    it('does not check stories that have no automated cases', async () => {
      await approve('node exit1.mjs', '');
      const r = await s.mcp('update_story', { id: 'S-4', status: 'done', testsPassed: true });
      assert.ok(!r.isError, r.text);
    });
  });
});
