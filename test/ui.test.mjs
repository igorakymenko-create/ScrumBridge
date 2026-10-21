// Tests of the chat page itself (public/index.html), run in jsdom against a live server.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openPage, makeSession, sleep } from './helpers.mjs';

const story = (id, title, acceptance) => ({ id, title, description: 'd', owner: 'fullstack', estimate: 1, acceptance, dependsOn: [], status: 'todo' });
const tc = (id, st, crit, level = 'unit') => ({ id, story: st, criterion: crit, level, type: 'positive', title: 'Case ' + id, given: 'g', when: 'w', then: 't' });

function planSession() {
  return makeSession({
    team: ['fullstack', 'qa'],
    plan: {
      sprintGoal: 'g', sprints: [{ name: 'S', goal: 'g', stories: ['S-1', 'S-2'] }],
      epics: [{ title: 'E', stories: [story('S-1', 'Storage', ['file is created']), story('S-2', 'CLI', ['add works', 'list works'])] }],
      risks: [{ text: 'Data loss on crash', mitigation: 'atomic writes' }], definitionOfDone: ['All tests pass', 'CI runs on Node 18 and 20', 'Code is nice'],
      tech: { stack: ['Node.js'], architecture: '', components: [], dataModel: '', interfaces: '', conventions: [], outOfScope: [] },
      testPlan: { strategy: { framework: 'node:test', runCommand: 'node t.mjs', reportFile: '', levels: [] }, cases: [tc('TC-S1-1', 'S-1', 0), tc('TC-S2-1', 'S-2', 0), tc('TC-S2-2', 'S-2', 1)], gates: ['good coverage'], uncovered: [] },
    },
  });
}

