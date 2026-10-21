import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeSession } from './helpers.mjs';

const BLOCK = /<!-- scrumbridge:start -->[\s\S]*<!-- scrumbridge:end -->/;

describe('connecting an IDE', () => {
  let s;
  const connect = ide => s.api('POST', '/api/connect', { ide });
  before(async () => {
    s = await startServer({
      session: makeSession(),
      files: {
        'CLAUDE.md': '# My own rules\n\nKeep it simple.\n',
        '.vscode/mcp.json': JSON.stringify({ servers: { other: { type: 'http', url: 'http://other/mcp' } } }),
        '.cursor/mcp.json': '{ this is not json',
      },
    });
  });
  after(() => s.stop());

  it('lists the supported IDEs as not connected', async () => {
    const r = (await s.api('GET', '/api/connect')).json;
    assert.deepEqual(r.map(i => i.id), ['antigravity', 'claude-code', 'cursor', 'vscode']);
    assert.ok(r.every(i => i.connected === false));
  });

  it('writes the MCP entry for Claude Code into the project and keeps the user text in CLAUDE.md', async () => {
    const r = await connect('claude-code');
    assert.equal(r.json.ok, true);
    const cfg = JSON.parse(s.read('.mcp.json'));
    assert.deepEqual(cfg.mcpServers['scrumbridge'], { type: 'http', url: `${s.base}/mcp` });
    const md = s.read('CLAUDE.md');
    assert.ok(md.startsWith('# My own rules\n\nKeep it simple.'), 'existing text stays first');
    assert.match(md, BLOCK);
    assert.match(md, /It waits for the answer/);
  });

  it('is idempotent: a second click does not duplicate anything', async () => {
    await connect('claude-code');
    await connect('claude-code');
    assert.equal(s.read('CLAUDE.md').match(/scrumbridge:start/g).length, 1);
    assert.deepEqual(Object.keys(JSON.parse(s.read('.mcp.json')).mcpServers), ['scrumbridge']);
  });

  it('keeps other servers in an existing config and keeps one backup', async () => {
    assert.equal((await connect('vscode')).json.ok, true);
    const cfg = JSON.parse(s.read('.vscode/mcp.json'));
    assert.deepEqual(Object.keys(cfg.servers).sort(), ['other', 'scrumbridge']);
    assert.ok(s.exists('.vscode/mcp.json.scrumbridge.bak'));
    assert.match(s.read('.github/copilot-instructions.md'), BLOCK);
  });

  it('refuses to overwrite a config it cannot read', async () => {
    const r = await connect('cursor');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.equal(s.read('.cursor/mcp.json'), '{ this is not json', 'the broken file is left untouched');
  });

  it('writes Antigravity into the PROJECT, never into the global config', async () => {
    const r = await connect('antigravity');
    assert.equal(r.json.ok, true);
    assert.ok(r.json.files.every(f => !f.startsWith('~')), `no file outside the project: ${r.json.files}`);
    assert.deepEqual(JSON.parse(s.read('.agents/mcp_config.json')).mcpServers['scrumbridge'], { serverUrl: `${s.base}/mcp` });
    assert.match(s.read('AGENTS.md'), BLOCK);
  });

  it('reports connected IDEs from the config files themselves', async () => {
    const r = (await s.api('GET', '/api/connect')).json;
    assert.deepEqual(r.filter(i => i.connected).map(i => i.id).sort(), ['antigravity', 'claude-code', 'vscode']);
  });

  it('rejects an unknown IDE', async () => {
    assert.equal((await connect('notepad')).status, 400);
  });
});
