import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHostedHandler } from './hosted-http.mjs';

async function fixture({
  identity: identityOverride,
  projectStore = null,
  ticketStore = null,
  secretStore = null,
  ingressStore = null,
  ingressService = null,
} = {}) {
  const calls = [];
  const identity = identityOverride || {
    id: 'user-1',
    email: 'alice@example.com',
    memberships: [{ tenantId: 'tenant-a', role: 'owner' }],
  };
  let active = true;
  const authService = {
    beginLogin({ returnTo }) {
      calls.push(['beginLogin', returnTo]);
      return {
        authorizationUrl: 'https://issuer.example/authorize?state=state-1',
        transactionToken: 'transaction-1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async completeLogin({ code, state, transactionToken }) {
      calls.push(['completeLogin', code, state, transactionToken]);
      return {
        identity,
        sessionToken: 'session-1',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        returnTo: '/projects',
      };
    },
    currentIdentity(token) {
      return active && token === 'session-1' ? identity : null;
    },
    logout(token) {
      calls.push(['logout', token]);
      if (token === 'session-1') active = false;
      return token === 'session-1';
    },
  };
  const handler = createHostedHandler({
    authService,
    projectStore,
    ticketStore,
    secretStore,
    ingressStore,
    ingressService,
    secureCookies: false,
    allowedOrigins: ['https://console.example'],
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cookieValue(response, name) {
  const setCookie = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')];
  for (const header of setCookie) {
    const first = String(header || '').split(';')[0];
    if (first.startsWith(`${name}=`)) return first;
  }
  return '';
}

test('hosted HTTP login, callback, me, and logout use HttpOnly cookies', async () => {
  const context = await fixture();
  try {
    const login = await fetch(`${context.base}/auth/login?return_to=/projects`, {
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    assert.match(login.headers.get('location'), /issuer\.example/);
    const transactionCookie = cookieValue(login, 'self_loop_hosted_login');
    assert.match(transactionCookie, /^self_loop_hosted_login=transaction-1$/);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);

    const callback = await fetch(`${context.base}/auth/callback?code=code-1&state=state-1`, {
      redirect: 'manual',
      headers: { Cookie: transactionCookie },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/projects');
    const sessionCookie = cookieValue(callback, 'self_loop_hosted_session');
    assert.match(sessionCookie, /^self_loop_hosted_session=session-1$/);
    assert.match(callback.headers.get('set-cookie'), /HttpOnly/);

    const me = await fetch(`${context.base}/api/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).identity.id, 'user-1');

    const crossSite = await fetch(`${context.base}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, Origin: 'https://evil.example' },
    });
    assert.equal(crossSite.status, 403);

    const logout = await fetch(`${context.base}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, Origin: 'https://console.example' },
    });
    assert.equal(logout.status, 204);
    const after = await fetch(`${context.base}/api/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(after.status, 401);
    assert.ok(context.calls.some((call) => call[0] === 'logout'));
  } finally {
    await context.close();
  }
});

test('hosted HTTP does not trust arbitrary session cookies', async () => {
  const context = await fixture();
  try {
    const me = await fetch(`${context.base}/api/me`, {
      headers: { Cookie: 'self_loop_hosted_session=stolen' },
    });
    assert.equal(me.status, 401);
    assert.equal((await me.json()).error, 'not authenticated');
  } finally {
    await context.close();
  }
});

test('hosted tenant routes enforce membership before reading projects', async () => {
  const membershipCalls = [];
  const identity = {
    id: 'user-2',
    email: 'bob@example.com',
    memberships: [
      {
        tenantId: 'tenant-a',
        tenantSlug: 'acme',
        displayName: 'Acme',
        role: 'viewer',
        projects: [],
      },
      {
        tenantId: 'tenant-b',
        tenantSlug: 'beta',
        displayName: 'Beta',
        role: 'operator',
        projects: [{
          projectId: 'project-1',
          slug: 'console',
          displayName: 'Console',
          role: 'maintainer',
        }],
      },
    ],
  };
  const projectStore = {
    async listProjects({ tenantId }) {
      membershipCalls.push(['list', tenantId]);
      return [{ id: 'project-1', slug: 'console', display_name: 'Console' }];
    },
    async getProject({ tenantId, projectId }) {
      membershipCalls.push(['get', tenantId, projectId]);
      return { id: projectId, slug: 'console', display_name: 'Console' };
    },
  };
  const context = await fixture({ identity, projectStore });
  const cookie = { Cookie: 'self_loop_hosted_session=session-1' };
  try {
    const anonymous = await fetch(`${context.base}/api/tenants`);
    assert.equal(anonymous.status, 401);

    const tenants = await fetch(`${context.base}/api/tenants`, { headers: cookie });
    assert.equal(tenants.status, 200);
    const body = await tenants.json();
    assert.deepEqual(body.tenants.map((tenant) => tenant.tenantId), ['tenant-a', 'tenant-b']);
    assert.deepEqual(body.tenants[1].projects[0], {
      projectId: 'project-1',
      slug: 'console',
      displayName: 'Console',
      role: 'maintainer',
    });
    assert.equal(JSON.stringify(body).includes('@example.com'), false);

    const listed = await fetch(`${context.base}/api/tenants/tenant-b/projects`, {
      headers: cookie,
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).projects[0].id, 'project-1');
    assert.deepEqual(membershipCalls.at(-1), ['list', 'tenant-b']);

    const detail = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1`,
      { headers: cookie },
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(membershipCalls.at(-1), ['get', 'tenant-b', 'project-1']);

    const crossTenant = await fetch(`${context.base}/api/tenants/tenant-c/projects`, {
      headers: cookie,
    });
    assert.equal(crossTenant.status, 403);
    assert.match((await crossTenant.json()).error, /not a tenant member/);

    const malformed = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/extra`,
      { headers: cookie },
    );
    assert.equal(malformed.status, 404);
  } finally {
    await context.close();
  }
});

test('hosted ticket routes are tenant-scoped and read-only', async () => {
  const calls = [];
  const identity = {
    id: 'user-3',
    memberships: [{
      tenantId: 'tenant-a',
      tenantSlug: 'acme',
      displayName: 'Acme',
      role: 'viewer',
      projects: [],
    }],
  };
  const ticketStore = {
    async listTickets({ tenantId, projectId, state, limit }) {
      calls.push(['list', tenantId, projectId, state, limit]);
      return [{ id: 'ticket-1', number: 1043, state: 'queued' }];
    },
    async getTicket({ tenantId, projectId, ticketId }) {
      calls.push(['get', tenantId, projectId, ticketId]);
      return { id: ticketId, number: 1043, state: 'queued' };
    },
  };
  const context = await fixture({ identity, ticketStore });
  const cookie = { Cookie: 'self_loop_hosted_session=session-1' };
  try {
    const listed = await fetch(
      `${context.base}/api/tenants/tenant-a/projects/project-1/tickets?state=queued&limit=20`,
      { headers: cookie },
    );
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).tickets[0].number, 1043);
    assert.deepEqual(calls.at(-1), ['list', 'tenant-a', 'project-1', 'queued', '20']);

    const detail = await fetch(
      `${context.base}/api/tenants/tenant-a/projects/project-1/tickets/ticket-1`,
      { headers: cookie },
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).ticket.id, 'ticket-1');
    assert.deepEqual(calls.at(-1), ['get', 'tenant-a', 'project-1', 'ticket-1']);

    const crossTenant = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/tickets`,
      { headers: cookie },
    );
    assert.equal(crossTenant.status, 403);

    const missingStore = await fixture({ identity });
    try {
      const notConfigured = await fetch(
        `${missingStore.base}/api/tenants/tenant-a/projects/project-1/tickets`,
        { headers: cookie },
      );
      assert.equal(notConfigured.status, 501);
    } finally {
      await missingStore.close();
    }
  } finally {
    await context.close();
  }
});

test('hosted routes do not leak database errors', async () => {
  const identity = {
    id: 'user-4',
    memberships: [{
      tenantId: 'tenant-a',
      tenantSlug: 'acme',
      displayName: 'Acme',
      role: 'viewer',
      projects: [],
    }],
  };
  const context = await fixture({
    identity,
    projectStore: {
      async listProjects() {
        throw new Error('relation "projects" does not exist');
      },
    },
  });
  try {
    const response = await fetch(`${context.base}/api/tenants/tenant-a/projects`, {
      headers: { Cookie: 'self_loop_hosted_session=session-1' },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: 'hosted service unavailable' });
  } finally {
    await context.close();
  }
});

test('hosted connector credentials require source:manage and never return secrets', async () => {
  const calls = [];
  const identity = {
    id: 'user-5',
    memberships: [
      {
        tenantId: 'tenant-a',
        tenantSlug: 'acme',
        displayName: 'Acme',
        role: 'viewer',
        projects: [],
      },
      {
        tenantId: 'tenant-b',
        tenantSlug: 'beta',
        displayName: 'Beta',
        role: 'maintainer',
        projects: [],
      },
    ],
  };
  const metadata = {
    id: 'credential-1',
    provider: 'github',
    displayName: 'GitHub',
    scope: {},
    revokedAt: null,
  };
  const secretStore = {
    async listCredentials(input) {
      calls.push(['list', input]);
      return [metadata];
    },
    async createCredential(input) {
      calls.push(['create', input]);
      return metadata;
    },
    async rotateCredential(input) {
      calls.push(['rotate', input]);
      return metadata;
    },
    async revokeCredential(input) {
      calls.push(['revoke', input]);
      return { ...metadata, revokedAt: '2026-11-24T00:00:00Z' };
    },
    async getCredentialRecord(input) {
      calls.push(['record', input]);
      return { id: input.credentialId, provider: 'github' };
    },
  };
  const bindings = [];
  const ingressStore = {
    async listBindings() {
      return bindings;
    },
    async createBinding(input) {
      calls.push(['binding-create', input]);
      const binding = {
        id: 'binding-1',
        provider: input.provider,
        externalId: input.externalId,
        credentialId: input.credentialId,
      };
      bindings.push(binding);
      return binding;
    },
    async deleteBinding(input) {
      calls.push(['binding-delete', input]);
      return true;
    },
  };
  const context = await fixture({
    identity,
    secretStore,
    ingressStore,
  });
  const cookie = { Cookie: 'self_loop_hosted_session=session-1' };
  try {
    const denied = await fetch(
      `${context.base}/api/tenants/tenant-a/projects/project-1/credentials`,
      {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          secret: { webhookSecret: 'super-secret' },
        }),
      },
    );
    assert.equal(denied.status, 403);

    const created = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/credentials`,
      {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          displayName: 'GitHub',
          secret: { webhookSecret: 'super-secret' },
        }),
      },
    );
    assert.equal(created.status, 201);
    const createdBody = await created.text();
    assert.equal(createdBody.includes('super-secret'), false);
    assert.equal(calls.at(-1)[1].secret.webhookSecret, 'super-secret');

    const listed = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/credentials`,
      { headers: cookie },
    );
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).credentials[0].id, 'credential-1');

    const rotated = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/credentials/credential-1/rotate`,
      {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: { webhookSecret: 'rotated' } }),
      },
    );
    assert.equal(rotated.status, 200);

    const revoked = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/credentials/credential-1`,
      { method: 'DELETE', headers: cookie },
    );
    assert.equal(revoked.status, 200);
    assert.ok((await revoked.json()).credential.revokedAt);

    const binding = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/bindings`,
      {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          externalId: 'acme/repo',
          credentialId: 'credential-1',
        }),
      },
    );
    assert.equal(binding.status, 201);
    assert.equal((await binding.json()).binding.externalId, 'acme/repo');

    const deleted = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/bindings/binding-1`,
      { method: 'DELETE', headers: cookie },
    );
    assert.equal(deleted.status, 204);

    const crossSite = await fetch(
      `${context.base}/api/tenants/tenant-b/projects/project-1/credentials`,
      {
        method: 'POST',
        headers: {
          ...cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'github',
          secret: { webhookSecret: 'x' },
        }),
      },
    );
    assert.equal(crossSite.status, 403);
  } finally {
    await context.close();
  }
});

test('hosted webhook routes do not require a console session', async () => {
  const calls = [];
  const ingressService = {
    async ingestGitHub(input) {
      calls.push(['github', input.headers['x-github-delivery']]);
      return {
        duplicate: false,
        dedupeKey: 'binding-1:github:delivery-1',
        id: 'event-1',
        kind: 'issue.opened',
        status: 'pending',
        ignoredReason: null,
      };
    },
    async ingestSlack(input) {
      calls.push(['slack', input.contentType]);
      if (input.rawBody.includes('url_verification')) {
        return { challenge: 'challenge-1' };
      }
      return {
        duplicate: false,
        dedupeKey: 'binding-slack:slack:trigger-1',
        id: 'event-2',
        kind: 'task.created',
        status: 'pending',
        acknowledgement: '已收到 Fix login',
      };
    },
  };
  const context = await fixture({ ingressService });
  try {
    const github = await fetch(`${context.base}/hooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-1',
      },
      body: '{"repository":{"full_name":"acme/repo"}}',
    });
    assert.equal(github.status, 202);
    assert.equal((await github.json()).event.kind, 'issue.opened');

    const slackChallenge = await fetch(`${context.base}/hooks/slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"url_verification","team_id":"T1"}',
    });
    assert.equal(slackChallenge.status, 200);
    assert.equal((await slackChallenge.json()).challenge, 'challenge-1');

    const slackCommand = await fetch(`${context.base}/hooks/slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'command=%2Floop&team_id=T1&trigger_id=trigger-1',
    });
    assert.equal(slackCommand.status, 200);
    const commandBody = await slackCommand.json();
    assert.equal(commandBody.response_type, 'ephemeral');
    assert.match(commandBody.text, /Fix login/);

    const crossSite = await fetch(`${context.base}/hooks/github`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(crossSite.status, 403);
    assert.equal(calls.length, 3);
  } finally {
    await context.close();
  }
});

test('hosted webhook routes report a missing ingress service', async () => {
  const context = await fixture();
  try {
    const response = await fetch(`${context.base}/hooks/github`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(response.status, 503);
  } finally {
    await context.close();
  }
});
