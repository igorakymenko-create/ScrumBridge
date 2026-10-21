import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeSession } from './helpers.mjs';

describe('session, spec and progress storage', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  it('has no session at first', async () => {
    const r = await s.api('GET', '/api/session');
    assert.equal(r.status, 200);
    assert.equal(r.json, null);
  });

  it('stores a session and returns it unchanged', async () => {
    const sess = makeSession({ title: 'Round trip' });
    assert.equal((await s.api('PUT', '/api/session', sess)).status, 200);
    assert.deepEqual((await s.api('GET', '/api/session')).json, sess);
    assert.deepEqual(JSON.parse(s.read('.ai-team/session.json')), sess);
  });

  it('rejects things that are not sessions', async () => {
    assert.equal((await s.api('PUT', '/api/session', { hello: 1 })).status, 400);
    assert.equal((await s.api('PUT', '/api/session', '"text"')).status, 400);
  });

  it('keeps the previous session in backups/ when a different session replaces it', async () => {
    await s.api('PUT', '/api/session', makeSession({ id: 'first', title: 'First' }));
    await s.api('PUT', '/api/session', makeSession({ id: 'first', title: 'First, edited' }));
    assert.ok(!s.exists('.ai-team/backups') || fs.readdirSync(path.join(s.project, '.ai-team', 'backups')).every(f => !f.includes('first')), 'edits of the same session are not backed up');
    await s.api('PUT', '/api/session', makeSession({ id: 'second', title: 'Second' }));
    const files = fs.readdirSync(path.join(s.project, '.ai-team', 'backups'));
    const b = files.find(f => f.startsWith('session-first-'));
    assert.ok(b, 'a backup of the replaced session exists');
    assert.equal(JSON.parse(s.read('.ai-team/backups/' + b)).title, 'First, edited');
  });

  it('cannot be tricked into writing a backup outside backups/ by a session id with path characters', async () => {
    await s.api('PUT', '/api/session', makeSession({ id: '../../escaped W/x', title: 'Evil id' }));
    await s.api('PUT', '/api/session', makeSession({ id: 'next-one', title: 'Next' }));
    const dir = path.join(s.project, '.ai-team', 'backups');
    const evil = fs.readdirSync(dir).find(f => f.includes('escaped'));
    assert.ok(evil, 'the backup exists inside backups/');
    assert.ok(!/[\\/]/.test(evil), 'the file name has no path characters');
    assert.ok(/W/.test(evil), 'letters are kept as they are');
    assert.ok(!fs.existsSync(path.join(s.project, 'escaped W')) && !fs.existsSync(path.join(s.project, '..', 'escaped W')));
  });

  it('keeps at most ten backups', async () => {
    for (let i = 0; i < 14; i++) await s.api('PUT', '/api/session', makeSession({ id: 'n' + i, title: 'N' + i }));
    const files = fs.readdirSync(path.join(s.project, '.ai-team', 'backups')).filter(f => f.startsWith('session-'));
    assert.ok(files.length <= 10, `found ${files.length}`);
  });

  it('writes SPEC.md and refuses an empty one', async () => {
    assert.equal((await s.api('PUT', '/api/spec', '# Spec\n\nbody', { ...s.bearer, 'Content-Type': 'text/markdown' })).status, 200);
    assert.equal(s.read('.ai-team/SPEC.md'), '# Spec\n\nbody');
    assert.equal((await s.api('PUT', '/api/spec', '   ', { ...s.bearer, 'Content-Type': 'text/markdown' })).status, 400);
  });

  it('resets the agent progress', async () => {
    await s.api('PUT', '/api/session', makeSession());
    await s.mcp('update_story', { id: 'S-1', status: 'in_progress' });
    assert.equal((await s.api('GET', '/api/progress')).json.stories['S-1'].status, 'in_progress');
    await s.api('DELETE', '/api/progress');
    assert.deepEqual((await s.api('GET', '/api/progress')).json, { stories: {}, questions: [], blockers: [], assumptions: [] });
  });

  it('writes files atomically (no temporary files are left behind)', async () => {
    const left = fs.readdirSync(path.join(s.project, '.ai-team')).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });
});
