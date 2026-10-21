import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR, STATE_DIR, readSession, readProgress, loadStories } from './state.js';
import { LOOP_PROMPT } from './mcp.js';
import { ANALYZE_PROMPT, readContext } from './context.js';

// Autopilot: the app starts a command-line agent itself and restarts it while there is work it can do.
// Each run is a fresh agent process; everything it needs comes from the MCP server (plan, decisions, answers).

export type AutopilotState = 'idle' | 'running' | 'waiting_po' | 'completed' | 'stalled' | 'stopped' | 'error';
interface LogEntry { ts: string; kind: 'text' | 'tool' | 'sys' | 'error'; text: string }
type Mode = 'implement' | 'analyze';
interface Adapter {
  id: string; label: string;
  resolve(): string | null;                         // executable, or null if the CLI is not installed
  args(mcpConfigFile: string, mode: Mode): string[];
  parseLine(line: string): LogEntry[];
}

const MAX_RUNS = 30;                 // restarts per autopilot session
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

function findOnPath(names: string[]): string | null {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (dir && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
  }
  return null;
}

// On Windows the npm launcher is claude.cmd, which cannot be spawned without a shell: use the exe it points to.
function resolveClaude(): string | null {
  if (process.platform !== 'win32') return findOnPath(['claude']);
  const exe = findOnPath(['claude.exe']);
  if (exe) return exe;
  const cmd = findOnPath(['claude.cmd']);
  if (!cmd) return null;
  const m = fs.readFileSync(cmd, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i);
  const target = m ? path.join(path.dirname(cmd), m[1]) : null;
  return target && fs.existsSync(target) ? target : null;
}

const short = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

const claude: Adapter = {
  id: 'claude-code', label: 'Claude Code',
  resolve: resolveClaude,
  // Headless run. Everything not on the allow-list is denied (there is nobody to confirm a prompt), so the agent
  // can edit files, use the plan tools and run the usual build/test tools, but not arbitrary commands.
  args: (mcpConfigFile, mode) => [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', mode === 'analyze' ? 'default' : 'acceptEdits',
    '--mcp-config', mcpConfigFile, '--strict-mcp-config',
    // analysis is strictly read-only: no Edit / Write / build tools
    '--allowedTools', ...(mode === 'analyze'
      ? ['mcp__scrumbridge__submit_project_context', 'Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(dir:*)']
      : ['mcp__scrumbridge__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(ls:*)', 'Bash(dir:*)']),
  ],
  parseLine(line) {
    let j: any;
    try { j = JSON.parse(line); } catch { return []; }
    const out: LogEntry[] = [];
    const ts = new Date().toISOString();
    if (j.type === 'assistant') {
      for (const c of j.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) out.push({ ts, kind: 'text', text: short(c.text.trim()) });
        else if (c.type === 'tool_use') {
          const detail = c.input?.file_path || c.input?.command || c.input?.id || c.input?.question || '';
          out.push({ ts, kind: 'tool', text: `${String(c.name).replace('mcp__scrumbridge__', '')}${detail ? ' ' + short(String(detail), 120) : ''}` });
        }
      }
    } else if (j.type === 'result' && j.is_error) {
      out.push({ ts, kind: 'error', text: short(String(j.result || j.subtype || 'error')) });
    }
    return out;
  },
};

export const ADAPTERS: Record<string, Adapter> = { [claude.id]: claude };

class Autopilot {
  state: AutopilotState = 'idle';
  agent = '';
  mode: Mode = 'implement';
  private startedAt = 0;
  runs = 0;
  message = '';
  log: LogEntry[] = [];
  private child: ChildProcess | null = null;
  private stopRequested = false;
  private timer: NodeJS.Timeout | null = null;

