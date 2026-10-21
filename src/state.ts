import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The project the team works on: the folder where the app is started (or --dir <path>).
const dirArg = process.argv.indexOf('--dir');
export const PROJECT_DIR = path.resolve(dirArg > 0 ? process.argv[dirArg + 1] : process.cwd());
export const STATE_DIR = path.join(PROJECT_DIR, '.ai-team');
// A chat tab remembers which project it was opened for; writes from a tab of another project are refused.
export const PROJECT_ID = crypto.createHash('sha256').update(PROJECT_DIR.toLowerCase()).digest('hex').slice(0, 12);
export const SESSION_FILE = path.join(STATE_DIR, 'session.json');
export const SPEC_FILE = path.join(STATE_DIR, 'SPEC.md');
const PROGRESS_FILE = path.join(STATE_DIR, 'progress.json');

export const STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
export type Status = (typeof STATUSES)[number];

export type CaseStatus = 'pass' | 'fail' | 'skipped';
export interface CaseResult { status: CaseStatus; file?: string; notes?: string; ts: string }
export interface StoryProgress {
  status: Status; notes: { ts: string; text: string }[]; testsPassed: boolean | null; updatedAt: string;
  rework?: string[];                        // instructions of the Product Owner after a rejected assumption
  testResults?: Record<string, CaseResult>; // reported by the agent, per test case id
  verification?: Verification;              // result of the run done by the server itself (see verify.ts)
}
export interface Verification { by: 'server'; command: string; exitCode: number | null; durationMs: number; cases: Record<string, 'pass' | 'fail' | 'missing' | 'ambiguous'>; tests?: Record<string, { name: string; file: string; ms: number; outcome: string }[]>; reportUsed: boolean; ts: string; outputTail: string }

// The test plan the QA agent of the team makes for the stories of the plan (see the chat).
export interface TestCase { id: string; story: string; criterion: number; level: string; type: string; title: string; given: string; when: string; then: string; manualReason?: string }
export interface TestPlan {
  strategy: { summary?: string; framework?: string; runCommand?: string; reportFile?: string; namingRule?: string; levels?: { level: string; why: string }[] };
  cases: TestCase[]; gates?: string[]; uncovered?: { story: string; criterion: number }[];
}
export const testPlanOf = (session: any): TestPlan | null => session?.plan?.testPlan?.cases ? session.plan.testPlan : null;
export const casesFor = (session: any, storyId: string): TestCase[] => (testPlanOf(session)?.cases || []).filter(c => c.story === storyId);
export const isAutomated = (c: TestCase) => c.level !== 'manual';
export interface AgentQuestion {
  id: string; storyId?: string; topic?: string; question: string;
  options: { id: string; label: string; recommended: boolean }[];
  recommendation: string; status: 'open' | 'answered'; askedAt: string;
  answer?: { optionId?: string; text: string; delegated: boolean; decisionId?: string; ts: string; readAt?: string };
}
export interface Blocker { id: string; storyId: string; reason: string; questionId: string; status: 'open' | 'resolved'; ts: string; prevStatus?: Status }
// A decision the agent took on its own for a small detail. The Product Owner reviews it later: confirming makes it a
// decision of the log, rejecting sends the story back with the Product Owner's instruction.
export interface Assumption { id: string; storyId?: string; text: string; why: string; status: 'open' | 'confirmed' | 'rejected'; ts: string; note?: string; decisionId?: string }
export interface Progress { stories: Record<string, StoryProgress>; questions: AgentQuestion[]; blockers: Blocker[]; assumptions: Assumption[] }
export const emptyProgress = (): Progress => ({ stories: {}, questions: [], blockers: [], assumptions: [] });

// The chat owns session.json and the server owns progress.json: nobody overwrites the other's data.
function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readSession(): any {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
}
export function writeSession(session: unknown): void { writeJson(SESSION_FILE, session); }

export function readProgress(): Progress {
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return { stories: p.stories || {}, questions: p.questions || [], blockers: p.blockers || [], assumptions: p.assumptions || [] };
  } catch { return emptyProgress(); }
}
export function writeProgress(p: Progress): void { writeJson(PROGRESS_FILE, p); }

export interface Story {
  id: string; title: string; description?: string; owner?: string; estimate?: number;
  acceptance: string[]; dependsOn: string[]; sprint?: string; status: Status; rework?: string[];
}

// All stories in execution order: by sprint, then by position in the sprint; stories outside any sprint go last.
export function loadStories(session: any, progress: Progress): Story[] {
  const plan = session?.plan;
  if (!plan) return [];
  const byId = new Map<string, any>();
  for (const e of plan.epics || []) for (const s of e.stories || []) byId.set(s.id, s);
  const order: { id: string; sprint?: string }[] = [];
  for (const sp of plan.sprints || []) for (const id of sp.stories || []) if (byId.has(id)) order.push({ id, sprint: sp.name });
  for (const id of byId.keys()) if (!order.some(o => o.id === id)) order.push({ id });
  return order.map(({ id, sprint }) => {
    const s = byId.get(id);
    return {
      id, title: String(s.title || ''), description: s.description, owner: s.owner, estimate: s.estimate,
      acceptance: (s.acceptance || []).map(String), dependsOn: (s.dependsOn || []).map(String), sprint,
      status: progress.stories[id]?.status ?? 'todo', rework: progress.stories[id]?.rework,
    };
  });
}