describe('the chat page', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession() }); page = await openPage(s); page.ev("settings.provider = 'demo'"); });
  after(async () => { page.close(); await s.stop(); });

  it('loads without errors and shows the tabs of the local app', () => {
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.$$('#tabs .tab').map(b => b.dataset.tab), ['team', 'log', 'plan', 'context', 'session']);
  });

  it('knows the project it belongs to and uses the session from the server', () => {
    assert.match(page.ev('window.__AIST_PROJECT__'), /^[0-9a-f]{12}$/);
    assert.equal(page.ev('session.title'), 'Test');
  });

  it('opens the settings with Gemini, Anthropic and OpenAI ready to take a key', () => {
    page.ev('ui.settingsOpen()');
    assert.deepEqual(page.$$('#sProvider option').map(o => o.value), ['gemini', 'anthropic', 'openai', 'demo']);
    assert.ok(!page.$('#provMgr').hidden);
    assert.equal(page.$$('[data-rmp]').length > 5, true, 'a provider choice for every role');
  });

  describe('test plan helpers', () => {
    it('cleans what the model returns: unknown stories, empty cases, odd values, IDs written into titles', () => {
      const out = JSON.parse(page.ev(`JSON.stringify(cleanCases([
        {story:'S-1', criterion:0, level:'unit', title:'TC-S1-1: Create the file', given:'g', when:'w', then:'t'},
        {story:'S-9', criterion:0, level:'unit', title:'ghost', then:'t'},
        {story:'S-1', criterion:7, level:'weird', type:'odd', title:'bad numbers', then:'t'},
        {story:'S-2', criterion:0, level:'manual', title:'looks', then:'t', manualReason:'visual'},
        {story:'S-2', criterion:1, level:'unit', title:'', then:'no title'}
      ]))`));
      assert.equal(out.length, 3);
      assert.equal(out[0].title, 'Create the file');
      assert.deepEqual([out[1].level, out[1].type, out[1].criterion], ['unit', 'positive', 0]);
      assert.deepEqual([out[0].manualReason, out[2].manualReason], ['', 'visual']);
    });

    it('numbers the cases itself, per story, with a code of the plan so that IDs of different plans never collide', () => {
      const ids = JSON.parse(page.ev(`JSON.stringify(numberCases([{story:'S-1'},{story:'S-2'},{story:'S-2'}].map(c => Object.assign({criterion:0, level:'unit'}, c)), 'K7Q').map(c => c.id))`));
      assert.deepEqual(ids, ['TC-K7Q-S1-1', 'TC-K7Q-S2-1', 'TC-K7Q-S2-2']);
      const own = JSON.parse(page.ev(`JSON.stringify(numberCases([{story:'S-1'}]).map(c => c.id))`))[0];
      assert.match(own, /^TC-[A-Z0-9]{1,3}-S1-1$/, 'the code comes from the session by default');
      assert.equal(page.ev('planTag()'), 'SS1', 'the code is the end of the session id, upper case');
    });

    it('gives two different sessions two different codes', () => {
      const a = page.ev('planTag()');
      page.ev("session.id = 'zzzabc'");
      const b = page.ev('planTag()');
      page.ev("session.id = 'sess-1'");
      assert.equal(a, 'SS1');
      assert.equal(b, 'ABC');
      assert.notEqual(a, b);
    });

    it('marks cases that look like tests of the tests, but not cases about the product', () => {
      const weak = t => page.ev(`isWeakCase(${JSON.stringify(t)})`);
      assert.equal(weak({ title: 'New test module s5 executes successfully', then: 'it runs' }), true);
      assert.equal(weak({ title: 'test suite executes via native runner', then: 'x' }), true);
      assert.equal(weak({ title: 'coverage meets 85% threshold', then: 'x' }), true);
      assert.equal(weak({ title: 'existing test suites pass without regression', then: 'x' }), true);
      assert.equal(weak({ title: 'delete command removes the task', then: 'the task is gone from the file' }), false);
      assert.equal(weak({ title: 'list sorts by priority', then: 'high comes first' }), false);
      assert.equal(weak({ title: 'add rejects an empty text', then: 'exit code 2 and a usage message' }), false);
    });

    it('shows the warning sign and a note in the plan tab', () => {
      page.ev("session.plan.testPlan.cases.push({id:'TC-X-S2-9', story:'S-2', criterion:0, level:'integration', type:'positive', title:'The test suite executes successfully', given:'g', when:'w', then:'all pass'})");
      page.ev("ui.tab = 'plan'; ui.side()");
      const text = page.$('#sidebody').innerHTML;
      assert.match(text, /TC-X-S2-9<\/b> <span title="Looks like a test of the tests/);
      assert.match(page.$('#sidebody').textContent, /1 case\(s\) look like tests of the tests/);
      page.ev("session.plan.testPlan.cases.pop()");
    });

    it('finds the acceptance criteria that no case covers', () => {
      const unc = JSON.parse(page.ev(`JSON.stringify(uncoveredCriteria([{story:'S-1', criterion:0}, {story:'S-2', criterion:0}]))`));
      assert.deepEqual(unc, [{ story: 'S-2', criterion: 1 }]);
    });

    it('shows the strategy, the cases and the PO checkboxes in the plan tab', () => {
      page.ev("ui.tab = 'plan'; ui.side()");
      const text = page.$('#sidebody').textContent;
      assert.match(text, /node:test/);
      assert.match(text, /TC-S2-2/);
    });
  });

  describe('plan check', () => {
    const model = {
      message: 'm',
      issues: [
        { kind: 'orphan', text: 'CI is required but no story creates it.', ref: { type: 'dod', index: 1 }, options: [
          { action: 'add_story', label: 'Add a CI story', recommended: true, story: { title: 'CI pipeline', description: 'd', owner: 'ghost', estimate: 4, acceptance: ['runs on Node 18', 'runs on Node 20'] } },
          { action: 'drop', label: 'Remove' }, { action: 'manual', label: 'Mine' },
          { action: 'reword', label: 'no wording' }, { action: 'add_story', label: 'no criteria', story: { title: 'x', acceptance: [] } },
        ] },
        { kind: 'unmeasurable', text: 'Good coverage is vague.', ref: { type: 'gate', index: 0 }, options: [{ action: 'reword', label: 'Measurable', rewrite: 'line coverage >= 85%', recommended: true }, { action: 'drop', label: 'Drop' }] },
        { kind: 'unmeasurable', text: 'Code is nice is vague.', ref: { type: 'dod', index: 2 }, options: [{ action: 'drop', label: 'Remove', recommended: true }] },
        { kind: 'contradiction', text: 'Bad reference.', ref: { type: 'criterion', story: 'S-2', index: 9 }, options: [{ action: 'drop', label: 'x' }, { action: 'weird', label: 'y' }] },
        { text: '' }, null,
      ],
    };
    let issues;

    it('drops unusable issues and options, keeps one recommended option and always offers a manual check', () => {
      issues = JSON.parse(page.ev(`JSON.stringify(normalizeCheck(${JSON.stringify(model)}))`));
      assert.equal(issues.length, 4);
      assert.deepEqual(issues[0].options.map(o => o.action), ['add_story', 'drop', 'manual']);
      assert.ok(issues.every(i => i.options.filter(o => o.recommended).length === 1));
      assert.ok(issues.every(i => i.options.some(o => o.action === 'manual')));
      assert.equal(issues[0].refText, 'CI runs on Node 18 and 20');
      assert.equal(issues[3].ref, null, 'a reference to a criterion that does not exist is dropped');
      assert.deepEqual(issues[3].options.map(o => o.action), ['manual']);
    });

    it('shows the issues with buttons, and warns before the agent is started', () => {
      page.ev(`session.plan.check = {ts:1, failed:false, issues:${JSON.stringify(issues)}}`);
      page.ev("ui.tab = 'plan'; ui.side()");
      assert.ok(page.$$('[data-act="pc-apply"]').length >= 7);
      assert.ok(page.$('[data-issue="PC-1"][data-opt="0"]').className.includes('primary'));
      page.ev("ui.tab = 'session'; ui.side()");
      assert.match(page.$('#sidebody').textContent, /4 plan problem/);
    });

    it('add_story: new story with the next ID in the last sprint, owner from the team, QA asked to cover it', async () => {
      page.ev("ui.tab = 'plan'; ui.side()");
      page.$('[data-issue="PC-1"][data-opt="0"]').click();
      await sleep(600);
      const plan = JSON.parse(page.ev('JSON.stringify(session.plan)'));
      const added = plan.epics.flatMap(e => e.stories).find(x => x.title === 'CI pipeline');
      assert.equal(added.id, 'S-3');
      assert.deepEqual([added.owner, added.estimate], ['fullstack', 2]);
      assert.ok(plan.sprints.at(-1).stories.includes('S-3'));
      assert.equal(page.ev("uncoveredCriteria(session.plan.testPlan.cases).some(u => u.story === 'S-3')"), true, 'the new criteria wait for QA cases');
    });

    it('reword, drop and manual change exactly what they should, and every resolution is logged', () => {
      page.ev("ui.tab = 'plan'; ui.side()");
      page.$('[data-issue="PC-2"][data-opt="0"]').click();
      page.ev("ui.tab = 'plan'; ui.side()");
      page.$('[data-issue="PC-3"][data-opt="0"]').click();
      page.ev("ui.tab = 'plan'; ui.side()");
      page.$('[data-issue="PC-4"][data-opt="0"]').click();
      const plan = JSON.parse(page.ev('JSON.stringify(session.plan)'));
      assert.equal(plan.testPlan.gates[0], 'line coverage >= 85%');
      assert.deepEqual(plan.definitionOfDone, ['All tests pass', 'CI runs on Node 18 and 20']);
      assert.equal(plan.manualItems.length, 1);
      assert.equal(page.ev('session.decisions.filter(d => d.source && d.source.key === "src.planCheck").length'), 4);
      assert.equal(page.ev('planOpenIssues()'), 0);
      assert.match(page.ev('handoffMD()'), /Manual checks for the Product Owner/);
    });

    it('finds the item by its text, so earlier resolutions cannot make a later one hit the wrong item', () => {
      const mk = (id, refText, index, action, extra = {}) => ({ id, kind: 'unmeasurable', text: id, ref: { type: 'dod', index, story: '' }, refText, options: [Object.assign({ action, label: action, recommended: true }, extra), { action: 'manual', label: 'm', recommended: false }], status: 'open', resolution: '' });
      page.ev('session.plan.definitionOfDone = ["A first", "B second", "C third"]');
      page.ev('session.plan.check = ' + JSON.stringify({ ts: 1, failed: false, issues: [mk('PC-A', 'A first', 0, 'drop'), mk('PC-C', 'C third', 2, 'reword', { rewrite: 'C reworded' }), mk('PC-X', 'B second', 1, 'reword', { rewrite: 'B reworded' })] }));
      page.ev('applyPlanCheck("PC-A", 0)');
      page.ev('applyPlanCheck("PC-C", 0)');
      assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.plan.definitionOfDone)')), ['B second', 'C reworded']);
      page.ev('session.plan.definitionOfDone.splice(0, 1)'); // the item PC-X points to disappears
      page.ev('applyPlanCheck("PC-X", 0)');
      assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.plan.definitionOfDone)')), ['C reworded'], 'nothing else was touched');
      assert.match(page.ev('session.plan.check.issues.find(x => x.id === "PC-X").resolution'), /no longer exists/);
    });
  });

  describe('prompts given to the team', () => {
    it('ask QA for measurable gates, a JUnit report inside .ai-team, and no cases that test the tests', () => {
      const p = page.ev('P.qaPlan()');
      assert.match(p, /Every gate must be measurable and unambiguous/);
      assert.match(p, /JUnit XML report, always inside \.ai-team/);
      assert.match(p, /--test-reporter=junit --test-reporter-destination=\.ai-team\/junit\.xml/);
      assert.match(p, /Never write a case that runs other tests, checks that the test runner works, or checks coverage/);
    });

    it('tell QA how IDs are formed (with the code of the plan) so that it does not invent its own', () => {
      assert.match(page.ev('P.qaPlan()'), /TC-<code>-<story>-<n>/);
      assert.match(page.ev('P.qaPlan()'), /for example TC-SS1-S1-1, TC-SS1-S1-2/);
    });

    it('carry the facts of the real code in an existing project, and nothing in a new one', async () => {
      page.ev("session.contextMode = 'new'");
      await page.ev('loadFacts()');
      assert.equal(page.ev('factsText'), '');
      assert.ok(!page.ev('P.qaPlan()').includes('FACTS FROM THE REPOSITORY'));
      page.ev("session.contextMode = 'existing'");
      await page.ev('loadFacts()');
      assert.match(page.ev('factsText'), /FACTS FROM THE REPOSITORY/);
      for (const prompt of ['P.qaPlan()', 'P.planCheck()', 'P.plan()']) {
        assert.match(page.ev(prompt), /FACTS FROM THE REPOSITORY/, prompt + ' must carry the facts');
      }
      page.ev("session.contextMode = 'new'; factsText = ''");
    });

    it('ask the Scrum Master to look for orphan DoD items, contradictions and unmeasurable criteria', () => {
      const p = page.ev('P.planCheck()');
      assert.match(p, /orphan: a Definition of Done item/);
      assert.match(p, /do not invent issues/);
      assert.match(p, /CI runs on Node 18 and 20/, 'the plan under review is in the prompt');
    });
  });
});

