import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// User-level settings live outside any project: they hold secrets and must never end up in a repository.
const baseDir = () => process.platform === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
// The product used to be called "ai-scrum-team": its folder and credential-store entries are carried over to the new name.
const LEGACY_NAME = 'ai-scrum-team';
export const CONFIG_DIR = process.env.AIST_CONFIG_DIR || path.join(baseDir(), 'scrumbridge');

// Copies the files of the old config folder (token, keys, approvals, settings) once, when the new folder does not exist yet.
// Copies, never moves: the old folder stays as it was.
export function migrateLegacyConfig(dir: string = CONFIG_DIR, legacyDir: string = path.join(path.dirname(dir), LEGACY_NAME)): boolean {
  try {
    if (fs.existsSync(dir) || !fs.statSync(legacyDir).isDirectory()) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const e of fs.readdirSync(legacyDir, { withFileTypes: true })) {
      if (e.isFile()) fs.copyFileSync(path.join(legacyDir, e.name), path.join(dir, e.name));
    }
    return true;
  } catch { return false; } // no old folder (a first run) or it cannot be read: start clean
}
if (!process.env.AIST_CONFIG_DIR) migrateLegacyConfig();

function ensureDir(): void { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); }

// ---- local access token: proves that the caller is the person who started the app ----
let token: string | null = null;
export function getToken(): string {
  if (token) return token;
  const file = path.join(CONFIG_DIR, 'token');
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  if (!token) {
    ensureDir();
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, token, { mode: 0o600 });
  }
  return token;
}
export function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate), b = Buffer.from(getToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- API keys: environment variable > OS credential store > a file in the user's config folder ----
export type KeySource = 'env' | 'keychain' | 'file';
const SERVICE = 'scrumbridge';
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.json');

type KeyEntry = { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean };
type KeyringFactory = (service: string, account: string) => KeyEntry;
let keyringEntry: ((account: string, service?: string) => KeyEntry) | null | undefined;
async function keyring() {
  if (keyringEntry !== undefined) return keyringEntry;
  if (process.env.AIST_NO_KEYRING) { keyringEntry = null; return keyringEntry; } // tests and headless machines: use the file
  try {
    const { Entry } = await import('@napi-rs/keyring');
    keyringEntry = (account: string, service = SERVICE) => new Entry(service, account);
  } catch { keyringEntry = null; }
  return keyringEntry;
}
// for tests: a credential store that is not the real one of the machine
export function useKeyring(factory: KeyringFactory | null): void {
  keyringEntry = factory ? (account, service = SERVICE) => factory(service, account) : null;
}

function readFileCreds(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return {}; }
}
function writeFileCreds(c: Record<string, string>): void {
  ensureDir();
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export async function getKey(provider: string, envVars: string[]): Promise<{ key: string; source: KeySource } | null> {
  for (const v of envVars) if (process.env[v]) return { key: process.env[v]!, source: 'env' };
  const k = await keyring();
  if (k) {
    try { const p = k(provider).getPassword(); if (p) return { key: p, source: 'keychain' }; } catch { /* fall through to the file */ }
    // a key stored under the old name of the product moves to the new entry the first time it is needed
    try {
      const old = k(provider, LEGACY_NAME), p = old.getPassword();
      if (p) {
        try { k(provider).setPassword(p); try { old.deletePassword(); } catch { /* the copy is made; the old entry may stay */ } } catch { /* cannot write the new entry: still use the key */ }
        return { key: p, source: 'keychain' };
      }
    } catch { /* no old entry */ }
  }
  const f = readFileCreds()[provider];
  return f ? { key: f, source: 'file' } : null;
}

export async function setKey(provider: string, key: string): Promise<KeySource> {
  const k = await keyring();
  if (k) {
    try {
      k(provider).setPassword(key);
      const c = readFileCreds();
      if (c[provider]) { delete c[provider]; writeFileCreds(c); } // do not leave an older copy in the file
      return 'keychain';
    } catch { /* credential store unavailable: use the file */ }
  }
  writeFileCreds({ ...readFileCreds(), [provider]: key });
  return 'file';
}

export async function deleteKey(provider: string): Promise<void> {
  const k = await keyring();
  if (k) {
    try { k(provider).deletePassword(); } catch { /* nothing stored */ }
    try { k(provider, LEGACY_NAME).deletePassword(); } catch { /* nothing stored under the old name: otherwise it would come back */ }
  }
  const c = readFileCreds();
  if (c[provider]) { delete c[provider]; writeFileCreds(c); }
}

// ---- test command approved by the Product Owner, per project (kept outside the project, out of the agent's reach) ----
export interface Approval { command: string; reportFile: string; approvedAt: string }
const APPROVALS_FILE = path.join(CONFIG_DIR, 'approvals.json');
function readApprovals(): Record<string, Approval> {
  try { return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8')); } catch { return {}; }
}
export const getApproval = (projectId: string): Approval | null => readApprovals()[projectId] ?? null;
export function setApproval(projectId: string, a: { command: string; reportFile: string }): Approval {
  ensureDir();
  const all = readApprovals();
  all[projectId] = { command: a.command.trim(), reportFile: (a.reportFile || '').trim(), approvedAt: new Date().toISOString() };
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all[projectId];
}
export function clearApproval(projectId: string): void {
  const all = readApprovals();
  if (all[projectId]) { delete all[projectId]; fs.writeFileSync(APPROVALS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 }); }
}

// ---- settings of the user for the app as a whole (not a project, no secrets) ----
export interface UserSettings { waitSeconds?: number }
export const DEFAULT_WAIT_SECONDS = 600; // how long the agent waits in ask_po for the answer of the Product Owner
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
export function readSettings(): UserSettings {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
export function writeSettings(s: UserSettings): UserSettings {
  ensureDir();
  const clean: UserSettings = {};
  const w = Number(s.waitSeconds);
  if (Number.isFinite(w)) clean.waitSeconds = Math.min(3600, Math.max(5, Math.round(w)));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}
// The environment variable is for tests and scripts; normally the user's setting counts.
export function waitMs(): number {
  const env = Number(process.env.AIST_WAIT_MS);
  if (env > 0) return env;
  const w = Number(readSettings().waitSeconds);
  return (w >= 5 && w <= 3600 ? w : DEFAULT_WAIT_SECONDS) * 1000;
}
