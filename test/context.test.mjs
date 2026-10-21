import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

describe('context of an existing project', () => {
  let s;
  before(async () => {
    s = await startServer({
      files: {
        'README.md': '# Shop\n\nA small web shop.\n',
        'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'node --test', start: 'node index.js' }, dependencies: { express: '^5', zod: '^4' } }),
        'AGENTS.md': 'Always write tests.',
        'docs/design.md': '# Design',
        'src/index.js': '// code',
        // the shape of a record sits below a long header: it must still be in the snapshot (the plan must not invent other field names)
        'lib/model.js': Array.from({ length: 70 }, (_, i) => `// documentation line ${i} of a long header comment padding the file`).join('\n') + "\nexport const makeTask = text => ({ id: 1, text, status: 'pending' });\n",
        'test/code.test.js': "import test from 'node:test';\n\ntest('TC-ABC-S1-1 creates the file', () => {\n  assert.ok(true);\n  nested({ a: 1 });\n});\n\ntest('TC-ABC-S1-10 another case', () => {\n  assert.ok(false);\n});\n",
        'tests/test_py.py': "def test_export():  # TC-ABC-S2-1\n    assert 1\n\n\ndef test_other():\n    pass\n",
        'test/a.test.js': '// test a',
        'test/b.spec.js': '// test b',
        'node_modules/junk/index.js': '// must not be listed',
      },
    });
  });
  after(() => s.stop());

  it('gives the planning prompts the facts of the real code: test files, scripts, beginnings of source files', async () => {
    const f = (await s.api('GET', '/api/facts')).json;
    assert.deepEqual(f.tests, ['test/a.test.js', 'test/b.spec.js', 'test/code.test.js', 'tests/test_py.py'], 'both kinds of test files are found, and the source files are not taken for tests');
    assert.match(f.text, /Existing test files .*: test\/a\.test\.js, test\/b\.spec\.js, test\/code\.test\.js, tests\/test_py\.py/);
    assert.ok(!f.sources.some(x => x.path.startsWith('test/')), 'test files are not shown as sources');
    assert.match(f.text, /FACTS FROM THE REPOSITORY/);
    assert.match(f.text, /Existing test files \(new tests must go to NEW file names; never overwrite these\):/);
    assert.match(f.text, /npm scripts: test = node --test; start = node index\.js/);
    assert.match(f.text, /--- src\/index\.js\n\/\/ code/);
    assert.match(f.text, /status: 'pending'/, 'the field names of the real records are in the snapshot');
    assert.ok(!f.text.includes('node_modules'), 'dependencies are not listed');
    assert.ok(!f.text.includes('.ai-team'), 'the state folder is not listed');
    assert.ok(f.text.length < 14000, 'the snapshot is small enough for every prompt');
  });

  it('shows the code of the automated test of a case, found by its ID in the project (not by a path from a report)', async () => {
    const js = (await s.api('GET', '/api/testcode?id=TC-ABC-S1-1')).json.matches;
    assert.equal(js.length, 1);
    assert.equal(js[0].file, 'test/code.test.js');
    assert.equal(js[0].line, 3);
    assert.match(js[0].code, /^test\('TC-ABC-S1-1 creates the file', \(\) => \{\n  assert\.ok\(true\);\n  nested\(\{ a: 1 \}\);\n\}\);$/);
    assert.ok(!js[0].code.includes('S1-10'), 'only the block of this case, and TC-S1-1 is not found in TC-S1-10');
    const py = (await s.api('GET', '/api/testcode?id=TC-ABC-S2-1')).json.matches;
    assert.equal(py[0].file, 'tests/test_py.py');
    assert.match(py[0].code, /def test_export\(\):  # TC-ABC-S2-1\n    assert 1/);
    assert.ok(!py[0].code.includes('test_other'));
  });

  it('answers with nothing for an ID that is in no test, and refuses odd input', async () => {
    assert.deepEqual((await s.api('GET', '/api/testcode?id=TC-ABC-S9-9')).json.matches, []);
    assert.deepEqual((await s.api('GET', '/api/testcode?id=../../etc/passwd')).json.matches, []);
    assert.deepEqual((await s.api('GET', '/api/testcode')).json.matches, []);
    assert.equal((await s.api('GET', '/api/testcode?id=TC-ABC-S1-1', undefined, {})).status, 401, 'it needs the access token like the rest of the API');
  });

  it('has no context at first', async () => {
    assert.equal((await s.api('GET', '/api/context')).json.exists, false);
  });

  it('builds a draft from the files without an agent or a model', async () => {
    const t = (await s.api('POST', '/api/context/scan')).json.text;
    assert.match(t, /Manifests found: package\.json/);
    assert.match(t, /test = node --test/);
    assert.match(t, /Dependencies: express, zod/);
    assert.match(t, /A small web shop/);
    assert.match(t, /Always write tests/);
    assert.match(t, /Folders: docs/);
    assert.match(t, /src\//);
    assert.ok(!t.includes('node_modules'), 'dependencies folders are not listed');
  });

  it('saves a confirmed text and remembers where it came from', async () => {
    const r = await s.api('PUT', '/api/context', { text: '# Project context\n\nShop.', source: 'scan' });
    assert.equal(r.json.exists, true);
    assert.equal(r.json.source, 'scan');
    assert.equal(s.read('.ai-team/PROJECT.md').trim(), '# Project context\n\nShop.');
    assert.equal((await s.api('GET', '/api/context')).json.text.trim(), '# Project context\n\nShop.');
  });

  it('limits the size, because the text goes into every request of the team', async () => {
    const big = await s.api('PUT', '/api/context', { text: 'x'.repeat(8001) });
    assert.equal(big.status, 400);
    assert.equal((await s.api('PUT', '/api/context', { text: '   ' })).status, 400);
    assert.equal((await s.api('PUT', '/api/context', { text: 'x'.repeat(8000) })).status, 200);
  });

  it('lets an agent submit the summary through MCP, with the same size limit', async () => {
    const ok = await s.mcp('submit_project_context', { summary: '# Project context\n\nFrom the agent.' });
    assert.ok(!ok.isError);
    const info = (await s.api('GET', '/api/context')).json;
    assert.equal(info.source, 'agent');
    assert.match(info.text, /From the agent/);
    assert.match((await s.mcp('get_project_context')).text, /From the agent/);
    const long = await s.mcp('submit_project_context', { summary: 'y'.repeat(9000) });
    assert.ok(long.isError);
    assert.match(long.text, /Too long/);
    assert.match((await s.mcp('get_project_context')).text, /From the agent/, 'the old summary survives a rejected one');
  });
});
