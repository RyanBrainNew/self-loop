import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SESSION_COOKIE = 'self_loop_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'slc_';

export function defaultTokenFile(env = process.env) {
  if (env.SELF_LOOP_CONSOLE_TOKEN_FILE) return env.SELF_LOOP_CONSOLE_TOKEN_FILE;
  return join(homedir(), '.self-loop', 'console-token');
}

function validToken(value) {
  return typeof value === 'string' && /^slc_[a-f0-9]{64}$/.test(value.trim());
}

function writePrivateFile(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function ensureToken(file, { rotate = false } = {}) {
  const resolved = file;
  if (!rotate && existsSync(resolved)) {
    const existing = readFileSync(resolved, 'utf8').trim();
    if (validToken(existing)) return { token: existing, created: false, file: resolved };
    if (existing) {
      throw new Error(
        `refusing to overwrite an invalid console token at ${resolved}; move it and retry`,
      );
    }
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  writePrivateFile(resolved, `${token}\n`);
  return { token, created: true, file: resolved };
}

function digest(value) {
  return createHmac('sha256', value).update('self-loop-console-session').digest();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tokenMatches(expected, candidate) {
  if (!validToken(expected) || !validToken(candidate)) return false;
  return safeEqual(digest(expected), digest(candidate));
}

export function createSession(token, now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  const signature = createHmac('sha256', token).update(`session:${expires}`).digest('hex');
  return `v1.${expires}.${signature}`;
}

export function verifySession(token, value, now = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires) || expires <= now) return false;
  const expected = createHmac('sha256', token).update(`session:${expires}`).digest('hex');
  return safeEqual(expected, parts[2]);
}

export function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return cookies;
}

function requestHost(req) {
  return String(req.headers.host || '').trim();
}

export function requestSource(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin;
  const referer = String(req.headers.referer || '').trim();
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid-referer';
    }
  }
  return 'direct';
}

export function requestIp(req) {
  return String(req.socket?.remoteAddress || 'local');
}

/**
 * Reject cross-site browser requests. Requests without Origin are treated as
 * non-browser clients (curl, the CLI, GitHub) and are still subject to auth on
 * unsafe methods.
 */
export function sameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim();
  if (fetchSite === 'cross-site') return false;
  if (!origin) return true;
  if (origin === 'null') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = requestHost(req);
  return Boolean(host) && parsed.host === host;
}

export function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

export function createAuth({ tokenFile, now = Date.now } = {}) {
  const file = tokenFile || defaultTokenFile();
  let token = '';
  let created = false;

  function load({ rotate = false } = {}) {
    const result = ensureToken(file, { rotate });
    token = result.token;
    created = result.created;
    return result;
  }

  function rotate() {
    const result = ensureToken(file, { rotate: true });
    token = result.token;
    created = true;
    return result;
  }

  function sessionCookie() {
    return `${SESSION_COOKIE}=${encodeURIComponent(createSession(token, now()))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  function authorize(req) {
    if (!sameOrigin(req)) {
      return { ok: false, status: 403, reason: 'cross-site request rejected' };
    }
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) {
      if (tokenMatches(token, header.slice(7).trim())) {
        return { ok: true, via: 'bearer', actor: 'cli', source: requestSource(req), ip: requestIp(req) };
      }
      return { ok: false, status: 401, reason: 'invalid bearer token' };
    }
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (cookie && verifySession(token, cookie, now())) {
      return { ok: true, via: 'session', actor: 'console', source: requestSource(req), ip: requestIp(req) };
    }
    return { ok: false, status: 401, reason: 'write token required' };
  }

  load();

  return {
    file,
    get token() {
      return token;
    },
    get created() {
      return created;
    },
    load,
    rotate,
    sessionCookie,
    authorize,
    sameOrigin,
  };
}
