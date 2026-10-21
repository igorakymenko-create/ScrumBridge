import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_DIR, STATE_DIR } from './state.js';

// Context of an EXISTING project: a short summary the whole team plans against.
// PROJECT.md is the source of truth for the text; context.meta.json says who wrote it and for which commit.
export const CONTEXT_FILE = path.join(STATE_DIR, 'PROJECT.md');
const META_FILE = path.join(STATE_DIR, 'context.meta.json');
export const MAX_CONTEXT_CHARS = 8000; // ~2k tokens: it goes into every request of the team

export const CONTEXT_STRUCTURE = `# Project context

## Purpose
What the product does and for whom (2-3 sentences).

## Stack and tooling
Languages, frameworks, database, build / run / test / lint commands.

## Architecture
Modules or layers, how they interact, entry points, external services.

## Key modules and files
- path — responsibility (the 10-20 most important)

## Existing features
What already works, so the team does not plan it again.

## Conventions
Naming, folder layout, test style, error handling, anything a new contributor must follow.

## Constraints and fragile areas
Legacy parts, tech debt, things that must not be broken or touched.

## Backlog and docs
Where requirements, design and backlog live (files, links), if found.`;

export const ANALYZE_PROMPT = `Analyze the repository in the current folder and write a context summary for a team that will plan NEW work on top of it.

Rules:
- Strictly read-only: do not create, edit or delete any file, do not run builds or installs.
- Read the manifests, README, AGENTS.md / CLAUDE.md, docs, the folder structure and the main modules; do not read everything.
- Be concrete (real paths, real commands) and short: at most 800 words. Do not guess: write "unknown" for what you could not find.
- Finish by calling the MCP tool submit_project_context from the "scrumbridge" server with the Markdown summary in exactly this structure:

${CONTEXT_STRUCTURE}`;

export function gitCommit(): string | null {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; }
}

export interface ContextInfo { exists: boolean; text: string; source: string; commit: string | null; ts: string | null }

export function readContext(): ContextInfo {
  try {
    const text = fs.readFileSync(CONTEXT_FILE, 'utf8');
    let meta: any = {};
    try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { /* no meta yet */ }
    return { exists: true, text, source: meta.source || 'manual', commit: meta.commit ?? null, ts: meta.ts || fs.statSync(CONTEXT_FILE).mtime.toISOString() };
  } catch { return { exists: false, text: '', source: '', commit: null, ts: null }; }
}

export function writeContext(text: string, source: 'agent' | 'manual' | 'scan'): ContextInfo {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, text.trim() + '\n');
  fs.writeFileSync(META_FILE, JSON.stringify({ source, commit: gitCommit(), ts: new Date().toISOString() }, null, 2));
  return readContext();
}

// ---- quick scan: no agent, no model; collects raw material the PO can edit into a summary ----
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.ai-team', '.next', '.venv', 'venv', '__pycache__', 'bin', 'obj', 'target', '.idea', '.vs']);
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'Makefile', 'Dockerfile', 'docker-compose.yml'];

function readHead(file: string, max: number): string {
  try { const t = fs.readFileSync(file, 'utf8'); return t.length > max ? t.slice(0, max) + '\n…' : t; } catch { return ''; }
}

function tree(dir: string, depth: number, prefix: string, out: string[], budget: { n: number }): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.n <= 0) return;
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      out.push(`${prefix}${e.name}/`); budget.n--;
      if (depth > 1) tree(path.join(dir, e.name), depth - 1, prefix + '  ', out, budget);
    } else if (depth >= 1) { out.push(`${prefix}${e.name}`); budget.n--; }
  }
}

export function quickScan(): string {
  const L: string[] = ['# Project context (draft from a quick file scan — please check and complete)', ''];
  const found = MANIFESTS.filter(m => fs.existsSync(path.join(PROJECT_DIR, m)));
  L.push('## Stack and tooling', found.length ? `Manifests found: ${found.join(', ')}` : 'unknown (no known manifest in the root)');
  const pkg = path.join(PROJECT_DIR, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (j.scripts) L.push('Scripts: ' + Object.entries(j.scripts).map(([k, v]) => `${k} = ${v}`).join('; '));
      const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      if (deps.length) L.push('Dependencies: ' + deps.slice(0, 40).join(', ') + (deps.length > 40 ? ', …' : ''));
    } catch { /* invalid package.json */ }
  }
  L.push('');
  const readme = ['README.md', 'README', 'readme.md'].map(f => path.join(PROJECT_DIR, f)).find(f => fs.existsSync(f));
  L.push('## Purpose', readme ? readHead(readme, 1500).trim() : 'unknown (no README)', '');
  const t: string[] = [];
  tree(PROJECT_DIR, 2, '', t, { n: 80 });
  L.push('## Key modules and files', '```', ...t, '```', '');
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(PROJECT_DIR, f);
    if (fs.existsSync(p)) L.push(`## Conventions (from ${f})`, readHead(p, 1500).trim(), '');
  }
  const docs = ['docs', 'doc', 'design', 'adr'].filter(d => fs.existsSync(path.join(PROJECT_DIR, d)));
  L.push('## Backlog and docs', docs.length ? 'Folders: ' + docs.join(', ') : 'unknown', '');
  L.push('## Existing features', 'unknown — fill in', '', '## Architecture', 'unknown — fill in', '', '## Constraints and fragile areas', 'unknown — fill in');
  return L.join('\n');
}

