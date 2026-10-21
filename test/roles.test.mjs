// Instructions of the team specialists: they reach the agent word for word, in proportion to the story.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, openPage, makeSession } from './helpers.mjs';

const story = (id, title, owner) => ({ id, title, description: 'd', owner, estimate: 1, acceptance: ['a'], dependsOn: [], status: 'todo' });
const brief = (role, texts, check = false) => ({ items: texts.map((text, i) => ({ id: `RB-${role}-${i + 1}`, text, check })), removed: [] });

function roleSession() {
  return makeSession({
    team: ['fullstack', 'ux', 'security', 'devops', 'techwriter', 'qa'],
    roleBriefs: {
      ux: brief('ux', ['Empty state shows the text "No tasks yet"'], true),
      security: brief('security', ['Never log the access token']),
      architect: brief('architect', ['Storage is a single module']),
      devops: brief('devops', ['Add Dockerfile with a node:20 base image']),
      techwriter: brief('techwriter', ['README has a quick start example'], true),
    },
    plan: {
      sprintGoal: 'g', sprints: [{ name: 'S', goal: 'g', stories: ['S-1', 'S-2', 'S-3', 'S-4'] }],
      epics: [{ title: 'E', stories: [story('S-1', 'Code', 'fullstack'), story('S-2', 'Docker', 'devops'), story('S-3', 'Docs', 'techwriter'), story('S-4', 'Loose', '')] }],
      risks: [], definitionOfDone: [], tech: { stack: [], architecture: '', components: [], dataModel: '', interfaces: '', conventions: [], outOfScope: [] },
    },
  });
}

