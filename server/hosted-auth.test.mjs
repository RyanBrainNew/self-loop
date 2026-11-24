import assert from 'node:assert/strict';
import test from 'node:test';
import { HostedAuthService } from './hosted-auth.mjs';
import {
  MemoryLoginTransactionStore,
  MemorySessionStore,
} from './hosted-session.mjs';

function fixture(overrides = {}) {
  const discovered = {
    issuer: 'https://issuer.example',
    authorization_endpoint: 'https://issuer.example/authorize',
    token_endpoint: 'https://issuer.example/token',
    jwks_uri: 'https://issuer.example/jwks',
  };
  const calls = [];
  const userStore = {
    async upsertIdentity(input) {
      calls.push(['upsertIdentity', input]);
      return {
        id: 'user-1',
        email: input.email,
        displayName: input.displayName,
        memberships: [{ tenantId: 'tenant-a', role: 'owner' }],
      };
    },
  };
  const exchangeCode = async (input) => {
    calls.push(['exchangeCode', input]);
    return { id_token: 'signed-id-token', access_token: 'access-token' };
  };
  const verifyToken = (token, input) => {
    calls.push(['verifyToken', token, input]);
    return {
      claims: {
        iss: discovered.issuer,
        sub: 'subject-1',
        email: 'alice@example.com',
        name: 'Alice',
      },
    };
  };
  const service = new HostedAuthService({
    discovery: discovered,
    clientId: 'self-loop',
    redirectUri: 'https://console.example/auth/callback',
    jwks: { keys: [] },
    userStore,
    sessionStore: new MemorySessionStore(),
    transactionStore: new MemoryLoginTransactionStore(),
    exchangeCode,
    verifyToken,
    ...overrides,
  });
  return { service, calls };
}

test('hosted auth builds a PKCE authorization request and persists one-time state', async () => {
  const { service } = fixture();
  const started = await service.beginLogin({ returnTo: '/projects/one' });
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get('client_id'), 'self-loop');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://console.example/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('nonce')?.length > 10, true);
  assert.equal(url.searchParams.get('state')?.length > 10, true);
  assert.ok(started.transactionToken);
});

test('hosted auth completes login without exposing the access token', async () => {
  const { service, calls } = fixture();
  const started = await service.beginLogin({ returnTo: '/projects/one' });
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const result = await service.completeLogin({
    code: 'code-1',
    state,
    transactionToken: started.transactionToken,
  });
  assert.equal(result.identity.id, 'user-1');
  assert.equal(result.sessionToken.split('.').length, 1);
  assert.equal(result.returnTo, '/projects/one');
  assert.equal(JSON.stringify(result).includes('access-token'), false);
  assert.equal(calls[0][0], 'exchangeCode');
  assert.equal(calls[1][0], 'verifyToken');
  assert.equal(calls[2][0], 'upsertIdentity');
  assert.equal((await service.currentIdentity(result.sessionToken)).id, 'user-1');
  assert.equal(await service.logout(result.sessionToken), true);
  assert.equal(await service.currentIdentity(result.sessionToken), null);
});

test('hosted auth rejects replayed callbacks and open redirects', async () => {
  const { service } = fixture();
  const started = await service.beginLogin({ returnTo: '//evil.example' });
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const result = await service.completeLogin({
    code: 'code-1',
    state,
    transactionToken: started.transactionToken,
  });
  assert.equal(result.returnTo, '/');
  await assert.rejects(() => service.completeLogin({
    code: 'code-1',
    state,
    transactionToken: started.transactionToken,
  }), /state is invalid/);
});

test('hosted sessions refresh roles and revoke deleted users', async () => {
  let role = 'owner';
  let deleted = false;
  const { service } = fixture({
    identityResolver: async (session) => {
      if (deleted) return null;
      return {
        id: session.id,
        memberships: [{ tenantId: 'tenant-a', role }],
      };
    },
  });
  const started = await service.beginLogin();
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const result = await service.completeLogin({
    code: 'code-1',
    state,
    transactionToken: started.transactionToken,
  });
  role = 'viewer';
  const refreshed = await service.currentIdentity(result.sessionToken);
  assert.equal(refreshed.memberships[0].role, 'viewer');

  deleted = true;
  assert.equal(await service.currentIdentity(result.sessionToken), null);
  assert.equal(await service.currentIdentity(result.sessionToken), null);
});
