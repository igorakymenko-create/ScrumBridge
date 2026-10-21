import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_DIR } from './state.js';

const NAME = 'scrumbridge';
const BLOCK_START = '<!-- scrumbridge:start -->';
const BLOCK_END = '<!-- scrumbridge:end -->';
// The product used to be called "ai-scrum-team"; what it wrote under that name is replaced on the next "connect".
const LEGACY_NAME = 'ai-scrum-team';
const LEGACY_START = '<!-- ai-scrum-team:start -->';
const LEGACY_END = '<!-- ai-scrum-team:end -->';

// Short, stable rules for the agent: the plan itself comes through the MCP tools.
const RULES = `## ScrumBridge

The plan for this project comes from a ScrumBridge team of AI roles through the MCP server "${NAME}".
- Work through the plan with its tools: get_next_story → update_story(in_progress) → implement + automated tests → update_story(done, testsPassed=true).
- Each story comes with a test plan made by QA: implement every automated case as a test whose name starts with the case ID, and report each one in update_story(testResults=...). "done" is refused otherwise, and the app may run the approved test command to confirm it.
- The decisions (get_decisions) are binding. Never change one silently: if it blocks you, call report_blocker.
- Anything the decisions do not cover, and every conflict between a story and the existing code or the decisions: call ask_po BEFORE you choose. It waits for the answer. Never choose for the Product Owner and never carry on with work that depends on the answer; if it does not arrive, stop and tell the human you are waiting.
- Only a small detail that changes nothing the story promises may be recorded with record_assumption. Never leave open choices for the final message.
- The prompt "implement-next-story" starts the whole loop.`;

interface Target {
  id: string; label: string;
  configFile: string;             // where the MCP server entry is written
  entry: (url: string) => object; // the entry itself
  rootKey: 'mcpServers' | 'servers';
  rulesFile: string;
  rulesOwn: boolean;              // true: a file that belongs to us; false: a marked block inside the user's file
  rulesHeader?: string;           // front matter for files we own
  verified: boolean;              // config format checked against a real installation
}

const home = os.homedir();
const TARGETS: Target[] = [
  // Project-level config (.agents/mcp_config.json): the server is visible only in the window of this project.
  // The global ~/.gemini/config/mcp_config.json would expose it, and let an agent act, in every project.
  { id: 'antigravity', label: 'Antigravity', configFile: path.join(PROJECT_DIR, '.agents', 'mcp_config.json'), rootKey: 'mcpServers',
    entry: url => ({ serverUrl: url }), rulesFile: path.join(PROJECT_DIR, 'AGENTS.md'), rulesOwn: false, verified: false },
  { id: 'claude-code', label: 'Claude Code', configFile: path.join(PROJECT_DIR, '.mcp.json'), rootKey: 'mcpServers',
    entry: url => ({ type: 'http', url }), rulesFile: path.join(PROJECT_DIR, 'CLAUDE.md'), rulesOwn: false, verified: true },
  { id: 'cursor', label: 'Cursor', configFile: path.join(PROJECT_DIR, '.cursor', 'mcp.json'), rootKey: 'mcpServers',
    entry: url => ({ url }), rulesFile: path.join(PROJECT_DIR, '.cursor', 'rules', 'scrumbridge.mdc'), rulesOwn: true,
    rulesHeader: '---\ndescription: ScrumBridge plan and decisions\nalwaysApply: true\n---\n\n', verified: false },
  { id: 'vscode', label: 'VS Code (Copilot)', configFile: path.join(PROJECT_DIR, '.vscode', 'mcp.json'), rootKey: 'servers',
    entry: url => ({ type: 'http', url }), rulesFile: path.join(PROJECT_DIR, '.github', 'copilot-instructions.md'), rulesOwn: false, verified: false },
];

function readJson(file: string): any {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: we never overwrite a file we cannot read
}

// Writes through symlinks (Antigravity links its config files together) and keeps one backup of the original.
function writeConfig(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  if (fs.existsSync(real) && fs.statSync(real).size > 0 && !fs.existsSync(real + '.scrumbridge.bak') && !fs.existsSync(real + '.' + LEGACY_NAME + '.bak')) {
    fs.copyFileSync(real, real + '.scrumbridge.bak');
  }
  fs.writeFileSync(real, JSON.stringify(data, null, 2) + '\n');
}

function writeRules(t: Target): void {
  fs.mkdirSync(path.dirname(t.rulesFile), { recursive: true });
  if (t.rulesOwn) {
    fs.writeFileSync(t.rulesFile, (t.rulesHeader || '') + RULES + '\n');
    const legacy = path.join(path.dirname(t.rulesFile), LEGACY_NAME + path.extname(t.rulesFile));
    if (legacy !== t.rulesFile && fs.existsSync(legacy)) fs.rmSync(legacy);
    return;
  }
  const block = `${BLOCK_START}\n${RULES}\n${BLOCK_END}`;
  let old = fs.existsSync(t.rulesFile) ? fs.readFileSync(t.rulesFile, 'utf8') : '';
  const la = old.indexOf(LEGACY_START), lb = old.indexOf(LEGACY_END);
  if (la >= 0 && lb > la) {
    // the block of the old name becomes the block of the new one, in the same place
    const rest = old.slice(0, la) + old.slice(lb + LEGACY_END.length);
    old = rest.indexOf(BLOCK_START) >= 0 ? rest : old.slice(0, la) + BLOCK_START + '\n' + BLOCK_END + old.slice(lb + LEGACY_END.length);
  }
  const a = old.indexOf(BLOCK_START), b = old.indexOf(BLOCK_END);
  const next = a >= 0 && b > a
    ? old.slice(0, a) + block + old.slice(b + BLOCK_END.length)
    : (old.trim() ? old.replace(/\s*$/, '\n\n') : '') + block + '\n';
  fs.writeFileSync(t.rulesFile, next);
}

const rel = (p: string) => (p.startsWith(PROJECT_DIR) ? path.relative(PROJECT_DIR, p) : p.replace(home, '~')).replace(/\\/g, '/');

export function connectStatus(url: string) {
  return TARGETS.map(t => {
    let connected = false;
    try { connected = readJson(t.configFile)?.[t.rootKey]?.[NAME] !== undefined; } catch { /* unreadable config: not connected */ }
    return { id: t.id, label: t.label, connected, verified: t.verified, configFile: rel(t.configFile), rulesFile: rel(t.rulesFile) };
  });
}

export function connectIde(id: string, url: string): { ok: boolean; error?: string; files?: string[] } {
  const t = TARGETS.find(x => x.id === id);
  if (!t) return { ok: false, error: 'unknown IDE' };
  try {
    const cfg = readJson(t.configFile);
    const servers: Record<string, any> = { ...(cfg[t.rootKey] || {}) };
    const old = servers[LEGACY_NAME];
    const oldUrl = String(old?.url ?? old?.serverUrl ?? '');
    if (old !== undefined && /^https?:\/\/(127\.0\.0\.1|localhost)[:/].*\/mcp$/.test(oldUrl)) delete servers[LEGACY_NAME];
    cfg[t.rootKey] = { ...servers, [NAME]: t.entry(url) };
    writeConfig(t.configFile, cfg);
    writeRules(t);
    return { ok: true, files: [rel(t.configFile), rel(t.rulesFile)] };
  } catch (e) {
    return { ok: false, error: `${rel(t.configFile)}: ${(e as Error).message}` };
  }
}