  private add(kind: LogEntry['kind'], text: string) {
    this.log.push({ ts: new Date().toISOString(), kind, text });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  snapshot() {
    return {
      state: this.state, mode: this.mode, agent: this.agent, runs: this.runs, message: this.message, log: this.log.slice(-60),
      agents: Object.values(ADAPTERS).map(a => ({ id: a.id, label: a.label, available: !!a.resolve() })),
    };
  }

  private fingerprint(): string {
    const p = readProgress();
    return JSON.stringify([Object.entries(p.stories).map(([id, s]) => [id, s.status]), p.questions.map(q => [q.id, q.status])]);
  }

  // Is there a story an agent could start right now?
  private hasWork(): 'work' | 'done' | 'waiting' {
    const all = loadStories(readSession(), readProgress());
    if (!all.length || all.every(s => s.status === 'done')) return 'done';
    const ok = all.some(s => s.status === 'in_progress' || (s.status === 'todo' && s.dependsOn.every(d => all.find(x => x.id === d)?.status === 'done')));
    return ok ? 'work' : 'waiting';
  }

  start(agentId: string, mode: Mode = 'implement'): { ok: boolean; error?: string } {
    if (this.state === 'running') return { ok: false, error: 'already running' };
    const adapter = ADAPTERS[agentId];
    if (!adapter) return { ok: false, error: 'unknown agent' };
    if (!adapter.resolve()) return { ok: false, error: `${adapter.label} is not installed (command not found)` };
    if (mode === 'implement' && !readSession()?.plan) return { ok: false, error: 'there is no plan yet' };
    this.mode = mode; this.agent = agentId; this.runs = 0; this.stopRequested = false; this.message = ''; this.log = [];
    this.add('sys', `${mode === 'analyze' ? 'Project analysis' : 'Autopilot'} started with ${adapter.label} in ${PROJECT_DIR}`);
    this.run();
    return { ok: true };
  }

  stop() {
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child?.pid) this.kill(this.child);
    else if (this.state === 'waiting_po') { this.state = 'stopped'; this.add('sys', 'Autopilot stopped'); }
  }

  // The PO answered something in the chat: continue if the autopilot was waiting for it.
  onAnswer() {
    if (this.state === 'waiting_po' && !this.stopRequested) {
      this.add('sys', 'The Product Owner answered; resuming');
      this.run();
    }
  }

  private kill(c: ChildProcess) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }

  private run() {
    const adapter = ADAPTERS[this.agent];
    const exe = adapter.resolve();
    if (!exe) { this.fail('command not found'); return; }
    this.runs++;
    this.startedAt = Date.now();
    this.state = 'running';
    const before = this.fingerprint();
    // The agent gets its own MCP config, so no per-project trust prompt can block a headless run.
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const mcpFile = path.join(STATE_DIR, 'autopilot-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'scrumbridge': { type: 'http', url: `http://127.0.0.1:${process.env.PORT || 4700}/mcp` } } }, null, 2));
    this.add('sys', `Run ${this.runs}`);
    const child = spawn(exe, adapter.args(mcpFile, this.mode), { cwd: PROJECT_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdin.end(this.mode === 'analyze' ? ANALYZE_PROMPT : LOOP_PROMPT);
    let buf = '', errBuf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) for (const e of adapter.parseLine(line)) this.log.push(e);
      }
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    });
    child.stderr.on('data', d => { errBuf = (errBuf + d.toString()).slice(-2000); });
    this.timer = setTimeout(() => { this.add('error', 'Run timed out'); this.kill(child); }, RUN_TIMEOUT_MS);
    child.on('error', e => { this.child = null; this.fail(e.message); });
    child.on('exit', code => {
      if (this.timer) clearTimeout(this.timer);
      this.child = null;
      if (code !== 0 && errBuf.trim()) this.add('error', short(errBuf.trim()));
      this.afterRun(before, code);
    });
  }

  private afterRun(before: string, code: number | null) {
    if (this.stopRequested) { this.state = 'stopped'; this.add('sys', 'Autopilot stopped'); return; }
    if (this.mode === 'analyze') {
      const c = readContext();
      if (c.exists && c.ts && Date.parse(c.ts) >= this.startedAt - 1000) { this.state = 'completed'; this.message = 'Project context is ready for review'; this.add('sys', this.message); }
      else { this.state = 'stalled'; this.message = `The agent finished without saving a summary (exit code ${code}). See the log.`; this.add('error', this.message); }
      return;
    }
    const work = this.hasWork();
    if (work === 'done') { this.state = 'completed'; this.message = 'All stories are done'; this.add('sys', this.message); return; }
    if (this.fingerprint() === before) {
      this.state = 'stalled';
      this.message = `The agent finished without progress (exit code ${code}). See the log; fix the cause and start again.`;
      this.add('error', this.message); return;
    }
    if (work === 'waiting') {
      this.state = 'waiting_po'; this.message = 'Waiting for your answer in the chat';
      this.add('sys', this.message); return;
    }
    if (this.runs >= MAX_RUNS) { this.state = 'stalled'; this.message = `Stopped after ${MAX_RUNS} runs`; this.add('error', this.message); return; }
    this.run();
  }

  private fail(msg: string) {
    this.state = 'error'; this.message = msg; this.add('error', msg);
  }
}

export const autopilot = new Autopilot();
