import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { verifyStory } from './verify.js';
import { waitMs } from './config.js';
import { ANALYZE_PROMPT, MAX_CONTEXT_CHARS, readContext, writeContext } from './context.js';
import {
  STATUSES, SPEC_FILE, readSession, readProgress, writeProgress, loadStories,
  testPlanOf, casesFor, isAutomated, type Progress, type Story, type AgentQuestion, type TestCase, type CaseResult,
} from './state.js';

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });
const now = () => new Date().toISOString();

const RULES = `Rules:
- The decisions below are binding. If one gets in the way or looks wrong, do NOT change it: call report_blocker.
- Take only what is described here; if something is unclear and not covered by the decisions, call ask_po (do not guess).
- Set the status with update_story: in_progress when you start, done only when every acceptance criterion is implemented and verified by tests that pass.`;

function decisionsText(session: any): string {
  const ds: any[] = session?.decisions || [];
  if (!ds.length) return '_No decisions._';
  return ds.map(d => `- ${d.id}: ${d.text}${d.rationale ? ' — ' + d.rationale : ''}`).join('\n');
}

function techText(session: any): string {
  const t = session?.plan?.tech;
  if (!t) return '';
  const L: string[] = [];
  if (t.stack?.length) L.push('Stack:', ...t.stack.map((x: string) => `- ${x}`), '');
  if (t.architecture) L.push('Architecture:', t.architecture, '');
  if (t.components?.length) L.push('Components:', ...t.components.map((c: any) => `- ${c.name}${c.responsibility ? ' — ' + c.responsibility : ''}`), '');
  if (t.dataModel) L.push('Data model:', t.dataModel, '');
  if (t.interfaces) L.push('Interfaces and contracts:', t.interfaces, '');
  if (t.conventions?.length) L.push('Conventions:', ...t.conventions.map((x: string) => `- ${x}`), '');
  if (t.outOfScope?.length) L.push('Out of scope:', ...t.outOfScope.map((x: string) => `- ${x}`), '');
  return L.join('\n').trim();
}

// The test plan QA made for this story, as an instruction the implementing agent must follow.
function testPlanText(s: Story, session: any): string {
  const tp = testPlanOf(session);
  if (!tp) return '';
  const cases = casesFor(session, s.id);
  const auto = cases.filter(isAutomated), manual = cases.filter(c => !isAutomated(c));
  const line = (c: TestCase) => `- ${c.id} [${c.level}, ${c.type}] ${c.title} — Given ${c.given}; When ${c.when}; Then ${c.then}`;
  const st = tp.strategy || {};
  const L = ['## Test plan (made by QA — follow it)'];
  if (st.framework) L.push(`Framework: ${st.framework}`);
  if (st.runCommand) L.push(`Run all automated tests with: \`${st.runCommand}\``);
  if (st.namingRule) L.push(`Naming rule: ${st.namingRule}`);
  L.push('');
  if (auto.length) L.push('Automated cases — implement EACH as a test whose name starts with its case ID:', ...auto.map(line), '');
  else L.push('QA defined no automated cases for this story: write automated tests for each acceptance criterion and use the ID format of the other stories.', '');
  if (manual.length) L.push('Manual cases — the Product Owner checks these, do NOT automate them:', ...manual.map(c => line(c) + (c.manualReason ? ` (manual because: ${c.manualReason})` : '')), '');
  if (tp.gates?.length) L.push('Quality gates (binding; if one is unclear or cannot be met, call ask_po — never reinterpret it yourself):', ...tp.gates.map(g => `- ${g}`), '');
  if (auto.length) L.push('When the story is finished run the tests, then call update_story(status="done", testResults=[{id, status: "pass"|"fail", file}]) with EVERY automated case. "done" is refused while a case is missing or failing.');
  return L.join('\n');
}

