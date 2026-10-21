#!/usr/bin/env node
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PROJECT_DIR, PROJECT_ID, STATE_DIR, SPEC_FILE, readSession, writeSession, readProgress, writeProgress, emptyProgress } from './state.js';
import { createMcpServer, answerAgentQuestion, resolveAssumption } from './mcp.js';
import { connectIde, connectStatus } from './connect.js';
import { autopilot } from './autopilot.js';
import { spawn } from 'node:child_process';
import { getToken, tokenMatches, getKey, setKey, deleteKey, CONFIG_DIR, waitMs, readSettings, writeSettings, DEFAULT_WAIT_SECONDS } from './config.js';
import { checkApproval } from './verify.js';
import { setApproval, getApproval, clearApproval } from './config.js';
import { PROVIDER_TYPES, LlmError, generate, listModels, listConnections, getConnection, addConnection, removeConnection, connectionNeedsKey, connectionEnvVars } from './llm.js';
import { readContext, writeContext, quickScan, projectFacts, findTestCode, MAX_CONTEXT_CHARS } from './context.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4700);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(express.json({ limit: '16mb' }));

// ---- who may talk to the server ----
// 1. Host and Origin must be local: this stops web pages in the user's browser (including DNS rebinding) from using it.
// 2. The chat and its API need the access token (cookie set on the first visit with ?token=..., or a Bearer header).
//    It keeps other accounts on the same computer away from the API keys. /mcp is open to local callers, so IDE
//    configs written earlier keep working.
const COOKIE = `aist_${PORT}`;
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const cookieOf = (header: string | undefined, name: string): string | undefined =>
  header?.split(';').map(p => p.trim().split('=')).find(([k]) => k === name)?.[1];

app.use((req, res, next) => {
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) { res.status(403).json({ error: 'forbidden host' }); return; }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { res.status(403).json({ error: 'forbidden origin' }); return; }
  next();
});

const callerKind = (req: express.Request): 'bearer' | 'cookie' | null => {
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1];
  if (tokenMatches(bearer)) return 'bearer';
  return tokenMatches(cookieOf(req.headers.cookie, COOKIE)) ? 'cookie' : null;
};
const authorized = (req: express.Request): boolean => callerKind(req) !== null;

app.use('/api', (req, res, next) => {
  const kind = callerKind(req);
  if (!kind) { res.status(401).json({ error: 'unauthorized: open the link printed by scrumbridge (it contains the access token)' }); return; }
  // A browser tab may only change the project it was opened for (the app can be restarted on another folder
  // while an old tab is still open). Scripts with the token are not tabs, and provider settings are not per project.
  const projectBound = req.method !== 'GET' && !req.path.startsWith('/llm/') && !req.path.startsWith('/settings');
  if (kind === 'cookie' && projectBound && req.headers['x-aist-project'] !== PROJECT_ID) {
    res.status(409).json({ error: 'this tab belongs to another project: reload the page' });
    return;
  }
  next();
});