describe('a tab that runs an outdated page', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession() }); page = await openPage(s); });
  after(async () => { page.close(); await s.stop(); });

  it('stays quiet while the page is current', async () => {
    await page.ev('checkBuild()');
    assert.equal(page.$('#updBar'), null);
  });

  it('offers a reload, once, when the app has a newer page', async () => {
    page.ev('window.__AIST_BUILD__ = "oldbuild0000"');
    await page.ev('checkBuild()');
    assert.ok(page.$('#updBar'));
    assert.match(page.$('#updBar').textContent, /The app was updated/);
    await page.ev('checkBuild()');
    assert.equal(page.$$('#updBar').length, 1);
    assert.ok(page.$('#updReload'));
  });
});

describe('assumptions of the agent in the chat', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession() }); page = await openPage(s); });
  after(async () => { page.close(); await s.stop(); });

  it('shows up in the chat and in the plan tab as soon as the agent records it', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    await s.mcp('record_assumption', { text: 'The file is called todos.json', why: 'same as the existing code' });
    await page.ev('syncAgent()');
    assert.ok(page.ev('session.messages.some(m => m.key === "sys.agentAssumption")'));
    page.ev("ui.tab = 'plan'; ui.side()");
    assert.match(page.$('#sidebody').textContent, /Assumptions of the agent/);
    assert.ok(page.$('[data-act="as-confirm"][data-id="AS-1"]') && page.$('[data-act="as-reject"][data-id="AS-1"]'));
  });

  it('is confirmed with one click and becomes a decision of the log', async () => {
    page.$('[data-act="as-confirm"][data-id="AS-1"]').click();
    await sleep(800);
    assert.equal((await s.api('GET', '/api/progress')).json.assumptions[0].status, 'confirmed');
    assert.ok(page.ev('session.decisions.some(d => d.text.startsWith("Assumption AS-1 confirmed"))'));
    page.ev("ui.tab = 'plan'; ui.side()");
    assert.ok(!page.$('[data-act="as-confirm"]'), 'no buttons for a decided assumption');
    assert.match(page.$('#sidebody').textContent, /confirmed/);
  });

  it('is rejected with an instruction: the story goes back to the agent and the instruction is binding', async () => {
    await s.mcp('update_story', { id: 'S-1', status: 'done', testResults: [{ id: 'TC-S1-1', status: 'pass' }] }); // S-1 has an automated case in the plan
    await s.mcp('record_assumption', { text: 'list hides finished tasks', why: 'guess', storyId: 'S-1' });
    await page.ev('syncAgent()');
    page.w.prompt = () => 'Show all tasks';
    page.ev("ui.tab = 'plan'; ui.side()");
    page.$('[data-act="as-reject"][data-id="AS-2"]').click();
    await sleep(800);
    const p = (await s.api('GET', '/api/progress')).json;
    assert.equal(p.assumptions[1].status, 'rejected');
    assert.equal(p.stories['S-1'].status, 'todo');
    assert.match((await s.mcp('get_next_story')).text, /Show all tasks/);
    assert.ok(page.ev('session.decisions.some(d => d.text.includes("Assumption AS-2 rejected") && d.text.includes("Show all tasks"))'));
  });

  it('does nothing when the Product Owner gives no instruction for a rejection', async () => {
    await s.mcp('record_assumption', { text: 'another', why: 'guess', storyId: 'S-1' });
    await page.ev('syncAgent()');
    page.w.prompt = () => '';
    page.ev("ui.tab = 'plan'; ui.side()");
    page.$('[data-act="as-reject"][data-id="AS-3"]').click();
    await sleep(500);
    assert.equal((await s.api('GET', '/api/progress')).json.assumptions[2].status, 'open');
  });
});

