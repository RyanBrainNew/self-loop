import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PgProjectStore,
  PgTicketStore,
  PgUserStore,
  createPgLoginTransactionStore,
  createPgSessionStore,
  withTenant,
} from './hosted-pg.mjs';
import { tokenHash } from './hosted-session.mjs';

function fakePool(handler) {
  const queries = [];
  const releases = [];
  const pool = {
    async connect() {
      return {
        async query(text, values = []) {
          queries.push({ text: text.replace(/\s+/g, ' ').trim(), values });
          return handler(text, values, queries);
        },
        release() {
          releases.push(true);
        },
      };
    },
  };
  return { pool, queries, releases };
}

test('tenant transactions set RLS context and commit or roll back', async () => {
  const context = fakePool((text) => {
    if (text === 'COMMIT') return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  const value = await withTenant(context.pool, 'tenant-a', async (client) => {
    await client.query('SELECT 1');
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(context.queries.map((item) => item.text), [
    'BEGIN',
    "SELECT set_config('self_loop.tenant_id', $1, true)",
    'SELECT 1',
    'COMMIT',
  ]);
  assert.deepEqual(context.queries[1].values, ['tenant-a']);
  assert.equal(context.releases.length, 1);

  const failing = fakePool((text) => ({ rows: [], rowCount: 0 }));
  await assert.rejects(() => withTenant(failing.pool, 'tenant-b', async () => {
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(failing.queries.map((item) => item.text), [
    'BEGIN',
    "SELECT set_config('self_loop.tenant_id', $1, true)",
    'ROLLBACK',
  ]);
});

test('PostgreSQL session and login stores use hashes and one-time deletes', async () => {
  const context = fakePool((text, values) => {
    if (text.includes('INSERT INTO hosted_sessions')) return { rows: [], rowCount: 1 };
    if (text.includes('SELECT identity, expires_at')) {
      return { rows: [{ identity: { id: 'user-1' } }], rowCount: 1 };
    }
    if (text.includes('DELETE FROM hosted_sessions')) return { rows: [], rowCount: 1 };
    if (text.includes('DELETE FROM login_transactions')) {
      return {
        rows: [{ nonce: 'nonce-1', code_verifier: 'verifier-1', return_to: '/app' }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const sessions = createPgSessionStore({ pool: context.pool });
  const created = await sessions.create({ id: 'user-1' });
  assert.equal(tokenHash(created.token).length, 64);
  assert.deepEqual(await sessions.get(created.token), { id: 'user-1' });
  assert.equal(await sessions.delete(created.token), true);

  const transactions = createPgLoginTransactionStore({ pool: context.pool });
  const pending = await transactions.create({
    state: 'state-1',
    nonce: 'nonce-1',
    verifier: 'verifier-1',
    returnTo: '/app',
  });
  assert.deepEqual(await transactions.take({ state: 'state-1', token: pending.token }), {
    nonce: 'nonce-1',
    verifier: 'verifier-1',
    returnTo: '/app',
  });
  assert.ok(context.queries.some((item) => item.text.includes('state_hash')));
  assert.ok(context.queries.some((item) => item.text.includes('RETURNING nonce')));
});

test('PostgreSQL user store maps OIDC identity and memberships', async () => {
  const context = fakePool((text) => {
    if (text.includes('INSERT INTO users')) {
      return {
        rows: [{ id: 'user-1', email: 'alice@example.com', display_name: 'Alice' }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM users') && text.includes('WHERE id = $1')) {
      return {
        rows: [{ id: 'user-1', email: 'alice@example.com', display_name: 'Alice' }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM memberships')) {
      return {
        rows: [{
          tenant_id: 'tenant-a',
          slug: 'acme',
          display_name: 'Acme',
          role: 'owner',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const users = new PgUserStore({ pool: context.pool });
  const identity = await users.upsertIdentity({
    issuer: 'https://issuer.example',
    subject: 'subject-1',
    email: 'alice@example.com',
    displayName: 'Alice',
  });
  assert.equal(identity.id, 'user-1');
  assert.deepEqual(identity.memberships[0], {
    tenantId: 'tenant-a',
    tenantSlug: 'acme',
    displayName: 'Acme',
    role: 'owner',
    projects: [],
  });
  assert.ok(context.queries.some((item) => item.text.includes('ON CONFLICT')));
  assert.ok(context.queries.some((item) => item.text.includes("set_config('self_loop.user_id'")));
});

test('PostgreSQL projects are always read through a tenant transaction', async () => {
  const context = fakePool((text) => {
    if (text.includes('FROM projects') && text.includes('AND id = $2')) {
      return {
        rows: [{
          id: 'project-1',
          slug: 'console',
          display_name: 'Console',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM projects')) {
      return {
        rows: [
          { id: 'project-1', slug: 'console', display_name: 'Console' },
          { id: 'project-2', slug: 'worker', display_name: 'Worker' },
        ],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const projects = new PgProjectStore({ pool: context.pool });
  const listed = await projects.listProjects({ tenantId: 'tenant-a' });
  assert.equal(listed.length, 2);
  const projectQuery = context.queries.find((item) => item.text.includes('FROM projects'));
  assert.match(projectQuery.text, /WHERE tenant_id = \$1/);
  assert.deepEqual(projectQuery.values, ['tenant-a']);

  const detail = await projects.getProject({
    tenantId: 'tenant-a',
    projectId: 'project-1',
  });
  assert.equal(detail.slug, 'console');
  const detailQuery = context.queries.find(
    (item) => item.text.includes('FROM projects') && item.text.includes('AND id = $2'),
  );
  assert.deepEqual(detailQuery.values, ['tenant-a', 'project-1']);
  assert.ok(context.queries.some((item) => item.text.startsWith('BEGIN')));
  assert.ok(context.queries.some((item) => item.text.startsWith('COMMIT')));
});

test('PostgreSQL user store includes project-level role overrides', async () => {
  const context = fakePool((text) => {
    if (text.includes('INSERT INTO users')) {
      return {
        rows: [{ id: 'user-1', email: 'alice@example.com', display_name: 'Alice' }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM users') && text.includes('WHERE id = $1')) {
      return {
        rows: [{ id: 'user-1', email: 'alice@example.com', display_name: 'Alice' }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM memberships')) {
      return {
        rows: [{
          tenant_id: 'tenant-a',
          slug: 'acme',
          display_name: 'Acme',
          role: 'viewer',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM project_memberships')) {
      return {
        rows: [{
          tenant_id: 'tenant-a',
          project_id: 'project-1',
          role: 'maintainer',
          slug: 'console',
          display_name: 'Console',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const users = new PgUserStore({ pool: context.pool });
  const identity = await users.upsertIdentity({
    issuer: 'https://issuer.example',
    subject: 'subject-1',
    email: 'alice@example.com',
    displayName: 'Alice',
  });
  assert.deepEqual(identity.memberships[0].projects, [{
    projectId: 'project-1',
    slug: 'console',
    displayName: 'Console',
    role: 'maintainer',
  }]);
  const refreshed = await users.getIdentity('user-1');
  assert.equal(refreshed.id, 'user-1');
  assert.equal(refreshed.memberships[0].role, 'viewer');
});

test('PostgreSQL tickets use tenant predicates, row locks, and versions', async () => {
  const context = fakePool((text) => {
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      return { rows: [{ id: 'ticket-1' }], rowCount: 1 };
    }
    if (text.includes('UPDATE tickets') && text.includes("state = 'working'")) {
      return {
        rows: [{
          id: 'ticket-1',
          state: 'working',
          version: 2,
          lease_owner: 'worker-1',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('UPDATE tickets') && text.includes('state = $4')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('WHERE tenant_id = $1') && text.includes('id = $3')) {
      return {
        rows: [{ id: 'ticket-1', state: 'queued', version: 1 }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM tickets')) {
      return {
        rows: [
          { id: 'ticket-2', state: 'queued', version: 1 },
          { id: 'ticket-1', state: 'queued', version: 1 },
        ],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const tickets = new PgTicketStore({ pool: context.pool });

  const listed = await tickets.listTickets({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    state: 'queued',
  });
  assert.equal(listed.length, 2);
  const listQuery = context.queries.find(
    (item) => item.text.includes('FROM tickets') && item.text.includes('LIMIT $4'),
  );
  assert.match(listQuery.text, /tenant_id = \$1/);
  assert.deepEqual(listQuery.values.slice(0, 3), ['tenant-a', 'project-1', 'queued']);

  const detail = await tickets.getTicket({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    ticketId: 'ticket-1',
  });
  assert.equal(detail.id, 'ticket-1');

  const claimed = await tickets.claimNextTicket({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    workerId: 'worker-1',
    leaseSeconds: 60,
  });
  assert.equal(claimed.state, 'working');
  const claimQuery = context.queries.find((item) => item.text.includes('FOR UPDATE SKIP LOCKED'));
  assert.match(claimQuery.text, /state = 'queued'/);
  assert.deepEqual(claimQuery.values, ['tenant-a', 'project-1']);

  const conflict = await tickets.compareAndSetState({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    ticketId: 'ticket-1',
    expectedVersion: 1,
    state: 'done',
  });
  assert.equal(conflict, null);
  const updateQuery = context.queries.find(
    (item) => item.text.includes('UPDATE tickets') && item.text.includes('state = $4'),
  );
  assert.match(updateQuery.text, /AND version = \$5/);
  assert.deepEqual(updateQuery.values, ['tenant-a', 'project-1', 'ticket-1', 'done', 1]);
});
