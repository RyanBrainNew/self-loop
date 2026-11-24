import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryLoginTransactionStore,
  MemorySessionStore,
  clearCookie,
  parseCookieHeader,
  safeReturnTo,
  serializeCookie,
  tokenHash,
} from './hosted-session.mjs';

test('session and login transaction stores are opaque, expiring, and one-time', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const sessions = new MemorySessionStore({ ttlSeconds: 60, now: () => now });
  const session = sessions.create({ id: 'user-1', memberships: [] });
  assert.equal(sessions.get(session.token).id, 'user-1');
  assert.equal(session.tokenHash, undefined);
  assert.equal(tokenHash(session.token).length, 64);
  now += 61_000;
  assert.equal(sessions.get(session.token), null);

  now = Date.parse('2026-01-01T00:00:00Z');
  const transactions = new MemoryLoginTransactionStore({ ttlSeconds: 60, now: () => now });
  const created = transactions.create({
    state: 'state-1',
    nonce: 'nonce-1',
    verifier: 'verifier-1',
    returnTo: '/projects',
  });
  assert.equal(transactions.take({ state: 'wrong', token: created.token }), null);
  assert.equal(transactions.take({ state: 'state-1', token: created.token }), null);

  const second = transactions.create({
    state: 'state-2',
    nonce: 'nonce-2',
    verifier: 'verifier-2',
  });
  assert.equal(transactions.take({ state: 'state-2', token: second.token }).nonce, 'nonce-2');
  assert.equal(transactions.take({ state: 'state-2', token: second.token }), null);
});

test('cookies are strict and return_to cannot become an open redirect', () => {
  const cookie = serializeCookie('sid', 'a b', {
    path: '/',
    maxAge: 60,
    secure: true,
    sameSite: 'Lax',
  });
  assert.match(cookie, /^sid=a%20b; Path=\/; Max-Age=60; HttpOnly; Secure; SameSite=Lax$/);
  assert.deepEqual(parseCookieHeader('a=1; sid=a%20b'), { a: '1', sid: 'a b' });
  assert.match(clearCookie('sid'), /Max-Age=0/);
  assert.equal(safeReturnTo('/projects'), '/projects');
  assert.equal(safeReturnTo('//evil.example'), '/');
  assert.equal(safeReturnTo('https://evil.example'), '/');
  assert.equal(safeReturnTo('/\\evil'), '/');
});