describe('test cases under the control of the Product Owner', () => {
  let s, page;
  before(async () => {
    s = await startServer({ session: planSession(), files: { 'test/s8.test.js': "test('TC-S1-1 creates the file', () => {\n  assert.ok(true);\n});\n" } });
    page = await openPage(s);
    page.ev("settings.provider = 'demo'");
  });
  after(async () => { page.close(); await s.stop(); });
  const plan = () => page.ev("ui.tab = 'plan'; ui.side()");
  const cases = () => JSON.parse(page.ev('JSON.stringify(session.plan.testPlan.cases)'));
  const click = sel => page.$(sel).click();

  it('offers edit, make manual, replace and remove for every case, and the code only for automated ones', () => {
    page.ev('tcOpen["S-1"] = true; tcOpen["S-2"] = true');
    plan();
    for (const a of ['tc-edit', 'tc-manual', 'tc-replace', 'tc-remove', 'tc-code']) assert.ok(page.$(`[data-act="${a}"][data-id="TC-S1-1"]`), a);
    assert.ok(page.$('[data-act="tc-add"][data-story="S-1"]'), 'and a button to add an own case to the story');
    page.ev("session.plan.testPlan.cases[0].level = 'manual'"); plan();
    assert.equal(page.$('[data-act="tc-code"][data-id="TC-S1-1"]'), null, 'a manual case has no code to show');
    assert.equal(page.$('[data-act="tc-manual"][data-id="TC-S1-1"]'), null, 'and is not made manual twice');
    page.ev("session.plan.testPlan.cases[0].level = 'unit'");
  });

  it('keeps an opened list of cases open when the panel is drawn again', () => {
    page.ev('tcOpen["S-1"] = true'); plan();
    assert.ok(page.$('details[data-tcstory="S-1"]').hasAttribute('open'));
    page.ev('tcOpen["S-1"] = false'); plan();
    assert.ok(!page.$('details[data-tcstory="S-1"]').hasAttribute('open'));
    page.ev('tcOpen["S-1"] = true; tcOpen["S-2"] = true');
  });

  it('makes a case manual: it moves to the checklist of the Product Owner with a reason', () => {
    plan(); click('[data-act="tc-manual"][data-id="TC-S1-1"]');
    const c = cases().find(x => x.id === 'TC-S1-1');
    assert.deepEqual([c.level, c.manualReason], ['manual', 'set by the Product Owner']);
    plan();
    assert.ok(page.$('[data-act="manual-toggle"][data-tc="TC-S1-1"]'), 'it has a checkbox now');
    page.ev("Object.assign(session.plan.testPlan.cases[0], {level: 'unit', manualReason: ''})");
  });

  it('removes a case, tells which criterion is left bare, and never gives its number to a new case', () => {
    plan(); click('[data-act="tc-remove"][data-id="TC-S2-2"]');
    assert.ok(!cases().some(c => c.id === 'TC-S2-2'));
    assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.plan.testPlan.removed)')), ['TC-S2-2']);
    assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.plan.testPlan.uncovered)')), [{ story: 'S-2', criterion: 1 }]);
    plan();
    assert.match(page.$('#sidebody').textContent, /Criteria left without a test case: \[1\]/);
    page.ev("tcStartEdit('', 'S-2')");
    page.ev("tcDraft.title = 'Own case'; tcDraft.then = 'it works'; tcDraft.criterion = 1");
    click('[data-act="tc-save"]');
    const own = cases().find(c => c.title === 'Own case');
    assert.equal(own.id, 'TC-SS1-S2-3', 'TC-S2-2 was removed, but its number is not used again');
    assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.plan.testPlan.uncovered)')), [], 'and the criterion is covered again');
  });

  it('edits a case in a form, and refuses to save it without a title or an expected result', () => {
    plan(); click('[data-act="tc-edit"][data-id="TC-S2-1"]');
    assert.ok(page.$('input[data-tcf="title"]'), 'the form is shown');
    page.ev("tcDraft.title = ''"); click('[data-act="tc-save"]');
    assert.ok(page.errors.some(e => /title and the expected result/.test(e)), 'an alert tells why');
    assert.equal(cases().find(c => c.id === 'TC-S2-1').title, 'Case TC-S2-1', 'nothing changed');
    page.ev("tcDraft.title = 'Add stores the task'; tcDraft.level = 'integration'"); click('[data-act="tc-save"]');
    const c = cases().find(x => x.id === 'TC-S2-1');
    assert.deepEqual([c.title, c.level], ['Add stores the task', 'integration']);
    assert.equal(page.ev('tcEdit'), null, 'the form is closed');
  });

  it('asks QA for a replacement, keeping the story and the criterion, and retires the old ID', async () => {
    page.w.prompt = () => 'check the exit code instead';
    plan(); click('[data-act="tc-replace"][data-id="TC-S2-1"]');
    for (let i = 0; i < 20 && cases().some(c => c.id === 'TC-S2-1'); i++) await sleep(300);
    const n = cases().find(c => c.title === 'Demo replacement of TC-S2-1');
    assert.ok(n, 'a new case appeared');
    assert.deepEqual([n.story, n.criterion], ['S-2', 0]);
    assert.notEqual(n.id, 'TC-S2-1');
    assert.ok(JSON.parse(page.ev('JSON.stringify(session.plan.testPlan.removed)')).includes('TC-S2-1'));
  });

  it('does nothing when the Product Owner cancels the question about a replacement', async () => {
    const before = cases().map(c => c.id).join();
    page.w.prompt = () => null;
    plan(); click('[data-act="tc-replace"][data-id="TC-S1-1"]');
    await sleep(500);
    assert.equal(cases().map(c => c.id).join(), before);
  });

  it('shows how a case was proven: the report of the agent and the tests the app saw pass', () => {
    page.ev(`progress.stories['S-1'] = {status: 'done', testResults: {'TC-S1-1': {status: 'pass', file: 'test/s8.test.js'}}, verification: {cases: {'TC-S1-1': 'pass'}, tests: {'TC-S1-1': [{name: 'TC-S1-1 creates the file', file: 's8.test.js', ms: 12, outcome: 'pass'}]}, outputTail: 'ok 1 - TC-S1-1 creates the file'}}`);
    plan();
    const text = page.$('#sidebody').textContent;
    assert.match(text, /agent reported: passed @ test\/s8\.test\.js/);
    assert.match(text, /app run: pass · “TC-S1-1 creates the file” \(s8\.test\.js, 12 ms\)/);
    assert.match(text, /Output of the last run/);
    assert.match(page.$('#sidebody').innerHTML, /ok 1 - TC-S1-1 creates the file/);
  });

  it('shows the code of the automated test, found in the project by the ID, and hides it again', async () => {
    plan(); click('[data-act="tc-code"][data-id="TC-S1-1"]');
    for (let i = 0; i < 20 && !page.ev('codeOpen["TC-S1-1"]'); i++) await sleep(200);
    assert.match(page.$('#sidebody').innerHTML, /test\/s8\.test\.js:1/);
    assert.match(page.$('#sidebody').innerHTML, /assert\.ok\(true\);/);
    click('[data-act="tc-code"][data-id="TC-S1-1"]');
    assert.doesNotMatch(page.$('#sidebody').innerHTML, /assert\.ok\(true\);/);
  });

  it('says so when no test with the ID exists yet', async () => {
    plan(); click('[data-act="tc-code"][data-id="TC-S1-1"]'); // closed -> opened for a case with a code
    await sleep(500);
    page.ev("codeCache['TC-S1-1'] = []; codeOpen['TC-S1-1'] = true"); plan();
    assert.match(page.$('#sidebody').textContent, /No test with this ID was found in the project files yet/);
  });

  it('warns before the agent is started when weak cases are left', () => {
    page.ev("session.plan.testPlan.cases.push({id:'TC-X', story:'S-1', criterion:0, level:'unit', type:'positive', title:'The whole test suite passes', given:'g', when:'w', then:'all tests pass'})");
    page.ev("ui.tab = 'session'; ui.side()");
    assert.match(page.$('#sidebody').textContent, /1 test case\(s\) look weak/);
    page.ev("session.plan.testPlan.cases.pop()");
  });
});