// Instructions the specialists of the team wrote for the developer agent (kept word for word in session.roleBriefs).
// The owner's own list always goes with the story. ux/security/architect/data/ba advise whoever implements; devops and
// techwriter deliverables belong only to their own stories (otherwise every story would be told to write the README).
const IMPLEMENTERS = ['frontend', 'backend', 'fullstack', 'mobile'];
const ADVISORY = ['architect', 'ux', 'security', 'data', 'ba'];
function briefsText(s: Story, session: any): string {
  const briefs = session?.roleBriefs;
  if (!briefs || typeof briefs !== 'object') return '';
  const owner = String(s.owner ?? '').toLowerCase();
  const roles = [owner, ...(!owner || IMPLEMENTERS.includes(owner) ? ADVISORY : [])];
  const L: string[] = [];
  for (const r of [...new Set(roles)]) {
    const items: any[] = Array.isArray(briefs[r]?.items) ? briefs[r].items : [];
    if (!items.length) continue;
    L.push(`From ${r}${r === owner ? ' (your own area — deliver every item)' : ' (follow where it touches this story)'}:`, ...items.map(i => `- ${i.text}`));
  }
  return L.length ? ['## Instructions of the team specialists (binding)', ...L].join('\n') : '';
}

function storyText(s: Story, session: any, all: Story[]): string {
  const deps = s.dependsOn.map(id => `${id} (${all.find(x => x.id === id)?.status ?? '?'})`);
  const L = [
    `# ${s.id}. ${s.title}`,
    `Owner: ${s.owner ?? '-'} · Estimate: ${s.estimate ?? '?'} SP · Sprint: ${s.sprint ?? '-'} · Status: ${s.status}`,
    `Depends on: ${deps.length ? deps.join(', ') : 'nothing'}`, '',
  ];
  if (s.rework?.length) L.push('## Rework required — instruction of the Product Owner (binding, do this first)', ...s.rework.map(r => `- ${r}`), '');
  if (s.description) L.push('## Description', s.description, '');
  if (s.acceptance.length) L.push('## Acceptance criteria', ...s.acceptance.map(a => `- [ ] ${a}`), '');
  const tp = testPlanText(s, session);
  if (tp) L.push(tp, '');
  const rb = briefsText(s, session);
  if (rb) L.push(rb, '');
  const tech = techText(session);
  if (tech) L.push('## Technical brief', tech, '');
  L.push('## Binding decisions', decisionsText(session), '');
  const dod: string[] = session?.plan?.definitionOfDone || [];
  if (dod.length) L.push('## Definition of Done', ...dod.map(d => `- ${d}`), '');
  L.push(RULES);
  return L.join('\n');
}

function ready(s: Story, all: Story[]): boolean {
  return s.dependsOn.every(id => all.find(x => x.id === id)?.status === 'done');
}

function nextQuestionId(p: Progress): string { return 'AQ-' + (p.questions.length + 1); }

function createQuestion(p: Progress, input: { question: string; topic?: string; options?: { label: string; recommended?: boolean }[]; recommendation?: string; storyId?: string }): AgentQuestion {
  let opts = (input.options || []).slice(0, 6).map((o, i) => ({ id: 'ABCDEF'[i], label: o.label, recommended: !!o.recommended }));
  if (opts.length && opts.filter(o => o.recommended).length !== 1) { opts.forEach(o => (o.recommended = false)); opts[0].recommended = true; }
  if (!opts.length) opts = [{ id: 'A', label: 'Yes', recommended: true }, { id: 'B', label: 'No', recommended: false }];
  const q: AgentQuestion = {
    id: nextQuestionId(p), storyId: input.storyId, topic: input.topic, question: input.question, options: opts,
    recommendation: input.recommendation || '', status: 'open', askedAt: now(),
  };
  p.questions.push(q);
  return q;
}

// Called when the Product Owner answers an agent's question in the chat.
export function answerAgentQuestion(id: string, ans: { optionId?: string; text: string; delegated?: boolean; decisionId?: string }): boolean {
  const p = readProgress();
  const q = p.questions.find(x => x.id === id);
  if (!q) return false;
  if (q.status === 'open') {
    q.status = 'answered';
    q.answer = { optionId: ans.optionId, text: ans.text, delegated: !!ans.delegated, decisionId: ans.decisionId, ts: now() };
    for (const b of p.blockers) {
      if (b.questionId === id && b.status === 'open') {
        b.status = 'resolved';
        const sp = p.stories[b.storyId];
        if (sp && sp.status === 'blocked') { sp.status = b.prevStatus === 'in_progress' ? 'in_progress' : 'todo'; sp.updatedAt = now(); }
      }
    }
    writeProgress(p);
  }
  return true;
}

