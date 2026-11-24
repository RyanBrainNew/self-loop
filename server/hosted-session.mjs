import { createHash, randomBytes } from 'node:crypto';

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

export function parseCookieHeader(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

export function serializeCookie(name, value, {
  path = '/',
  maxAge = null,
  httpOnly = true,
  secure = true,
  sameSite = 'Lax',
} = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value))}`];
  parts.push(`Path=${path}`);
  if (maxAge !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

export function safeReturnTo(value, fallback = '/') {
  const candidate = String(value || '').trim();
  if (!candidate) return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  if (candidate.includes('\\') || candidate.includes('\r') || candidate.includes('\n')) {
    return fallback;
  }
  return candidate;
}

export class MemorySessionStore {
  constructor({ ttlSeconds = 8 * 60 * 60, now = Date.now } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.now = now;
    this.records = new Map();
  }

  create(identity) {
    const token = newToken();
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    this.records.set(tokenHash(token), {
      identity,
      expiresAt,
      createdAt: new Date(this.now()).toISOString(),
    });
    return { token, expiresAt };
  }

  get(token) {
    const key = tokenHash(token);
    const record = this.records.get(key);
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.records.delete(key);
      return null;
    }
    return record.identity;
  }

  delete(token) {
    return this.records.delete(tokenHash(token));
  }

  prune() {
    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= this.now()) this.records.delete(key);
    }
  }
}

export class MemoryLoginTransactionStore {
  constructor({ ttlSeconds = 10 * 60, now = Date.now } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.now = now;
    this.records = new Map();
  }

  create({ state, nonce, verifier, returnTo = '/' }) {
    const token = newToken();
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    this.records.set(tokenHash(token), {
      state,
      nonce,
      verifier,
      returnTo,
      expiresAt,
    });
    return { token, expiresAt };
  }

  take({ state, token }) {
    const key = tokenHash(token);
    const record = this.records.get(key);
    if (!record) return null;
    this.records.delete(key);
    if (Date.parse(record.expiresAt) <= this.now()) return null;
    if (!state || record.state !== state) return null;
    return record;
  }

  prune() {
    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= this.now()) this.records.delete(key);
    }
  }
}

export { tokenHash };