describe('the waiting time of the agent in the settings', () => {
  let s, page;
  before(async () => {
    s = await startServer({ session: planSession(), env: { AIST_WAIT_MS: '' } });
    page = await openPage(s);
    page.ev("settings.provider = 'demo'");
  });
  after(async () => { page.close(); await s.stop(); });

  it('shows the current value with a hint, and saves a new one when the settings are saved', async () => {
    page.ev('ui.settingsOpen()');
    for (let i = 0; i < 20 && page.$('#sWait').value !== '600'; i++) await sleep(100);
    assert.equal(page.$('#sWait').value, '600');
    assert.ok(!page.$('#sWait').hidden && !page.$('#sWait').disabled);
    assert.match(page.$('#sWaitHint').textContent, /How long the IDE agent waits inside a question to me \(default 600 s\)/);
    page.$('#sWait').value = '90';
    page.$('#sSave').click();
    for (let i = 0; i < 30 && (await s.api('GET', '/api/settings')).json.waitSeconds !== 90; i++) await sleep(100);
    assert.equal((await s.api('GET', '/api/settings')).json.waitSeconds, 90);
  });

  it('does not touch the server when the value is unchanged, and refuses a nonsense value with a message', async () => {
    page.ev('ui.settingsOpen()');
    for (let i = 0; i < 20 && page.$('#sWait').value !== '90'; i++) await sleep(100);
    page.$('#sWait').value = '2';
    page.$('#sSave').click();
    await sleep(500);
    assert.ok(page.errors.some(e => /Waiting time: waitSeconds must be between 5 and 3600/.test(e)));
    assert.equal((await s.api('GET', '/api/settings')).json.waitSeconds, 90);
  });
});