describe('instructions of the specialists reach the agent', () => {
  let s;
  before(async () => { s = await startServer({ session: roleSession() }); });
  after(() => s.stop());
  const text = async id => (await s.mcp('get_story', { id })).text;

  it('gives an implementing story its advisory lists and not the lists of devops or techwriter', async () => {
    const t = await text('S-1');
    assert.match(t, /## Instructions of the team specialists \(binding\)/);
    assert.match(t, /From ux[^\n]*\n- Empty state shows the text "No tasks yet"/, 'word for word');
    assert.match(t, /- Never log the access token/);
    assert.match(t, /- Storage is a single module/);
    assert.ok(!t.includes('Dockerfile'), 'devops items are not given to a code story');
    assert.ok(!t.includes('quick start example'), 'techwriter items are not given to a code story');
  });

  it('gives devops and techwriter stories their own list only, marked as theirs to deliver', async () => {
    const d = await text('S-2');
    assert.match(d, /From devops \(your own area — deliver every item\):\n- Add Dockerfile/);
    assert.ok(!d.includes('Never log the access token') && !d.includes('Empty state'), 'no advisory lists for a devops story');
    const w = await text('S-3');
    assert.match(w, /README has a quick start example/);
    assert.ok(!w.includes('Dockerfile'));
  });

  it('treats a story without an owner as an implementing one', async () => {
    assert.match(await text('S-4'), /Never log the access token/);
  });

  it('shows nothing when the team gave no instructions', async () => {
    const s2 = await startServer({ session: makeSession() });
    try { assert.ok(!(await s2.mcp('get_next_story')).text.includes('Instructions of the team specialists')); } finally { await s2.stop(); }
  });
});

describe('instructions of the specialists in the chat page', () => {
  let s, page;
  before(async () => { s = await startServer({ session: roleSession() }); page = await openPage(s); page.ev("settings.provider = 'demo'"); });
  after(async () => { page.close(); await s.stop(); });
  const side = () => page.ev("ui.tab = 'plan'; ui.side()");
  const items = r => JSON.parse(page.ev(`JSON.stringify(rbItems('${r}').map(x => x.text))`));

  it('shows a block per role with the items, and acceptance checkboxes only for ux and techwriter', () => {
    side();
    assert.match(page.$('#sidebody').textContent, /Team instructions for the agent/);
    assert.ok(page.$('details[data-rbrole="security"]') && page.$('details[data-rbrole="ux"]'));
    assert.ok(page.$('[data-act="manual-toggle"][data-tc="RB-ux-1"]'), 'ux item is accepted by the PO');
    assert.ok(page.$('[data-act="manual-toggle"][data-tc="RB-techwriter-1"]'));
    assert.equal(page.$('[data-act="manual-toggle"][data-tc="RB-security-1"]'), null, 'security items need no acceptance');
  });

  it('counts unaccepted ux and techwriter items, and stops counting when ticked', () => {
    assert.equal(page.ev('rbCheckOpen().length'), 2);
    page.ev("session.manualChecks = {'RB-ux-1': true}");
    assert.equal(page.ev('rbCheckOpen().length'), 1);
    page.ev('session.manualChecks = {}');
  });

  it('edits, removes and adds an item, and never reuses the number of a removed one', () => {
    page.ev("window.prompt = () => 'Never log tokens or cookies'");
    side(); page.$('[data-act="rb-edit"][data-id="RB-security-1"]').click();
    assert.deepEqual(items('security'), ['Never log tokens or cookies']);
    page.$('[data-act="rb-remove"][data-id="RB-security-1"]').click();
    assert.deepEqual(items('security'), []);
    page.ev("window.prompt = () => 'Validate every input'"); side();
    page.$('[data-act="rb-add"][data-role="security"]').click();
    assert.equal(page.ev("rbItems('security')[0].id"), 'RB-security-2');
  });

  it('keeps an empty answer from changing anything', () => {
    page.ev("window.prompt = () => '   '"); side();
    page.$('[data-act="rb-edit"][data-id="RB-security-2"]').click();
    assert.deepEqual(items('security'), ['Validate every input']);
  });

  it('builds the lists from the proposals once, caps them, and keeps what the PO edited', () => {
    page.ev(`session.team = ['ux', 'fullstack']; session.roleBriefs = {};
      session.proposals = {ux: {deliverables: [' a  b ', '', ...Array.from({length: 12}, (_, i) => 'item ' + i)]}, fullstack: {deliverables: ['ignored']}};
      buildRoleBriefs();`);
    const it = items('ux');
    assert.equal(it.length, 8);
    assert.equal(it[0], 'a b', 'spaces are tidied');
    assert.equal(page.ev("typeof session.roleBriefs.fullstack"), 'undefined', 'the implementer has no list');
    page.ev("session.roleBriefs.ux.items[0].text = 'edited'; buildRoleBriefs()");
    assert.equal(items('ux')[0], 'edited');
  });

  it('puts the lists into the prompts of the plan and of the plan check, and security into the test design', () => {
    page.ev("session.roleBriefs = {security: {items: [{id:'RB-security-1', text:'Never log the token'}], removed: []}, devops: {items: [{id:'RB-devops-1', text:'Add a Dockerfile'}], removed: []}}");
    assert.match(page.ev('rbBlock()'), /Add a Dockerfile/);
    assert.match(page.ev('P.plan()'), /INSTRUCTIONS OF THE SPECIALISTS[\s\S]*Add a Dockerfile/);
    assert.match(page.ev('P.planCheck()'), /Add a Dockerfile/);
    assert.match(page.ev('P.qaPlan()'), /SECURITY REQUIREMENTS[\s\S]*Never log the token/);
  });

  it('writes the lists into the hand-off document', () => {
    assert.match(page.ev('handoffMD()'), /Instructions of the specialists[\s\S]*### [^\n]*\n- Never log the token/);
  });

  it('asks every specialist with a brief for instructions, and the implementers for none', () => {
    const p = page.ev("P.proposal('ux')"), f = page.ev("P.proposal('fullstack')");
    assert.match(p, /"deliverables"/);
    assert.match(p, /3–8 concrete instructions/);
    assert.match(f, /empty array/);
  });
});

describe('checks without a model', () => {
  let s, page;
  const stories = [
    { id: 'S-5', title: 'Web server', description: 'Add the todo ui command in lib/commands.js', owner: 'ux', estimate: 2, acceptance: ['it starts'], dependsOn: [], status: 'todo' },
    { id: 'S-7', title: 'Release pipeline', description: 'Create .github/workflows/release.yml triggered by tags', owner: 'devops', estimate: 2, acceptance: ['it publishes with provenance'], dependsOn: [], status: 'todo' },
    { id: 'S-9', title: 'Package', description: 'Set engines in package.json', owner: 'fullstack', estimate: 1, acceptance: ['done'], dependsOn: [], status: 'todo' },
    { id: 'S-8', title: 'Tests', description: 'Create test/s6.test.js next to test/s5.test.js', owner: 'qa', estimate: 1, acceptance: ['test/s6.test.js has the cases'], dependsOn: [], status: 'todo' },
  ];
  before(async () => {
    const ses = roleSession();
    ses.contextMode = 'existing';
    ses.roleBriefs.devops = brief('devops', [
      '.github/workflows/release.yml: workflow that publishes on semver tags.',
      "package.json: ensure the 'engines' field says Node.js >=18.",
      'Keep the pipeline fast.',
    ]);
    ses.plan.epics = [{ title: 'E', stories }];
    ses.plan.definitionOfDone = ['New tests in test/s5.test.js', 'All tests pass'];
    ses.plan.testPlan = { tag: 'K7Q', strategy: { framework: 'node:test', runCommand: 'node --test test/s5.test.js', levels: [] }, cases: [{ id: 'TC-K7Q-S8-1', story: 'S-8', criterion: 0, level: 'unit', type: 'positive', title: 'Case', given: 'the file test/s5.test.js', when: 'w', then: 't' }], gates: [], uncovered: [] };
    s = await startServer({ session: ses });
    page = await openPage(s);
    page.ev("settings.provider = 'demo'; factsTests = ['test/s5.test.js', 'test/s6.test.js']");
  });
  after(async () => { page.close(); await s.stop(); });

  it('finds the names an instruction is built around: quoted words and file names, not versions', () => {
    const a = JSON.parse(page.ev(`JSON.stringify(anchorsOf("package.json: ensure the 'engines' field says Node.js >=18 and runs on 18.x for lib/ui.js"))`));
    assert.deepEqual(a.sort(), ['engines', 'lib/ui.js', 'package.json']);
  });

  it('reports an instruction of devops that no story of devops mentions, and only that one', () => {
    const gaps = JSON.parse(page.ev('JSON.stringify(rbCoverageGaps().map(g => g.item.id))'));
    assert.deepEqual(gaps, ['RB-devops-2'], 'the workflow file is mentioned; the sentence without names cannot be judged');
  });

  it('offers to add a story that delivers it, drop it, or keep it for the PO', () => {
    const is = JSON.parse(page.ev('JSON.stringify(detIssues(3).filter(x => x.kind === "orphan"))'))[0];
    assert.equal(is.id, 'PC-3');
    assert.deepEqual(is.options.map(o => o.action), ['add_story', 'drop', 'manual']);
    assert.equal(is.options[0].story.owner, 'devops');
    assert.match(is.options[0].story.acceptance[0], /engines/);
  });

  it('applying "drop" removes the instruction and never reuses its number', () => {
    page.ev("session.plan.check = {ts: 1, failed: false, issues: detIssues(1)}");
    const id = page.ev('session.plan.check.issues.find(x => x.kind === "orphan").id');
    page.ev(`applyPlanCheck('${id}', 1)`);
    assert.ok(!JSON.parse(page.ev('JSON.stringify(rbItems("devops").map(x => x.id))')).includes('RB-devops-2'));
    assert.equal(page.ev('rbNextNo("devops")'), 4);
  });

  it('finds the existing test files named anywhere in the plan: DoD, run command, descriptions, criteria and cases', () => {
    const g = JSON.parse(page.ev('JSON.stringify(existingTestFileGaps())'));
    assert.deepEqual(g.map(x => x.file), ['test/s5.test.js', 'test/s6.test.js']);
    assert.deepEqual(g[0].where.sort(), ['DoD', 'S-8', 'TC-K7Q-S8-1', 'run command']);
    assert.deepEqual(g[1].where.sort(), ['S-8']);
  });

  it('makes ONE issue with one button that renames them, with the code of the plan', () => {
    const is = JSON.parse(page.ev('JSON.stringify(detIssues(1).filter(x => x.kind === "contradiction"))'));
    assert.equal(is.length, 1);
    assert.deepEqual(is[0].options.map(o => [o.action, o.recommended]), [['rename', true], ['manual', false]]);
    assert.deepEqual(is[0].options[0].renames, { 'test/s5.test.js': 'test/s5-k7q.test.js', 'test/s6.test.js': 'test/s6-k7q.test.js' });
  });

  it('renames everywhere at once, so no place keeps the old name, and logs a decision that names the new files', () => {
    page.ev("session.plan.check = {ts: 1, failed: false, issues: detIssues(1)}");
    const id = page.ev('session.plan.check.issues.find(x => x.kind === "contradiction").id');
    const opt = page.ev(`session.plan.check.issues.find(x => x.id === '${id}').options.findIndex(o => o.action === 'rename')`);
    page.ev(`applyPlanCheck('${id}', ${opt})`);
    const all = [];
    page.ev('walkPlanTexts((x, w) => { window.__all = (window.__all || []).concat([[w, x]]); return x; })');
    for (const [, x] of JSON.parse(page.ev('JSON.stringify(window.__all)'))) all.push(x);
    assert.ok(!all.some(x => /test\/s[56]\.test\.js/.test(x)), 'no old name is left');
    assert.ok(all.some(x => x.includes('test/s5-k7q.test.js')) && all.some(x => x === 'node --test test/s5-k7q.test.js'), 'the run command runs the new file');
    assert.equal(page.ev('existingTestFileGaps().length'), 0);
    const d = JSON.parse(page.ev('JSON.stringify(session.decisions[session.decisions.length - 1].text)'));
    assert.match(d, /test\/s5-k7q\.test\.js \(test\/s5\.test\.js\)/);
  });

  it('leaves alone the old tests that only the run command, a gate or a risk names: that is a run of the whole suite', () => {
    page.ev("session.plan.testPlan.gates = ['100% of tests pass across test/s5.test.js and test/s6.test.js']; session.plan.testPlan.strategy.runCommand = 'node --test test/s1.test.js test/s5.test.js'");
    assert.equal(page.ev('detIssues(1).filter(x => x.kind === "contradiction").length'), 0, 'nothing creates these files');
    page.ev("session.plan.definitionOfDone.push('New tests in test/s5.test.js')");
    const is = JSON.parse(page.ev('JSON.stringify(detIssues(1).filter(x => x.kind === "contradiction"))'))[0];
    assert.deepEqual(Object.keys(is.options[0].renames), ['test/s5.test.js'], 'only the file the plan writes; test/s1.test.js stays in the command');
    page.ev("session.plan.definitionOfDone.pop(); session.plan.testPlan.gates = []");
  });

  it('does not invent a name that is taken either', () => {
    assert.equal(page.ev("newTestName('test/s5.test.js', new Set(['test/s5-k7q.test.js']))"), 'test/s5-k7q-2.test.js');
  });

  it('reports nothing about test files for a project without a list of them', () => {
    page.ev('factsTests = []');
    assert.equal(page.ev('existingTestFileGaps().length'), 0);
  });

  it('gives a story that writes code from ux, architect or ba to the developer, and leaves devops alone', () => {
    const moved = JSON.parse(page.ev('JSON.stringify(fixStoryOwners())'));
    assert.equal(moved.length, 1);
    assert.match(moved[0], /^S-5/);
    assert.deepEqual(JSON.parse(page.ev('JSON.stringify(planStories().map(x => x.owner))')), ['fullstack', 'devops', 'fullstack', 'qa']);
  });

  it('does nothing when the team has nobody to write code', () => {
    page.ev("session.team = ['ux', 'qa']; planStories()[0].owner = 'ux'");
    assert.equal(page.ev('fixStoryOwners().length'), 0);
    assert.equal(page.ev('planStories()[0].owner'), 'ux');
  });

  it('asks UX for what the user sees and forbids names of files', () => {
    assert.match(page.ev('ROLES.ux.brief'), /NEVER name files, commands, functions or libraries/);
    assert.match(page.ev('P.plan()'), /never by ux, architect or ba/);
  });
});