// The version of the page file. A tab that was opened before the app was updated compares it with this one and offers
// a reload, so nobody keeps working in an outdated page without knowing it.
const pageBuild = (html: string): string => crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
app.get('/api/build', (_req, res) => { res.json({ build: pageBuild(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')) }); });

// Chat UI: the page gets the stored session injected, so it can start synchronously.
app.get('/', (req, res) => {
  const q = req.query.token;
  if (typeof q === 'string' && tokenMatches(q)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${getToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    res.redirect('/');
    return;
  }
  if (!authorized(req)) {
    res.status(401).type('text/plain').send('ScrumBridge: access token required.\nOpen the link printed in the terminal where the app was started (http://127.0.0.1:' + PORT + '/?token=...).');
    return;
  }
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const json = JSON.stringify(readSession()).replace(/</g, () => String.fromCharCode(92) + 'u003c');
  const inject = `<script>window.__AIST_SERVER__=true;window.__AIST_PROJECT__=${JSON.stringify(PROJECT_ID)};window.__AIST_BUILD__=${JSON.stringify(pageBuild(html))};window.__AIST_SESSION__=${json};</script>`;
  res.type('html').send(html.replace('<script>', () => inject + '\n<script>'));
});

// ---- model providers: the browser asks, the server holds the keys ----
function sendLlmError(res: express.Response, e: unknown): void {
  const le = e instanceof LlmError ? e : new LlmError(String((e as Error)?.message || e));
  res.status(le.status >= 400 && le.status < 600 ? le.status : 502).json({ error: { message: le.message, status: le.status, retryAfter: le.retryAfter, daily: le.daily } });
}

app.get('/api/llm/providers', async (_req, res) => {
  const connections = await Promise.all(listConnections().map(async c => {
    const needsKey = connectionNeedsKey(c);
    const k = await getKey(c.id, connectionEnvVars(c));
    return { id: c.id, type: c.type, label: c.label, baseUrl: c.baseUrl || '', needsKey, hasKey: !needsKey || !!k, source: k?.source ?? null };
  }));
  res.json({ connections, types: PROVIDER_TYPES });
});
app.post('/api/llm/providers', (req, res) => {
  try { res.json(addConnection({ type: String(req.body?.type || ''), label: String(req.body?.label || ''), baseUrl: String(req.body?.baseUrl || '') })); }
  catch (e) { sendLlmError(res, e); }
});
app.delete('/api/llm/providers', async (req, res) => {
  const id = String(req.query.id || '');
  if (!removeConnection(id)) { res.status(404).json({ error: 'unknown provider' }); return; }
  await deleteKey(id);
  res.json({ ok: true });
});
app.put('/api/llm/key', async (req, res) => {
  const { provider, key } = req.body || {};
  if (!getConnection(provider) || typeof key !== 'string' || key.trim().length < 8 || key.length > 600) { res.status(400).json({ error: 'bad provider or key' }); return; }
  res.json({ ok: true, source: await setKey(provider, key.trim()) });
});
app.delete('/api/llm/key', async (req, res) => {
  const provider = String(req.query.provider || '');
  if (!getConnection(provider)) { res.status(400).json({ error: 'unknown provider' }); return; }
  await deleteKey(provider);
  res.json({ ok: true });
});
app.get('/api/llm/models', async (req, res) => {
  try { res.json({ models: await listModels(String(req.query.provider || '')) }); } catch (e) { sendLlmError(res, e); }
});
app.post('/api/llm/generate', async (req, res) => {
  const b = req.body || {};
  if (typeof b.provider !== 'string' || typeof b.model !== 'string' || typeof b.prompt !== 'string') { res.status(400).json({ error: { message: 'provider, model and prompt are required', status: 400 } }); return; }
  try {
    res.json(await generate(b.provider, {
      model: b.model, system: String(b.system || ''), prompt: b.prompt, json: b.json !== false,
      temperature: Math.min(2, Math.max(0, Number(b.temperature) || 0.7)),
    }));
  } catch (e) { sendLlmError(res, e); }
});

app.get('/api/session', (_req, res) => { res.json(readSession()); });
app.put('/api/session', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || typeof req.body.schema !== 'string') {
    res.status(400).json({ error: 'not a session' });
    return;
  }
  const old = readSession();
  if (old?.id && req.body.id !== old.id) {
    try {
      const dir = path.join(STATE_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `session-${String(old.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${Date.now()}.json`), JSON.stringify(old, null, 2));
      const files = fs.readdirSync(dir).filter(f => f.startsWith('session-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 10))) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* a failed backup must not block saving */ }
  }
  writeSession(req.body);
  res.json({ ok: true });
});

// SPEC.md: the human-readable hand-off, rendered by the chat from the current session.
app.put('/api/spec', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    res.status(400).json({ error: 'empty spec' });
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SPEC_FILE, req.body);
  res.json({ ok: true });
});

// What the agent reported (story statuses, questions, blockers); the chat polls it.
app.get('/api/progress', (_req, res) => { res.json(readProgress()); });
app.delete('/api/progress', (_req, res) => { writeProgress(emptyProgress()); res.json({ ok: true }); });
// The Product Owner reviews an assumption of the agent: confirm it, or reject it with an instruction.
app.post('/api/progress/assumption', (req, res) => {
  const { id, action, note, decisionId } = req.body || {};
  if (typeof id !== 'string' || !['confirm', 'reject'].includes(action)) { res.status(400).json({ error: 'id and action (confirm or reject) are required' }); return; }
  if (action === 'reject' && !(typeof note === 'string' && note.trim())) { res.status(400).json({ error: 'a rejection needs the instruction of the Product Owner' }); return; }
  res.json({ ok: resolveAssumption(id, action, typeof note === 'string' ? note.trim() : '', typeof decisionId === 'string' ? decisionId : undefined) });
});
app.post('/api/progress/answer', (req, res) => {
  const { id, optionId, text, delegated, decisionId } = req.body || {};
  if (typeof id !== 'string' || typeof text !== 'string') {
    res.status(400).json({ error: 'id and text are required' });
    return;
  }
  const ok = answerAgentQuestion(id, { optionId, text, delegated, decisionId });
  if (ok) autopilot.onAnswer();
  res.json({ ok });
});

// "Connect an IDE": writes the MCP server entry and the agent rules into the IDE's config.
const MCP_URL = `http://${HOST}:${PORT}/mcp`;
app.get('/api/connect', (_req, res) => { res.json(connectStatus(MCP_URL)); });
app.post('/api/connect', (req, res) => {
  const r = connectIde(String(req.body?.ide || ''), MCP_URL);
  res.status(r.ok ? 200 : 400).json(r);
});

// Existing-project context (.ai-team/PROJECT.md).
app.get('/api/context', (_req, res) => { res.json(readContext()); });
app.put('/api/context', (req, res) => {
  const t = req.body?.text;
  if (typeof t !== 'string' || !t.trim()) { res.status(400).json({ error: 'empty text' }); return; }
  if (t.length > MAX_CONTEXT_CHARS) { res.status(400).json({ error: `too long (limit ${MAX_CONTEXT_CHARS} characters)` }); return; }
  res.json(writeContext(t, req.body?.source === 'scan' ? 'scan' : 'manual'));
});
app.post('/api/context/scan', (_req, res) => { res.json({ text: quickScan() }); });
// Facts of the real code (test files, scripts, beginnings of source files) for the prompts of an existing project.
app.get('/api/facts', (_req, res) => { res.json(projectFacts()); });
// The code of the automated test of a case (found by the ID in the test files), so that "automated" can be checked by eye.
app.get('/api/testcode', (req, res) => { res.json({ matches: findTestCode(String(req.query.id || '')) }); });

// Settings of the user for the app as a whole: how long the agent waits for an answer of the Product Owner.
app.get('/api/settings', (_req, res) => { res.json({ waitSeconds: Math.round(waitMs() / 1000), defaultWaitSeconds: DEFAULT_WAIT_SECONDS, fromEnvironment: !!Number(process.env.AIST_WAIT_MS) }); });
app.put('/api/settings', (req, res) => {
  const w = Number(req.body?.waitSeconds);
  if (!Number.isFinite(w) || w < 5 || w > 3600) { res.status(400).json({ error: 'waitSeconds must be between 5 and 3600' }); return; }
  writeSettings({ ...readSettings(), waitSeconds: w });
  res.json({ waitSeconds: Math.round(waitMs() / 1000) });
});

// The test command the Product Owner approved: the app runs it before a story may be "done" (see verify.ts).
app.get('/api/verify', (_req, res) => {
  const proposed = readSession()?.plan?.testPlan?.strategy || {};
  res.json({ proposed: { command: proposed.runCommand || '', reportFile: proposed.reportFile || '' }, approved: getApproval(PROJECT_ID) });
});
app.put('/api/verify', (req, res) => {
  const { command, reportFile } = req.body || {};
  const bad = checkApproval(command, reportFile ?? '');
  if (bad) { res.status(400).json({ error: bad }); return; }
  res.json({ ok: true, approved: setApproval(PROJECT_ID, { command, reportFile: reportFile ?? '' }) });
});
app.delete('/api/verify', (_req, res) => { clearApproval(PROJECT_ID); res.json({ ok: true }); });

// Autopilot: the app runs a command-line agent itself.
app.get('/api/autopilot', (_req, res) => { res.json(autopilot.snapshot()); });
app.post('/api/autopilot/start', (req, res) => {
  const r = autopilot.start(String(req.body?.agent || ''), req.body?.mode === 'analyze' ? 'analyze' : 'implement');
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/autopilot/stop', (_req, res) => { autopilot.stop(); res.json({ ok: true }); });

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all('/mcp', (_req, res) => { res.status(405).json({ error: 'method not allowed' }); });

app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${getToken()}`;
  console.log(`ScrumBridge is running. Open the chat: ${url}`);
  console.log(`MCP endpoint for IDEs: http://${HOST}:${PORT}/mcp`);
  console.log(`Project: ${PROJECT_DIR}  (state in .ai-team/)  ·  keys and token: ${CONFIG_DIR}`);
  // open the browser when started by a person in a terminal (not when run in the background)
  if (process.stdout.isTTY && !process.argv.includes('--no-open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the link above is enough */ }
  }
});
