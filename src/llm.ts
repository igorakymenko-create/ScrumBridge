import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, getKey } from './config.js';

// Model providers. The browser never sees an API key: it asks the server to generate, and the server adds the key.
// A "connection" is one configured provider account (type + optional base URL + a key in the credential store).
// Several connections can be active at the same time, e.g. Gemini, Anthropic and a local Ollama.

export type ProviderType = 'gemini' | 'anthropic' | 'openai';
export interface Connection { id: string; type: ProviderType; label: string; baseUrl?: string }

export interface GenerateOpts { model: string; system: string; prompt: string; json: boolean; temperature: number }
export interface GenerateResult { text: string; usage: { in: number; out: number } }

export class LlmError extends Error {
  constructor(message: string, public status = 0, public retryAfter = 0, public daily = false) { super(message); }
}

interface Adapter {
  type: ProviderType;
  label: string;
  defaultBaseUrl: string;
  envVars: string[];                         // used only by the connection whose id equals its type
  needsKey(c: Connection): boolean;
  generate(c: Connection, opts: GenerateOpts, key: string): Promise<GenerateResult>;
  listModels(c: Connection, key: string): Promise<string[]>;
}

const arr = <T = any>(x: unknown): T[] => (Array.isArray(x) ? x : []);
const base = (c: Connection, a: Adapter) => (c.baseUrl || a.defaultBaseUrl).replace(/\/+$/, '');
const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(u);

// One HTTP call with provider-neutral error handling.
async function httpJson(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try { res = await fetch(url, init); } catch (e) { throw new LlmError(`cannot reach ${new URL(url).host}: ${(e as Error).message}`); }
  const data: any = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const e = data?.error;
  const message = (typeof e === 'string' ? e : e?.message) || data?.message || `HTTP ${res.status}`;
  const detail = arr(e?.details).find((x: any) => String(x['@type'] || '').includes('RetryInfo'));
  const header = parseFloat(res.headers.get('retry-after') || '');
  const retryAfter = detail?.retryDelay ? parseFloat(detail.retryDelay) * 1000 : Number.isFinite(header) ? header * 1000 : 0;
  const daily = /per\s*day|PerDay|insufficient_quota|billing|credit balance/i.test(JSON.stringify(data));
  throw new LlmError(message, res.status, retryAfter, daily);
}

// ---------- Google Gemini ----------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const gemini: Adapter = {
  type: 'gemini', label: 'Google Gemini', defaultBaseUrl: GEMINI_BASE, envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  needsKey: () => true,
  async generate(c, { model, system, prompt, json, temperature }, key) {
    const body: any = { contents: [{ role: 'user', parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature } };
    if (json) body.generationConfig.responseMimeType = 'application/json';
    // the key goes in a header, not in the URL, so it cannot end up in logs
    const data = await httpJson(`${base(c, gemini)}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    const cand = data.candidates?.[0];
    const text = arr(cand?.content?.parts).filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join('');
    if (!text) throw new LlmError(`empty answer (${data.promptFeedback?.blockReason || cand?.finishReason || 'unknown reason'})`, 200);
    const u = data.usageMetadata || {};
    return { text, usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  },
  async listModels(c, key) {
    const data = await httpJson(`${base(c, gemini)}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    return arr(data.models).filter((m: any) => arr(m.supportedGenerationMethods).includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''));
  },
};

