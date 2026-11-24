import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHostedHandler } from './hosted-http.mjs';

async function fixture({
  identity: identityOverride,
  projectStore = null,
  ticketStore = null,
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