describe('the waiting time fixed by the environment', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession(), env: { AIST_WAIT_MS: '2000' } }); page = await openPage(s); });
  after(async () => { page.close(); await s.stop(); });

  it('is shown but cannot be changed in the settings', async () => {
    page.ev('ui.settingsOpen()');
    for (let i = 0; i < 20 && !page.$('#sWait').disabled; i++) await sleep(100);
    assert.ok(page.$('#sWait').disabled);
    assert.match(page.$('#sWaitHint').textContent, /AIST_WAIT_MS/);
  });
});

describe('the two commands for the IDE agent cannot be mistaken for each other', () => {
  let s, page;
  const copied = [];
  before(async () => {
    s = await startServer({ session: planSession() });
    page = await openPage(s);
    Object.defineProperty(page.w.navigator, 'clipboard', { configurable: true, value: { writeText: txt => { copied.push(txt); return Promise.resolve(); } } });
  });
  after(async () => { page.close(); await s.stop(); });

  it('the START command is copied from the Session tab and begins with IMPLEMENT THE PLAN', async () => {
    page.ev("ui.tab = 'session'; ui.side()");
    const b = page.$('[data-act="copy-prompt"]');
    assert.match(b.textContent, /START command/);
    b.click(); await sleep(150);
    assert.match(copied.at(-1), /^IMPLEMENT THE PLAN\./);
    assert.match(copied.at(-1), /implement-next-story/);
    assert.doesNotMatch(copied.at(-1), /analyz/i);
    assert.match(page.$('#sidebody').textContent, /Start command copied.? «IMPLEMENT THE PLAN./, 'the screen shows what was copied');
  });

  it('the ANALYSIS command is copied from the Context tab and begins with ANALYSIS ONLY, IMPLEMENT NOTHING', async () => {
    page.ev("session.contextMode = 'existing'; ui.tab = 'context'; ui.side()");
    const b = page.$('[data-act="ctx-copy"]');
    assert.match(b.textContent, /ANALYSIS command/);
    assert.match(b.textContent, /implements nothing/);
    b.click(); await sleep(150);
    assert.match(copied.at(-1), /^ANALYSIS ONLY, IMPLEMENT NOTHING\./);
    assert.match(copied.at(-1), /analyze-project/);
    assert.doesNotMatch(copied.at(-1), /implement-next-story/);
    assert.match(page.$('#sidebody').textContent, /Command copied.? «ANALYSIS ONLY, IMPLEMENT NOTHING./, 'the screen shows what was copied');
  });
});

