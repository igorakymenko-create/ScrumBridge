// Test helpers: every test file starts its own server on a free port with its own project folder and config folder,
// so the tests never touch the real project, the real token or the real credential store.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const story = (id, title, dependsOn = []) => ({ id, title, description: 'd', owner: 'dev', estimate: 1, acceptance: ['a'], dependsOn });

// A complete session as the chat would save it, with a small plan: S-1 -> S-2 -> S-3, and S-4 independent.
export function makeSession(over = {}) {
  return {
    schema: 'ai-scrum-session/1', appVersion: 'test', id: 'sess-1', createdAt: new Date().toISOString(), title: 'Test', request: 'x', phase: 'done',
    proposedTeam: [], teamConfirmed: true, team: [], messages: [], questions: [],
    decisions: [{ id: 'D-1', text: 'Use plain files', rationale: 'simple', source: 'team' }],
    discovery: {}, discoveryDone: true, proposals: {}, reviews: {}, round: 1, openIssues: [],
    contextMode: 'new', projectContext: null, usage: { requests: 0, inTokens: 0, outTokens: 0 },
    plan: {
      sprintGoal: 'g', sprints: [{ name: 'Sprint 1', goal: 'g', stories: ['S-1', 'S-2', 'S-3'] }],
      epics: [{ title: 'E', stories: [story('S-1', 'Storage'), story('S-2', 'CLI', ['S-1']), story('S-3', 'Tests', ['S-2']), story('S-4', 'Docs')] }],
      risks: [], definitionOfDone: ['tests pass'],
      tech: { stack: ['Node.js'], architecture: 'one module', components: [], dataModel: '', interfaces: '', conventions: [], outOfScope: [] },
    },
    ...over,
  };
}

export async function startServer({ session = null, env = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aist-test-'));
  const project = path.join(root, 'project'), config = path.join(root, 'config');
  fs.mkdirSync(path.join(project, '.ai-team'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  if (session) fs.writeFileSync(path.join(project, '.ai-team', 'session.json'), JSON.stringify(session));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), content);
  }
  const port = await freePort();
  const proc = spawn(process.execPath, [ENTRY, '--dir', project], {
    env: { ...process.env, PORT: String(port), AIST_CONFIG_DIR: config, AIST_NO_KEYRING: '1', AIST_WAIT_MS: '1500', ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/mcp'); break; } catch { await sleep(100); } }
  const token = fs.readFileSync(path.join(config, 'token'), 'utf8').trim();
  const bearer = { Authorization: `Bearer ${token}` };

  const api = async (method, url, body, headers = bearer) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  let rpcId = 0;
  const mcp = async (name, args = {}) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    const j = JSON.parse((await res.text()).match(/data: (.*)/)[1]);
    return { text: j.result?.content?.[0]?.text ?? JSON.stringify(j.error), isError: !!j.result?.isError };
  };
  const read = (rel) => fs.readFileSync(path.join(project, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(project, rel));
  const stop = async () => { proc.kill(); await sleep(150); fs.rmSync(root, { recursive: true, force: true }); };
  return { base, port, token, bearer, cookie: { Cookie: `aist_${port}=${token}` }, project, config, api, mcp, read, exists, stop };
}

// A minimal imitation of the Gemini, Anthropic and OpenAI HTTP APIs that records what it receives.
export async function startMockProviders() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      seen.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/openai/v1/models') return send(200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] });
      if (req.url === '/openai/v1/chat/completions') {
        if (body.response_format && body.model === 'no-json-mode') return send(400, { error: { message: "Unsupported parameter: 'response_format'" } });
        if (body.temperature !== undefined && body.model === 'fixed-temp') return send(400, { error: { message: "Unsupported value: 'temperature' does not support 0.7" } });
        if (body.model === 'quota') return send(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } });
        if (body.model === 'slow-down') return send(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '3' });
        if (body.model === 'empty') return send(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
        return send(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      }
      if (req.url === '/claude/v1/models?limit=100') return send(200, { data: [{ id: 'claude-x' }] });
      if (req.url === '/claude/v1/messages') {
        if (req.headers['x-api-key'] !== 'sk-ant-test-key-1234') return send(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        return send(200, { content: [{ type: 'text', text: '{"claude":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 21, output_tokens: 5 } });
      }
      if (req.url === '/gemini/models?pageSize=200') return send(200, { models: [{ name: 'models/g-1', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] });
      if (req.url.startsWith('/gemini/models/') && req.url.endsWith(':generateContent')) {
        if (req.headers['x-goog-api-key'] !== 'AIzaMockGeminiKey123') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
        return send(200, { candidates: [{ content: { parts: [{ thought: true, text: 'hmm' }, { text: '{"gemini":true}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 } });
      }
      send(404, { error: { message: 'no route ' + req.url } });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise(r => server.close(r)) };
}

// Opens the chat page of a running test server in jsdom, as a browser tab would (cookie-free: Bearer header).
export async function openPage(server) {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const html = await (await fetch(server.base + '/', { headers: server.bearer })).text();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail || e.message)));
  const dom = new JSDOM(html, {
    url: server.base + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o = {}) => fetch(new URL(u, server.base), { ...o, headers: { ...(o.headers || {}), ...server.bearer } });
      w.alert = m => errors.push('ALERT ' + m);
      w.confirm = () => true;
      w.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const w = dom.window;
  await sleep(1200);
  return { w, errors, ev: code => w.eval(code), $: sel => w.document.querySelector(sel), $$: sel => [...w.document.querySelectorAll(sel)], close: () => w.close() };
}