// ---------- Anthropic ----------
const anthropic: Adapter = {
  type: 'anthropic', label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com/v1', envVars: ['ANTHROPIC_API_KEY'],
  needsKey: () => true,
  async generate(c, { model, system, prompt, temperature }, key) {
    // The API has no JSON mode: the system prompt already demands strict JSON, and the chat extracts the object.
    const body: any = { model, max_tokens: 16384, system, messages: [{ role: 'user', content: prompt }], temperature };
    const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    let data: any;
    try { data = await httpJson(`${base(c, anthropic)}/messages`, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (e) {
      // some newer models fix the temperature: retry once without it
      if (e instanceof LlmError && e.status === 400 && /temperature/i.test(e.message)) { delete body.temperature; data = await httpJson(`${base(c, anthropic)}/messages`, { method: 'POST', headers, body: JSON.stringify(body) }); }
      else throw e;
    }
    const text = arr(data.content).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
    if (!text) throw new LlmError(`empty answer (${data.stop_reason || 'unknown reason'})`, 200);
    return { text, usage: { in: data.usage?.input_tokens || 0, out: data.usage?.output_tokens || 0 } };
  },
  async listModels(c, key) {
    const data = await httpJson(`${base(c, anthropic)}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return arr(data.data).map((m: any) => String(m.id));
  },
};

// ---------- OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, ...) ----------
const openai: Adapter = {
  type: 'openai', label: 'OpenAI-compatible', defaultBaseUrl: 'https://api.openai.com/v1', envVars: ['OPENAI_API_KEY'],
  needsKey: c => !isLocalUrl(base(c, openai)), // a local server (Ollama, LM Studio) usually has no key
  async generate(c, { model, system, prompt, json, temperature }, key) {
    const body: any = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature };
    if (json) body.response_format = { type: 'json_object' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    let data: any;
    for (let attempt = 0; ; attempt++) {
      try { data = await httpJson(`${base(c, openai)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }); break; }
      catch (e) {
        // servers and newer models differ in what they accept: drop the unsupported option and try again
        if (e instanceof LlmError && e.status === 400 && attempt < 2) {
          if (/response_format|json_object/i.test(e.message) && body.response_format) { delete body.response_format; continue; }
          if (/temperature/i.test(e.message) && body.temperature !== undefined) { delete body.temperature; continue; }
        }
        throw e;
      }
    }
    const ch = data.choices?.[0];
    const text = typeof ch?.message?.content === 'string' ? ch.message.content : arr(ch?.message?.content).map((p: any) => p.text || '').join('');
    if (!text) throw new LlmError(`empty answer (${ch?.finish_reason || 'unknown reason'})`, 200);
    return { text, usage: { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 } };
  },
  async listModels(c, key) {
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    const data = await httpJson(`${base(c, openai)}/models`, { headers });
    return arr(data.data).map((m: any) => String(m.id)).sort();
  },
};

export const ADAPTERS: Record<ProviderType, Adapter> = { gemini, anthropic, openai };
export const PROVIDER_TYPES = Object.values(ADAPTERS).map(a => ({ type: a.type, label: a.label, defaultBaseUrl: a.defaultBaseUrl }));

// ---------- connections (user level, no secrets: keys live in the credential store) ----------
const CONN_FILE = path.join(CONFIG_DIR, 'providers.json');
const DEFAULTS: Connection[] = [
  { id: 'gemini', type: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', type: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openai', type: 'openai', label: 'OpenAI' },
];

export function listConnections(): Connection[] {
  try {
    const j = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
    if (Array.isArray(j.connections)) return j.connections.filter((c: any) => c?.id && ADAPTERS[c.type as ProviderType]);
  } catch { /* not created yet */ }
  return DEFAULTS;
}
function saveConnections(list: Connection[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONN_FILE, JSON.stringify({ connections: list }, null, 2));
}
export const getConnection = (id: string) => listConnections().find(c => c.id === id);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'provider';

export function addConnection(input: { type: string; label: string; baseUrl?: string }): Connection {
  if (!ADAPTERS[input.type as ProviderType]) throw new LlmError('unknown provider type', 400);
  const list = listConnections();
  let id = slug(input.label || input.type), n = 2;
  while (list.some(c => c.id === id)) id = `${slug(input.label || input.type)}-${n++}`;
  const baseUrl = (input.baseUrl || '').trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new LlmError('the base URL must start with http:// or https://', 400);
  const c: Connection = { id, type: input.type as ProviderType, label: (input.label || ADAPTERS[input.type as ProviderType].label).trim().slice(0, 60), ...(baseUrl ? { baseUrl } : {}) };
  saveConnections([...list, c]);
  return c;
}
export function removeConnection(id: string): boolean {
  const list = listConnections();
  if (!list.some(c => c.id === id)) return false;
  saveConnections(list.filter(c => c.id !== id));
  return true;
}

// ---------- calls ----------
async function resolve(id: string): Promise<{ conn: Connection; adapter: Adapter; key: string }> {
  const conn = getConnection(id);
  if (!conn) throw new LlmError(`unknown provider "${id}"`, 400);
  const adapter = ADAPTERS[conn.type];
  const k = await getKey(conn.id, conn.id === conn.type ? adapter.envVars : []);
  if (adapter.needsKey(conn) && !k) throw new LlmError(`no API key for ${conn.label}`, 401);
  return { conn, adapter, key: k?.key ?? '' };
}

export async function generate(id: string, opts: GenerateOpts): Promise<GenerateResult> {
  const { conn, adapter, key } = await resolve(id);
  return adapter.generate(conn, opts, key);
}
export async function listModels(id: string): Promise<string[]> {
  const { conn, adapter, key } = await resolve(id);
  return adapter.listModels(conn, key);
}
export const connectionNeedsKey = (c: Connection) => ADAPTERS[c.type].needsKey(c);
export const connectionEnvVars = (c: Connection) => (c.id === c.type ? ADAPTERS[c.type].envVars : []);