describe('a decision typed by the Product Owner in the chat', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession() }); page = await openPage(s); });
  after(async () => { page.close(); await s.stop(); });

  it('forbids the Scrum Master to claim that the plan was changed from the chat', () => {
    const p = page.ev('P.chat("new tests go to s9")');
    assert.match(p, /from this chat you cannot change the plan, the stories or the test plan/);
    assert.match(p, /never say or imply that you did/);
    assert.match(p, /if the plan text says something else, the decision wins/);
  });

  it('is written to the decision log and the chat says plainly that the text of the plan is not rewritten', async () => {
    page.ev(`LLM.call = async () => ({text: JSON.stringify({reply: 'Noted.', levelChange: null, decision: 'Place new tests in test/s9.test.js'}), usage: {in: 0, out: 0}})`);
    page.ev('session.messages = []; session.decisions = []');
    page.ev('onSend("Decision: new tests go to test/s9.test.js")');
    for (let i = 0; i < 20 && !page.ev('session.decisions.length'); i++) await sleep(150);
    assert.deepEqual(JSON.parse(page.ev('JSON.stringify(session.decisions.map(d => d.text))')), ['Place new tests in test/s9.test.js']);
    const msg = page.ev('t("sys.poDecisionRecorded", {id: session.decisions[0].id})');
    assert.match(msg, /Recorded as decision D-1\./);
    assert.match(msg, /text of the plan is NOT rewritten/);
    assert.ok(page.ev('session.messages.some(m => m.key === "sys.poDecisionRecorded")'));
  });

  it('says nothing about a decision when the message was only a question', async () => {
    page.ev(`LLM.call = async () => ({text: JSON.stringify({reply: 'Because of X.', levelChange: null, decision: null}), usage: {in: 0, out: 0}})`);
    page.ev('session.messages = []; session.decisions = []');
    page.ev('onSend("Why s9?")');
    await sleep(800);
    assert.equal(page.ev('session.decisions.length'), 0);
    assert.ok(!page.ev('session.messages.some(m => m.key === "sys.poDecisionRecorded")'));
  });
});

