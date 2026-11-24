import { randomBytes, randomUUID } from 'node:crypto';
import { tokenHash } from './hosted-session.mjs';

function token() {
  return randomBytes(32).toString('base64url');
}

export function createPgSessionStore({ pool, ttlSeconds = 8 * 60 * 60 } = {}) {
  if (!pool?.connect) throw new Error('pool with connect() is required');
  return {
    async create(identity) {
      const value = token();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO hosted_sessions (token_hash, user_id, identity, expires_at)
           VALUES ($1, $2, $3::jsonb, $4)`,
          [tokenHash(value), identity.id, JSON.stringify(identity), expiresAt],
        );
      } finally {
        client.release();
      }
      return { token: value, expiresAt };
    },

    async get(value) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT identity, expires_at
           FROM hosted_sessions
           WHERE token_hash = $1 AND expires_at > now()`,
          [tokenHash(value)],
        );
        return result.rows[0]?.identity || null;
      } finally {
        client.release();
      }
    },

    async delete(value) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          'DELETE FROM hosted_sessions WHERE token_hash = $1',
          [tokenHash(value)],
        );
        return Number(result.rowCount || 0) > 0;
      } finally {
        client.release();
      }
    },
  };
}

export function createPgLoginTransactionStore({
  pool,
  ttlSeconds = 10 * 60,
} = {}) {
  if (!pool?.connect) throw new Error('pool with connect() is required');
  return {
    async create({ state, nonce, verifier, returnTo = '/' }) {
      const value = token();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO login_transactions
             (token_hash, state_hash, nonce, code_verifier, return_to, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tokenHash(value), tokenHash(state), nonce, verifier, returnTo, expiresAt],
        );
      } finally {
        client.release();
      }
      return { token: value, expiresAt };
    },

    async take({ state, token: value }) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `DELETE FROM login_transactions
           WHERE token_hash = $1
             AND state_hash = $2
             AND expires_at > now()
           RETURNING nonce, code_verifier, return_to`,
          [tokenHash(value), tokenHash(state)],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          nonce: row.nonce,
          verifier: row.code_verifier,
          returnTo: row.return_to,
        };
      } finally {
        client.release();
      }
    },
  };
}

export class PgUserStore {
  constructor({ pool } = {}) {
    if (!pool?.connect) throw new Error('pool with connect() is required');
    this.pool = pool;
  }

  async upsertUser({ issuer, subject, email, displayName }) {
    if (!issuer || !subject) throw new Error('OIDC issuer and subject are required');
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO users (id, oidc_issuer, oidc_subject, email, display_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (oidc_issuer, oidc_subject)
         DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
         RETURNING id, email, display_name`,
        [randomUUID(), issuer, subject, email || '', displayName || subject],
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async membershipsForUser(userId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('self_loop.user_id', $1, true)", [userId]);
      const result = await client.query(
        `SELECT m.tenant_id, t.slug, t.display_name, m.role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1
         ORDER BY t.slug`,
        [userId],
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async projectsForUser(userId, tenantIds = []) {
    const rows = [];
    for (const tenantId of tenantIds) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('self_loop.tenant_id', $1, true)", [tenantId]);
        await client.query("SELECT set_config('self_loop.user_id', $1, true)", [userId]);
        const result = await client.query(
          `SELECT pm.tenant_id, pm.project_id, pm.role, p.slug, p.display_name
           FROM project_memberships pm
           JOIN projects p ON p.id = pm.project_id
           WHERE pm.tenant_id = $1 AND pm.user_id = $2
           ORDER BY p.slug`,
          [tenantId, userId],
        );
        await client.query('COMMIT');
        rows.push(...result.rows);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    }
    return rows;
  }

  async identityForUser(user) {
    const memberships = await this.membershipsForUser(user.id);
    const projects = await this.projectsForUser(
      user.id,
      memberships.map((membership) => membership.tenant_id),
    );
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      memberships: memberships.map((row) => ({
        tenantId: row.tenant_id,
        tenantSlug: row.slug,
        displayName: row.display_name,
        role: row.role,
        projects: projects
          .filter((project) => String(project.tenant_id) === String(row.tenant_id))
          .map((project) => ({
            projectId: project.project_id,
            slug: project.slug,
            displayName: project.display_name,
            role: project.role,
          })),
      })),
    };
  }

  async getIdentity(userId) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, email, display_name
         FROM users
         WHERE id = $1`,
        [userId],
      );
      const user = result.rows[0];
      return user ? this.identityForUser(user) : null;
    } finally {
      client.release();
    }
  }

  async upsertIdentity(input) {
    const user = await this.upsertUser(input);
    return this.identityForUser(user);
  }
}