// ---- facts about the repository for the planning prompts (read-only snapshot) ----
// The team plans an increment of an EXISTING project. Names of fields, test files and scripts must come from the code,
// not from the imagination of a model: this text is added to the prompts of the plan, the test design and the plan check.
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const FACTS_BUDGET = 12000; // characters of source beginnings in total (~3k tokens)

interface FileInfo { rel: string; size: number; isTest: boolean }

function walk(dir: string, rel: string, depth: number, out: FileInfo[], inTest: boolean): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink() || SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth > 0) walk(path.join(dir, e.name), r, depth - 1, out, inTest || TEST_DIRS.has(e.name)); continue; }
    let size = 0;
    try { size = fs.statSync(path.join(dir, e.name)).size; } catch { continue; }
    out.push({ rel: r, size, isTest: inTest || /\.(test|spec)\.[a-z]+$/i.test(e.name) });
  }
}

export interface Facts { tests: string[]; sources: { path: string; head: string }[]; scripts: Record<string, string>; text: string }

export function projectFacts(): Facts {
  const files: FileInfo[] = [];
  walk(PROJECT_DIR, '', 3, files, false);
  const tests = files.filter(f => f.isTest).map(f => f.rel).sort();
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
  // source files, shallow and small ones first: they say the most per character
  const candidates = files.filter(f => !f.isTest && SRC_EXT.has(path.extname(f.rel).toLowerCase()) && f.size > 0 && f.size < 60000)
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.size - b.size);
  const sources: { path: string; head: string }[] = [];
  let used = 0;
  for (const f of candidates) {
    if (used >= FACTS_BUDGET || sources.length >= 8) break;
    let body = '';
    try { body = fs.readFileSync(path.join(PROJECT_DIR, f.rel), 'utf8'); } catch { continue; }
    const head = body.split('\n').slice(0, 160).join('\n').slice(0, Math.min(6000, FACTS_BUDGET - used));
    sources.push({ path: f.rel, head }); used += head.length;
  }
  const L = ['FACTS FROM THE REPOSITORY (a read-only snapshot of the real code; the plan must agree with it, and where it does not, the code is right):'];
  L.push(`Existing test files (new tests must go to NEW file names; never overwrite these): ${tests.join(', ') || 'none'}`);
  if (Object.keys(scripts).length) L.push(`npm scripts: ${Object.entries(scripts).map(([k, v]) => `${k} = ${v}`).join('; ')}`);
  for (const s of sources) L.push(`--- ${s.path}`, s.head);
  return { tests, sources, scripts, text: L.join('\n') };
}

// ---- the code of an automated test, found by its case ID ----
// The Product Owner can see what the agent wrote for a case, instead of taking "automated" on trust. The file is not
// taken from the report of the agent: the project is searched for the ID, so a wrong or invented path shows nothing.
export interface TestCodeMatch { file: string; line: number; code: string }

function extractBlock(lines: string[], idx: number): { start: number; end: number } {
  const indent = (l: string) => (/^\s*/.exec(l) as RegExpExecArray)[0].length;
  const base = indent(lines[idx]);
  let end = idx;
  for (let i = idx + 1; i < Math.min(lines.length, idx + 80); i++) {
    const l = lines[i];
    if (!l.trim()) { end = i; continue; }
    if (indent(l) <= base) { if (/^\s*[})\]]/.test(l)) end = i; break; } // the closing line of the block belongs to it
    end = i;
  }
  while (end > idx && !lines[end].trim()) end--;
  return { start: idx, end };
}

export function findTestCode(id: string): TestCodeMatch[] {
  if (!/^TC-[A-Za-z0-9-]+$/.test(id)) return [];
  const re = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])');
  const files: FileInfo[] = [];
  walk(PROJECT_DIR, '', 4, files, false);
  const out: TestCodeMatch[] = [];
  for (const f of files.filter(x => x.isTest && x.size < 300000)) {
    let body = '';
    try { body = fs.readFileSync(path.join(PROJECT_DIR, f.rel), 'utf8'); } catch { continue; }
    if (!re.test(body)) continue;
    const lines = body.split('\n');
    const i = lines.findIndex(l => re.test(l));
    const { start, end } = extractBlock(lines, i);
    out.push({ file: f.rel, line: start + 1, code: lines.slice(start, end + 1).join('\n').slice(0, 4000) });
    if (out.length >= 3) break;
  }
  return out;
}