export const LOOP_PROMPT = `Work as the developer of the ScrumBridge plan using the "scrumbridge" MCP tools.

Loop:
1. Call get_next_story. It returns a story with acceptance criteria, the technical brief and the binding decisions.
2. Call update_story(status="in_progress"), implement the story and follow its test plan: write every automated test case of the plan (the test name starts with the case ID), use the framework and the run command it names, and run the tests. Manual cases are for the Product Owner; do not automate them.
3. If the tests pass, call update_story(status="done", testResults=[{id, status, file}, ...]) with EVERY automated case; "done" is refused while a case is missing or failing, and the app may run the approved test command itself to confirm the result. If a story has no test plan, report testsPassed=true instead. If a binding decision prevents the work, call report_blocker instead; never change a decision yourself.
4. If a requirement conflicts with the existing code or the decisions (for example a field or a behavior that the code does differently), or is ambiguous about what the user sees or what a command returns, call ask_po BEFORE you choose. It waits for the answer: do not continue with work that depends on it, and never choose for the Product Owner. If no answer arrives, stop and tell the human that you are waiting; continue when they say they answered. Only a small detail that changes nothing the story promises may be recorded with record_assumption and carried on; never leave open choices for the final message. If a story comes back with a "Rework required" section, do that first.
5. Repeat until get_next_story says everything is done, or no story can be started. Then summarize what is done and what waits for the Product Owner.`;

const PROGRESS_MS = Number(process.env.AIST_PROGRESS_MS) || 15_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// While the call waits, a progress notification is sent from time to time: MCP clients that reset their timeout on
// progress then keep waiting instead of giving up after about a minute.
function progressTicker(extra: any): ((elapsed: number, total: number) => void) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== 'function') return undefined;
  return (elapsed, total) => {
    Promise.resolve(extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(elapsed / 1000), total: Math.round(total / 1000), message: 'Waiting for the Product Owner to answer in the chat' } })).catch(() => {});
  };
}

// Waits until the question is answered, the time is up, or the client gave up on the call.
async function waitForAnswer(id: string, ms: number, signal?: AbortSignal, tick?: (elapsed: number, total: number) => void): Promise<AgentQuestion | undefined> {
  const started = Date.now(), end = started + ms;
  let lastTick = started;
  for (;;) {
    const q = readProgress().questions.find(x => x.id === id);
    if (!q || q.status === 'answered' || Date.now() >= end || signal?.aborted) return q;
    if (tick && Date.now() - lastTick >= PROGRESS_MS) { lastTick = Date.now(); tick(lastTick - started, ms); }
    await sleep(1000);
  }
}

// The answer as the agent should read it. Reading is recorded, so the chat can show that the agent has it.
function answered(q: AgentQuestion | undefined) {
  if (!q || q.status !== 'answered' || !q.answer) return null;
  const a = q.answer;
  if (!a.readAt) { const p = readProgress(); const pq = p.questions.find(x => x.id === q.id); if (pq?.answer) { pq.answer.readAt = now(); writeProgress(p); } }
  return text(`${q.id} is answered by the Product Owner: ${a.text}${a.delegated ? ' (the recommendation of the team was accepted)' : ''}${a.decisionId ? `. Recorded as decision ${a.decisionId}; it is binding now.` : ''} You may continue.`);
}

const pendingText = (id: string) => `${id} is NOT answered yet (the app waited ${Math.round(waitMs() / 60000 * 10) / 10} min). Do not continue with work that depends on it and do not decide for the Product Owner. Stop here and tell the human: "I am waiting for your answer to ${id} in the ScrumBridge chat. Tell me when you have answered and I will continue." After they say so, call get_answer("${id}").`;