export class PgProjectStore {
  constructor({ pool } = {}) {
    if (!pool?.connect) throw new Error('pool with connect() is required');
    this.pool = pool;
  }

  async listProjects({ tenantId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, slug, display_name, repo_url, default_branch,
                state_version, created_at, updated_at
         FROM projects
         WHERE tenant_id = $1
         ORDER BY slug`,
        [tenantId],
      );
      return result.rows;
    });
  }

  async getProject({ tenantId, projectId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, slug, display_name, repo_url, default_branch,
                state_version, created_at, updated_at
         FROM projects
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, projectId],
      );
      return result.rows[0] || null;
    });
  }
}

function clampLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(parsed)));
}

export class PgTicketStore {
  constructor({ pool } = {}) {
    if (!pool?.connect) throw new Error('pool with connect() is required');
    this.pool = pool;
  }

  async listTickets({ tenantId, projectId, state = null, limit = 100 }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, project_id, number, state, version, title,
                payload, lease_owner, lease_expires_at, updated_at
         FROM tickets
         WHERE tenant_id = $1
           AND project_id = $2
           AND ($3::text IS NULL OR state = $3)
         ORDER BY number DESC
         LIMIT $4`,
        [tenantId, projectId, state || null, clampLimit(limit)],
      );
      return result.rows;
    });
  }

  async getTicket({ tenantId, projectId, ticketId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, project_id, number, state, version, title,
                payload, lease_owner, lease_expires_at, updated_at
         FROM tickets
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
        [tenantId, projectId, ticketId],
      );
      return result.rows[0] || null;
    });
  }

  async claimNextTicket({ tenantId, projectId, workerId, leaseSeconds = 900 }) {
    if (!workerId) throw new Error('workerId is required to claim a ticket');
    const lease = Math.max(1, Number(leaseSeconds) || 900);
    return withTenant(this.pool, tenantId, async (client) => {
      const found = await client.query(
        `SELECT id
         FROM tickets
         WHERE tenant_id = $1
           AND project_id = $2
           AND state = 'queued'
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY updated_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [tenantId, projectId],
      );
      const ticket = found.rows[0];
      if (!ticket) return null;
      const claimed = await client.query(
        `UPDATE tickets
         SET state = 'working',
             lease_owner = $3,
             lease_expires_at = now() + ($4 * interval '1 second'),
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1 AND project_id = $2 AND id = $5
         RETURNING id, tenant_id, project_id, number, state, version, title,
                   payload, lease_owner, lease_expires_at, updated_at`,
        [tenantId, projectId, workerId, lease, ticket.id],
      );
      return claimed.rows[0] || null;
    });
  }

  async compareAndSetState({
    tenantId,
    projectId,
    ticketId,
    expectedVersion,
    state,
  }) {
    if (!state) throw new Error('state is required');
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tickets
         SET state = $4,
             lease_owner = NULL,
             lease_expires_at = NULL,
             version = version + 1,
             updated_at = now()
         WHERE tenant_id = $1
           AND project_id = $2
           AND id = $3
           AND version = $5
         RETURNING id, tenant_id, project_id, number, state, version, title,
                   payload, lease_owner, lease_expires_at, updated_at`,
        [tenantId, projectId, ticketId, state, expectedVersion],
      );
      return result.rows[0] || null;
    });
  }
}

export async function withTenant(pool, tenantId, fn) {
  if (!pool?.connect) throw new Error('pool with connect() is required');
  if (!tenantId) throw new Error('tenantId is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('self_loop.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