describe('when the model of a role does not answer', () => {
  let s, page;
  before(async () => {
    s = await startServer({ session: planSession() });
    page = await openPage(s);
    page.ev("window.__origCall = LLM.call; settings.provider = 'gemini'; settings.model = 'default-model'; settings.roleModels = {qa: {provider: 'gemini', model: 'broken-model'}}");
  });
  after(async () => { page.close(); await s.stop(); });
  const settle = p => Promise.resolve(p).then(v => ({ ok: true, v }), e => ({ ok: false, e }));
  const stub = body => page.ev(`LLM.call = async o => { ${body} }`);

  it('continues with the default model and tells the Product Owner', async () => {
    stub(`if (o.model === 'broken-model') throw new Error('This model is currently experiencing high demand.'); return {text: JSON.stringify({ok: 1, model: o.model}), usage: {in: 0, out: 0}};`);
    page.ev('session.messages = []');
    const r = await page.ev("callJSON({task: 'x', role: 'qa', system: '', prompt: ''})");
    assert.deepEqual([r.ok, r.model], [1, 'default-model']);
    const m = JSON.parse(page.ev('JSON.stringify(session.messages.find(m => m.key === "sys.modelFallback"))'));
    assert.deepEqual([m.params.from, m.params.to], ['broken-model', 'default-model']);
    assert.match(m.params.why, /high demand/);
  });

  it('does not hide a failure of the default model itself', async () => {
    stub(`throw new Error('everything is down');`);
    page.ev('session.messages = []');
    const r = await settle(page.ev("callJSON({task: 'x', role: 'sm', system: '', prompt: ''})"));
    assert.equal(r.ok, false);
    assert.match(r.e.message, /everything is down/);
    assert.ok(!page.ev('session.messages.some(m => m.key === "sys.modelFallback")'));
  });

  it('does not start a second request after the Product Owner pressed Stop', async () => {
    stub(`throw new Error(t('err.stopped'));`);
    page.ev('session.messages = []');
    const r = await settle(page.ev("callJSON({task: 'x', role: 'qa', system: '', prompt: ''})"));
    assert.equal(r.ok, false);
    assert.ok(!page.ev('session.messages.some(m => m.key === "sys.modelFallback")'));
  });

  it('says plainly that the test plan is missing when the QA step fails, and offers a button', async () => {
    page.ev("delete session.plan.testPlan; delete session.plan.check; session.phase = 'planning'; session.messages = []");
    stub(`throw new Error('down');`);
    const r = await settle(page.ev('doPlanning()'));
    assert.equal(r.ok, false, 'the step still reports the error, so that Retry works');
    assert.ok(page.ev('session.messages.some(m => m.key === "sys.qaFailed")'));
    page.ev("ui.tab = 'plan'; ui.side()");
    assert.match(page.$('#sidebody').textContent, /The QA test plan is missing/);
    assert.ok(page.$('[data-act="qa-create"]'));
  });

  it('creates the test plan and the plan check from that button once a model works', async () => {
    page.ev("LLM.call = window.__origCall; settings.provider = 'demo'; settings.roleModels = {}");
    page.$('[data-act="qa-create"]').click();
    for (let i = 0; i < 30 && !page.ev('session.plan.testPlan && session.plan.check && session.phase === "done"'); i++) await sleep(300);
    assert.ok(page.ev('!!session.plan.testPlan'), 'the test plan exists');
    assert.ok(page.ev('!!session.plan.check'), 'the plan check ran as well');
    assert.equal(page.ev('session.phase'), 'done');
    page.ev("ui.tab = 'plan'; ui.side()");
    assert.ok(!page.$('[data-act="qa-create"]'), 'the notice is gone');
  });
});

describe('what the chat tells the Product Owner about the agent', () => {
  let s, page;
  before(async () => { s = await startServer({ session: planSession() }); page = await openPage(s); });
  after(async () => { page.close(); await s.stop(); });

  const iso = ago => new Date(Date.now() - ago).toISOString();
  const scenario = ({ answeredAgo, readAgo, storyUpdatedAgo }) => {
    page.ev('session.messages = []');
    page.ev(`session.questions = [{id:'Q-1', agentQid:'AQ-1', answer:{ts:Date.now()-${answeredAgo}}, reported:true}]`);
    const p = {
      stories: { 'S-1': { status: 'in_progress', updatedAt: iso(storyUpdatedAgo) } },
      questions: [{ id: 'AQ-1', askedAt: iso(answeredAgo + 5000), answer: { ts: iso(answeredAgo), readAt: readAgo == null ? undefined : iso(readAgo) } }],
    };
    page.ev(`agentAnswersCheck(${JSON.stringify(p)})`);
    return page.ev('session.messages.map(m => m.key).join(",")') || '(none)';
  };
  const H = 3600 * 1000;

  it('says nothing about an old answer that nobody read, or one given while the agent kept working', () => {
    assert.equal(scenario({ answeredAgo: 2 * H, storyUpdatedAgo: 3 * H }), '(none)');
    assert.equal(scenario({ answeredAgo: 40000, storyUpdatedAgo: 5000 }), '(none)');
    assert.equal(scenario({ answeredAgo: 10000, storyUpdatedAgo: 600000 }), '(none)');
  });

  it('reminds the PO when a fresh answer is not picked up and the agent has been silent since', () => {
    assert.equal(scenario({ answeredAgo: 40000, storyUpdatedAgo: 600000 }), 'sys.agentNudge');
  });

  it('announces that the agent got an answer only when that just happened', () => {
    assert.equal(scenario({ answeredAgo: 700000, readAgo: 600000, storyUpdatedAgo: 600000 }), '(none)');
    assert.equal(scenario({ answeredAgo: 30000, readAgo: 5000, storyUpdatedAgo: 600000 }), 'sys.agentRead');
  });
});