// Called when the Product Owner reviews an assumption of the agent in the chat.
export function resolveAssumption(id: string, action: 'confirm' | 'reject', note: string, decisionId?: string): boolean {
  const p = readProgress();
  const a = p.assumptions.find(x => x.id === id);
  if (!a) return false;
  if (a.status !== 'open') return true;
  a.status = action === 'confirm' ? 'confirmed' : 'rejected';
  a.note = note || undefined; a.decisionId = decisionId;
  if (action === 'reject' && a.storyId) {
    // the story goes back to the agent with the instruction of the Product Owner
    const sp = p.stories[a.storyId] || { status: 'todo' as const, notes: [], testsPassed: null, updatedAt: now() };
    sp.rework = [...(sp.rework || []), `Assumption ${a.id} was rejected ("${a.text}"). The Product Owner says: ${note}`];
    if (sp.status === 'done') { sp.status = 'todo'; sp.testsPassed = null; }
    sp.updatedAt = now();
    p.stories[a.storyId] = sp;
  }
  writeProgress(p);
  return true;
}

const storyId = z.string().describe('Story id, e.g. "S-1"');

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'scrumbridge', version: '0.3.0' });

  server.registerTool('ping', { description: 'Connectivity check: returns "pong".' }, async () => text('pong'));

  server.registerTool('get_next_story', {
    description: 'Returns the next story to implement (a story already in progress first, otherwise the first "todo" story whose dependencies are done), with acceptance criteria, technical brief, binding decisions and Definition of Done. Call it again after finishing each story.',
  }, async () => {
    const session = readSession();
    if (!session?.plan) return text('No plan yet. The team has not finished planning in the chat; ask the human to complete the discussion.', true);
    const all = loadStories(session, readProgress());
    const pick = all.find(s => s.status === 'in_progress') || all.find(s => s.status === 'todo' && ready(s, all));
    if (pick) return text(storyText(pick, session, all));
    if (all.every(s => s.status === 'done')) return text('All stories are done. Report completion to the human.');
    const waiting = all.filter(s => s.status !== 'done').map(s => `${s.id} (${s.status}${s.status === 'todo' ? ', waiting for ' + s.dependsOn.filter(d => all.find(x => x.id === d)?.status !== 'done').join(', ') : ''})`);
    return text(`No story can be started now. Remaining: ${waiting.join('; ')}. Blocked stories wait for the Product Owner: check open questions with get_status and tell the human what is pending.`);
  });

  server.registerTool('get_story', { description: 'Returns one story with its full context.', inputSchema: { id: storyId } }, async ({ id }) => {
    const session = readSession();
    const all = loadStories(session, readProgress());
    const s = all.find(x => x.id === id);
    return s ? text(storyText(s, session, all)) : text(`No story ${id}. Known: ${all.map(x => x.id).join(', ') || 'none'}.`, true);
  });

  server.registerTool('get_decisions', { description: 'Returns the log of decisions approved by the Product Owner and the team. They are binding.' }, async () => {
    const session = readSession();
    return session ? text(decisionsText(session)) : text('No session yet.', true);
  });

  server.registerTool('get_spec', { description: 'Returns the full hand-off document (task, team, decisions, technical brief, plan, risks, Definition of Done).' }, async () => {
    try { return text(fs.readFileSync(SPEC_FILE, 'utf8')); } catch { return text('SPEC.md does not exist yet: the plan is not ready.', true); }
  });

  server.registerTool('get_status', { description: 'Returns progress per story, open questions to the Product Owner and open blockers.' }, async () => {
    const session = readSession();
    const p = readProgress();
    const all = loadStories(session, p);
    const L = ['Stories:', ...all.map(s => `- ${s.id} ${s.title}: ${s.status}${p.stories[s.id]?.testsPassed === false ? ' (tests failing)' : ''}`)];
    const open = p.questions.filter(q => q.status === 'open');
    L.push('', open.length ? 'Open questions to the Product Owner:' : 'No open questions.', ...open.map(q => `- ${q.id}${q.storyId ? ' [' + q.storyId + ']' : ''}: ${q.question}`));
    const as = p.assumptions.filter(a => a.status === 'open');
    if (as.length) L.push('', `Assumptions waiting for the Product Owner: ${as.map(a => a.id).join(', ')}.`);
    return text(L.join('\n'));
  });

  server.registerTool('update_story', {
    description: 'Sets the status of a story and optionally leaves a note and the test results. Use "in_progress" when starting. "done" is allowed only when every automated test case of the story (see its test plan) is reported as passing in testResults.',
    inputSchema: {
      id: storyId,
      status: z.enum(STATUSES),
      notes: z.string().optional().describe('What was done, files touched, anything the human should know'),
      testsPassed: z.boolean().optional().describe('Overall result of the tests, for stories that have no test plan'),
      testResults: z.array(z.object({
        id: z.string().describe('Test case ID from the test plan, e.g. "TC-S1-1"'),
        status: z.enum(['pass', 'fail', 'skipped']),
        file: z.string().optional().describe('File with the test'),
        notes: z.string().optional(),
      })).optional().describe('Result per test case ID of the test plan'),
    },
  }, async ({ id, status, notes, testsPassed, testResults }) => {
    const session = readSession();
    const p = readProgress();
    const all = loadStories(session, p);
    if (!all.some(s => s.id === id)) return text(`No story ${id}. Known: ${all.map(x => x.id).join(', ') || 'none'}.`, true);
    if (status === 'done' && testsPassed === false) return text('A story with failing tests cannot be done. Fix the tests or use "blocked" with report_blocker.', true);
    const cases = casesFor(session, id);
    const auto = cases.filter(isAutomated);
    const unknown = (testResults || []).filter(r => !cases.some(c => c.id === r.id));
    if (unknown.length) return text(`Unknown test case IDs for ${id}: ${unknown.map(r => r.id).join(', ')}. The cases of this story: ${cases.map(c => c.id).join(', ') || 'none'}.`, true);

    const sp = p.stories[id] || { status: 'todo' as const, notes: [], testsPassed: null, updatedAt: now() };
    if (testResults?.length) {
      sp.testResults = sp.testResults || {};
      for (const r of testResults) sp.testResults[r.id] = { status: r.status, file: r.file, notes: r.notes, ts: now() } as CaseResult;
    }
    if (notes) sp.notes.push({ ts: now(), text: notes });
    if (auto.length) {
      const res = sp.testResults || {};
      sp.testsPassed = auto.every(c => res[c.id]?.status === 'pass') ? true : auto.some(c => res[c.id]?.status === 'fail') ? false : null;
      if (status === 'done' && !sp.testsPassed) {
        // the reports are kept, the status is not changed
        p.stories[id] = sp; writeProgress(p);
        const missing = auto.filter(c => !res[c.id]).map(c => c.id);
        const failing = auto.filter(c => res[c.id] && res[c.id].status !== 'pass').map(c => `${c.id} (${res[c.id].status})`);
        return text(`${id} cannot be done yet.${missing.length ? ` Not reported: ${missing.join(', ')}.` : ''}${failing.length ? ` Not passing: ${failing.join(', ')}.` : ''} Implement and run every automated case of its test plan and report each one in testResults.`, true);
      }
    } else if (testsPassed !== undefined) sp.testsPassed = testsPassed;
    // Independent evidence: if the Product Owner approved a test command, the app runs it before the story may be done.
    let verifiedLine = '';
    if (status === 'done' && auto.length) {
      const out = await verifyStory(auto);
      if (out) {
        sp.verification = out.verification;
        const fresh = readProgress(); // the run can take a while: do not overwrite what changed meanwhile
        if (!out.ok) {
          fresh.stories[id] = sp; writeProgress(fresh);
          return text(`${id} cannot be done: the app ran the test command approved by the Product Owner (${out.verification.command}) and it did not confirm the story. ${out.problems.join(' ')}\nEnd of the output:\n${out.verification.outputTail.slice(-900)}`, true);
        }
        verifiedLine = ` Verified by the app: \`${out.verification.command}\` — ${out.verification.reportUsed ? 'all cases of the story pass in the report' : 'exit code 0'} (${(out.verification.durationMs / 1000).toFixed(1)} s).`;
        p.questions = fresh.questions; p.blockers = fresh.blockers;
        for (const [k, v] of Object.entries(fresh.stories)) if (k !== id) p.stories[k] = v;
      }
    }
    sp.status = status; sp.updatedAt = now();
    if (status === 'done') sp.rework = undefined; // the requested rework is finished
    p.stories[id] = sp;
    writeProgress(p);
    const tally = auto.length ? ` Automated cases passing: ${auto.filter(c => sp.testResults?.[c.id]?.status === 'pass').length} of ${auto.length}.` : '';
    return text(`${id} → ${status}.${tally}${verifiedLine} Next: call get_next_story.`);
  });

  // A question to the PO is normally BLOCKING: the tool waits for the answer (clients time tool calls out after about a
  // minute, so it waits in slices) and the agent must not go on without it. If the answer does not arrive in time the
  // agent is told to stop and tell the human, who wakes it up again after answering in the chat.
  const askAndWait = async (
    input: { question: string; topic?: string; options?: { label: string; recommended?: boolean }[]; recommendation?: string; storyId?: string; blocking?: boolean },
    extra: any,
    blockerReason?: string,
  ) => {
    const signal: AbortSignal | undefined = extra?.signal;
    const session = readSession();
    const p = readProgress();
    const blocking = input.blocking !== false;
    const all = loadStories(session, p);
    // the story that waits for the answer: the one named, or the only one in progress
    let id = input.storyId && all.some(s => s.id === input.storyId) ? input.storyId : undefined;
    if (!id) { const cur = all.filter(s => s.status === 'in_progress'); if (cur.length === 1) id = cur[0].id; }
    // The same question asked again while it is still open (the agent retried after a timeout of its own) is not a new
    // question: the Product Owner is not asked twice, the call just waits for the same answer.
    // (the story may not be found a second time: the first call has already put it to "blocked")
    const dup = blocking ? p.questions.find(x => x.status === 'open' && x.question === input.question && (!id || x.storyId === id)) : undefined;
    const q = dup ?? createQuestion(p, { ...input, storyId: id });
    if (!dup && blocking && id) {
      const sp = p.stories[id] || { status: 'todo' as const, notes: [], testsPassed: null, updatedAt: now() };
      const prev = sp.status;
      sp.status = 'blocked'; sp.updatedAt = now();
      sp.notes.push({ ts: now(), text: `Waiting for the Product Owner (${q.id}): ${(blockerReason || input.question).slice(0, 200)}` });
      p.stories[id] = sp;
      p.blockers.push({ id: 'B-' + (p.blockers.length + 1), storyId: id, reason: blockerReason || input.question, questionId: q.id, status: 'open', ts: now(), prevStatus: prev });
    }
    if (!dup) writeProgress(p);
    if (!blocking) return text(`Question ${q.id} sent to the Product Owner. It is NOT answered yet. Continue only with work that does not depend on it, then call get_answer("${q.id}").`);
    const got = await waitForAnswer(q.id, waitMs(), signal, progressTicker(extra));
    return answered(got) ?? text(pendingText(q.id));
  };

  server.registerTool('ask_po', {
    description: 'Asks the Product Owner a question in the chat and WAITS for the answer (the Product Owner sets how long, 10 minutes by default). Use it for anything the decisions do not cover, and ALWAYS when the story conflicts with the existing code or the decisions or is ambiguous about behavior (names of fields, exit codes, what a command prints); never choose for the Product Owner. The work that depends on the answer must not continue until it arrives. If the answer has not arrived, the result tells you to stop and tell the human. Give 2-4 options and mark the one you recommend.',
    inputSchema: {
      question: z.string().describe('The question, precise and self-contained; the chat will rephrase it for the Product Owner'),
      topic: z.string().max(60).optional().describe('Short label of the subject, e.g. "Data file name"; it becomes the beginning of the recorded decision'),
      options: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })).max(6).optional(),
      recommendation: z.string().optional().describe('Why the recommended option is the best'),
      storyId: z.string().optional().describe('The story that depends on the answer (defaults to the story in progress)'),
      blocking: z.boolean().optional().describe('Default true. Set false only if you can fully continue without the answer'),
    },
  }, async (input, extra) => askAndWait(input, extra));

  server.registerTool('get_answer', {
    description: 'Returns the Product Owner\'s answer to a question created with ask_po or report_blocker. With wait=true it waits for it as long as ask_po does.',
    inputSchema: { id: z.string().describe('Question id, e.g. "AQ-1"'), wait: z.boolean().optional().describe('Wait for the answer') },
  }, async ({ id, wait }, extra) => {
    if (!readProgress().questions.some(x => x.id === id)) return text(`No question ${id}.`, true);
    const q = wait ? await waitForAnswer(id, waitMs(), extra?.signal, progressTicker(extra)) : readProgress().questions.find(x => x.id === id);
    return answered(q) ?? text(pendingText(id));
  });

  server.registerTool('report_blocker', {
    description: 'Use when a binding decision (or the environment) makes a story impossible or wrong to implement as specified. Sets the story to "blocked", asks the Product Owner what to do and waits for the answer. Never work around a decision silently.',
    inputSchema: {
      storyId,
      reason: z.string().describe('What exactly conflicts, with the decision id if there is one'),
      options: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })).max(6).optional().describe('Ways forward, e.g. "Change decision D-3 to ..." / "Keep D-3, drop the feature"'),
    },
  }, async ({ storyId: id, reason, options }, extra) => {
    if (!loadStories(readSession(), readProgress()).some(s => s.id === id)) return text(`No story ${id}.`, true);
    return askAndWait({ question: reason, topic: `Blocker in ${id}`, options, storyId: id }, extra, reason);
  });

  server.registerTool('record_assumption', {
    description: 'Records a decision you took on your own about a SMALL detail that the story, the decisions and the existing code leave open and that does not change behavior the story promises (a name, a format, an internal choice). The Product Owner reviews it later and may reject it; then the story comes back to you with an instruction. Anything that conflicts with the existing code or the decisions, or that changes what the user sees or what the story promises, is NOT an assumption: use ask_po and wait.',
    inputSchema: {
      text: z.string().describe('What you decided, concretely'),
      why: z.string().describe('Why, and what the alternative would have been'),
      storyId: z.string().optional().describe('The story it belongs to (defaults to the story in progress)'),
    },
  }, async ({ text: what, why, storyId: sid }) => {
    const session = readSession();
    const p = readProgress();
    const all = loadStories(session, p);
    let id = sid && all.some(s => s.id === sid) ? sid : undefined;
    if (!id) { const cur = all.filter(s => s.status === 'in_progress'); if (cur.length === 1) id = cur[0].id; }
    const a = { id: 'AS-' + (p.assumptions.length + 1), storyId: id, text: what, why, status: 'open' as const, ts: now() };
    p.assumptions.push(a);
    writeProgress(p);
    return text(`Assumption ${a.id} recorded for the Product Owner to review. Carry on. If it is rejected, the story comes back to you (get_next_story) with the instruction of the Product Owner.`);
  });

  server.registerTool('get_assumptions', { description: 'Returns your recorded assumptions with the verdict of the Product Owner (open, confirmed, rejected with the instruction).' }, async () => {
    const as = readProgress().assumptions;
    return text(as.length ? as.map(a => `- ${a.id}${a.storyId ? ' [' + a.storyId + ']' : ''} ${a.status}: ${a.text}${a.note ? ` — Product Owner: ${a.note}` : ''}`).join('\n') : 'No assumptions recorded.');
  });

  server.registerTool('submit_project_context', {
    description: 'Saves the summary of an EXISTING project (stack, architecture, modules, conventions, constraints) that the planning team will work against. Use it only when asked to analyze the repository (prompt analyze-project).',
    inputSchema: { summary: z.string().describe('Markdown summary in the required structure, at most ~800 words') },
  }, async ({ summary }) => {
    if (!summary.trim()) return text('Empty summary.', true);
    if (summary.length > MAX_CONTEXT_CHARS) return text(`Too long (${summary.length} characters, limit ${MAX_CONTEXT_CHARS}). Shorten it and call again.`, true);
    writeContext(summary, 'agent');
    return text('Saved. The Product Owner will review it in the chat. Do not change any files.');
  });

  server.registerTool('get_project_context', { description: 'Returns the confirmed summary of the existing project (if any).' }, async () => {
    const c = readContext();
    return c.exists ? text(c.text) : text('No project context was saved.', true);
  });

  server.registerPrompt('analyze-project', {
    description: 'Read-only analysis of the repository; saves a context summary for the planning team.',
  }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: ANALYZE_PROMPT } }] }));

  server.registerPrompt('implement-next-story', {
    description: 'Implement the stories of the plan one by one, reporting progress to the ScrumBridge chat.',
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: LOOP_PROMPT,
      },
    }],
  }));

  return server;
}
