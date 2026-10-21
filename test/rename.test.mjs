// The product was called "ai-scrum-team" and is now "scrumbridge": what the old name left behind must carry over or be replaced.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, makeSession } from './helpers.mjs';

const OLD_BLOCK = '<!-- ai-scrum-team:start -->\n## AI Scrum Team\nold rules\n<!-- ai-scrum-team:end -->';

describe('connecting an IDE that was connected under the old name', () => {
  let s;
  const connect = ide => s.api('POST', '/api/connect', { ide });
  before(async () => {
    s = await startServer({
      session: makeSession(),
      files: {
        '.mcp.json': JSON.stringify({ mcpServers: { 'ai-scrum-team': { type: 'http', url: 'http://127.0.0.1:4700/mcp' }, other: { type: 'http', url: 'http://other/mcp' } } }),
        'CLAUDE.md': `# Mine\n\n${OLD_BLOCK}\n\nAfter the block.\n`,
        '.mcp.json.ai-scrum-team.bak': '{}',
        '.vscode/mcp.json': JSON.stringify({ servers: { 'ai-scrum-team': { type: 'http', url: 'https://example.com/mcp' } } }),
        '.cursor/rules/ai-scrum-team.mdc': 'old rules of ours',
        '.cursor/mcp.json': '{}',
      },
    });
  });
  after(() => s.stop());

  it('replaces the entry of the old name, keeps other servers, and makes no second "original" backup', async () => {
    assert.equal((await connect('claude-code')).json.ok, true);
    const cfg = JSON.parse(s.read('.mcp.json'));
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['other', 'scrumbridge']);
    assert.ok(!s.exists('.mcp.json.scrumbridge.bak'), 'the first backup already exists under the old name');
  });

  it('turns the block of the old name into the block of the new one, in the same place, once', async () => {
    const md = s.read('CLAUDE.md');
    assert.ok(!md.includes('ai-scrum-team') && !md.includes('old rules'));
    assert.equal(md.match(/scrumbridge:start/g).length, 1);
    assert.ok(md.startsWith('# Mine\n\n<!-- scrumbridge:start -->'), 'it stays where it was');
    assert.match(md, /<!-- scrumbridge:end -->\n\nAfter the block\.\n$/);
    assert.match(md, /## ScrumBridge/);
  });

  it('leaves an entry of the old name alone when it does not point at a local /mcp address', async () => {
    assert.equal((await connect('vscode')).json.ok, true);
    const cfg = JSON.parse(s.read('.vscode/mcp.json'));
    assert.deepEqual(Object.keys(cfg.servers).sort(), ['ai-scrum-team', 'scrumbridge']);
  });

  it('removes the rules file of the old name for Cursor and writes the new one', async () => {
    assert.equal((await connect('cursor')).json.ok, true);
    assert.ok(!s.exists('.cursor/rules/ai-scrum-team.mdc'));
    assert.match(s.read('.cursor/rules/scrumbridge.mdc'), /description: ScrumBridge plan and decisions/);
  });
});

describe('config folder and credentials of the old name', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aist-mig-'));
  const dir = path.join(tmp, 'scrumbridge'), legacy = path.join(tmp, 'ai-scrum-team');
  let cfg;
  before(async () => {
    // before the module is loaded: a module that runs the move on its own must not touch the real folder of this machine
    process.env.AIST_CONFIG_DIR = path.join(tmp, 'unused');
    cfg = await import(pathToFileURL(path.resolve('dist/config.js')).href + '?mig');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('does nothing on a first run: no old folder', () => {
    assert.equal(cfg.migrateLegacyConfig(dir, legacy), false);
    assert.ok(!fs.existsSync(dir));
  });

  it('copies token, keys, approvals and settings to the new folder and leaves the old one as it was', () => {
    fs.mkdirSync(path.join(legacy, 'sub'), { recursive: true });
    for (const f of ['token', 'credentials.json', 'approvals.json', 'settings.json']) fs.writeFileSync(path.join(legacy, f), 'old ' + f);
    assert.equal(cfg.migrateLegacyConfig(dir, legacy), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['approvals.json', 'credentials.json', 'settings.json', 'token']);
    assert.equal(fs.readFileSync(path.join(dir, 'token'), 'utf8'), 'old token');
    assert.equal(fs.readdirSync(legacy).length, 5, 'nothing was moved or deleted');
  });

  it('does not run again over a new folder: what the user changed since stays', () => {
    fs.writeFileSync(path.join(dir, 'token'), 'new token');
    assert.equal(cfg.migrateLegacyConfig(dir, legacy), false);
    assert.equal(fs.readFileSync(path.join(dir, 'token'), 'utf8'), 'new token');
  });

  describe('keys in the credential store', () => {
    const store = new Map();
    const factory = (service, account) => ({
      getPassword: () => store.get(service + '/' + account) ?? null,
      setPassword: p => { store.set(service + '/' + account, p); },
      deletePassword: () => store.delete(service + '/' + account),
    });
    before(() => cfg.useKeyring(factory));
    after(() => cfg.useKeyring(null));

    it('moves a key stored under the old name to the new entry the first time it is read', async () => {
      store.set('ai-scrum-team/gemini', 'KEY-1');
      const r = await cfg.getKey('gemini', []);
      assert.deepEqual(r, { key: 'KEY-1', source: 'keychain' });
      assert.equal(store.get('scrumbridge/gemini'), 'KEY-1');
      assert.ok(!store.has('ai-scrum-team/gemini'), 'no copy of the secret is left under the old name');
    });

    it('prefers the new entry when both exist', async () => {
      store.set('scrumbridge/openai', 'NEW');
      store.set('ai-scrum-team/openai', 'OLD');
      assert.equal((await cfg.getKey('openai', [])).key, 'NEW');
    });

    it('deleting a key deletes it under both names, so the old one cannot bring it back', async () => {
      store.set('scrumbridge/anthropic', 'A');
      store.set('ai-scrum-team/anthropic', 'B');
      await cfg.deleteKey('anthropic');
      assert.equal(await cfg.getKey('anthropic', []), null);
    });
  });
});

describe('the product name', () => {
  it('is ScrumBridge in the package, the MCP server and the page', async () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(pkg.name, 'scrumbridge');
    assert.deepEqual(Object.keys(pkg.bin), ['scrumbridge']);
    const html = fs.readFileSync('public/index.html', 'utf8');
    assert.match(html, /<title>ScrumBridge<\/title>/);
    assert.ok(!/ai-scrum-team|AI Scrum Team/.test(html), 'no old name is left in the page');
    const s = await startServer({ session: makeSession() });
    try {
      const r = await s.mcp('get_status');
      assert.ok(!/ai-scrum-team|AI Scrum Team/.test(r.text));
    } finally { await s.stop(); }
  });
});
