import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIR, PROJECT_ID, type TestCase, type Verification } from './state.js';
import { getApproval } from './config.js';

// Independent evidence: when the Product Owner has approved a test command for this project, the app itself runs it
// before a story may become "done" and reads the JUnit report. The command comes from the approval store in the
// user's config folder (not from the project, not from the agent), so an agent cannot change what is executed.

export const verifyTimeoutMs = () => Number(process.env.AIST_VERIFY_MS) || 55_000; // under the usual 60 s tool timeout

// null = fine, otherwise the reason
export function checkApproval(command: unknown, reportFile: unknown): string | null {
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\r\n]/.test(command)) return 'the command must be one line of 1-500 characters';
  if (reportFile !== '' && reportFile !== undefined) {
    if (typeof reportFile !== 'string' || reportFile.length > 200 || !resolveReport(reportFile)) return 'the report file must be a path inside the project folder';
  }
  return null;
}

export function resolveReport(rel: string): string | null {
  if (!rel) return null;
  const abs = path.resolve(PROJECT_DIR, rel);
  const inside = path.relative(PROJECT_DIR, abs);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? abs : null;
}

// The ID must stand alone: TC-S1-1 is not found in TC-S1-10.
const hasId = (name: string, id: string): boolean => new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(name);

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseJunit(xml: string): { name: string; outcome: 'pass' | 'fail' | 'skipped'; file: string; ms: number }[] {
  const out: { name: string; outcome: 'pass' | 'fail' | 'skipped'; file: string; ms: number }[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    if (name === undefined) continue;
    // node:test writes the file of the test in "file" (its "classname" is the same for every test); pytest has "classname" only
    const file = /\bfile="([^"]*)"/.exec(m[1])?.[1] ?? /\bclassname="([^"]*)"/.exec(m[1])?.[1] ?? '';
    const body = m[2] || '';
    const seconds = parseFloat(/\btime="([^"]*)"/.exec(m[1])?.[1] ?? '');
    out.push({ name: unxml(name), outcome: /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skipped' : 'pass', file: unxml(file), ms: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0 });
  }
  return out;
}

function run(command: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean; ms: number }> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, { shell: true, cwd: PROJECT_DIR, windowsHide: true, env: process.env, detached: process.platform !== 'win32' });
    let output = '';
    const take = (d: Buffer) => { output = (output + d.toString()).slice(-8000); };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ exitCode: null, output: output + '\n' + e.message, timedOut, ms: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut, ms: Date.now() - started }); });
  });
}

export interface VerifyOutcome { ok: boolean; verification: Verification; problems: string[] }

// null: nothing is approved for this project, the agent's own report is all there is.
export async function verifyStory(autoCases: TestCase[]): Promise<VerifyOutcome | null> {
  const ap = getApproval(PROJECT_ID);
  if (!ap) return null;
  const reportPath = resolveReport(ap.reportFile);
  if (reportPath) fs.rmSync(reportPath, { force: true }); // a stale report must never count
  const r = await run(ap.command, verifyTimeoutMs());
  const cases: Record<string, 'pass' | 'fail' | 'missing' | 'ambiguous'> = {};
  const problems: string[] = [];
  let reportUsed = false;
  const proof: Record<string, { name: string; file: string; ms: number; outcome: string }[]> = {}; // which tests proved each case
  if (r.timedOut) problems.push(`The test command did not finish within ${Math.round(verifyTimeoutMs() / 1000)} s and was stopped.`);
  if (reportPath) {
    if (fs.existsSync(reportPath)) {
      reportUsed = true;
      const tests = parseJunit(fs.readFileSync(reportPath, 'utf8'));
      for (const c of autoCases) {
        const mine = tests.filter(t => hasId(t.name, c.id));
        // the same ID in tests of different files means it is not clear what proves the case (an ID of an older plan?)
        const files = new Set(mine.map(t => t.file).filter(Boolean));
        cases[c.id] = !mine.length ? 'missing' : files.size > 1 ? 'ambiguous' : mine.every(t => t.outcome === 'pass') ? 'pass' : 'fail';
        if (mine.length) proof[c.id] = mine.slice(0, 5).map(t => ({ name: t.name.slice(0, 160), file: t.file.split(/[\\/]/).pop() || '', ms: t.ms, outcome: t.outcome }));
      }
      const failing = tests.filter(t => t.outcome === 'fail').map(t => t.name);
      const missing = autoCases.filter(c => cases[c.id] === 'missing').map(c => c.id);
      const bad = autoCases.filter(c => cases[c.id] === 'fail').map(c => c.id);
      if (missing.length) problems.push(`No passing test in the report for: ${missing.join(', ')} (the test name must contain the case ID).`);
      if (bad.length) problems.push(`Failing: ${bad.join(', ')}.`);
      for (const c of autoCases.filter(x => cases[x.id] === 'ambiguous')) {
        const where = [...new Set(tests.filter(t => hasId(t.name, c.id)).map(t => t.file.split(/[\\/]/).pop()))];
        problems.push(`The case ID ${c.id} is used by tests in several files (${where.join(', ')}): case IDs must be unique, so the report cannot show which test proves the case.`);
      }
      const others = failing.filter(n => !autoCases.some(c => hasId(n, c.id)));
      if (others.length) problems.push(`Other failing tests: ${others.slice(0, 5).join('; ')}.`);
    } else {
      for (const c of autoCases) cases[c.id] = 'missing';
      problems.push(`The command did not write the report ${ap.reportFile}.`);
    }
  } else if (r.exitCode !== 0 && !r.timedOut) problems.push(`The test command exited with code ${r.exitCode}.`);
  const verification: Verification = { by: 'server', command: ap.command, exitCode: r.exitCode, durationMs: r.ms, cases, tests: proof, reportUsed, ts: new Date().toISOString(), outputTail: r.output.slice(-1500) };
  return { ok: problems.length === 0, verification, problems };
}
