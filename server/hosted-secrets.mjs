import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { withTenant } from './hosted-pg.mjs';

export const CONNECTOR_PROVIDERS = Object.freeze(['github', 'slack', 'jira', 'generic']);
const PROVIDERS = new Set(CONNECTOR_PROVIDERS);
const MAX_SECRET_BYTES = 32 * 1024;

export function parseSecretKey(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('HOSTED_SECRET_KEY is required');
  const key = /^[0-9a-f]{64}$/i.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new Error('HOSTED_SECRET_KEY must decode to exactly 32 bytes');
  }
  return key;
}

export function credentialAad({ tenantId, projectId, provider, credentialId }) {
  return [tenantId, projectId, provider, credentialId]
    .map((value) => String(value || ''))
    .join(':');
}

export class SecretBox {
  constructor({ key, keyVersion = 'v1' } = {}) {
    this.key = Buffer.isBuffer(key) ? key : parseSecretKey(key);
    if (this.key.length !== 32) {
      throw new Error('SecretBox key must be exactly 32 bytes');
    }
    this.keyVersion = String(keyVersion || 'v1');
  }

  encrypt(value, { aad = '' } = {}) {
    const plaintext = JSON.stringify(value);
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_SECRET_BYTES) {
      throw new Error('connector secret is too large');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(record, { aad = '' } = {}) {
    if (!record?.ciphertext || !record?.iv || !record?.tag) {
      throw new Error('encrypted connector secret is incomplete');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(record.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  }
}

function validateCreateInput({
  tenantId,
  projectId,
  provider,
  secret,
  scope,
  expiresAt,
}) {
  if (!tenantId || !projectId) throw new Error('tenantId and projectId are required');
  if (!PROVIDERS.has(provider)) throw new Error(`unsupported connector provider: ${provider}`);
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('connector secret must be a JSON object');
  }
  if (!Object.keys(secret).length) throw new Error('connector secret cannot be empty');
  if (scope !== undefined && (scope === null || typeof scope !== 'object' || Array.isArray(scope))) {
    throw new Error('connector scope must be a JSON object');
  }
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('expiresAt must be an ISO timestamp');
  }
}

function metadata(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    sourceId: row.source_id,
    scope: row.scope || {},
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const METADATA_COLUMNS = `
  id, provider, display_name, source_id, scope, expires_at, revoked_at,
  created_at, updated_at
`;

export class PgConnectorSecretStore {
  constructor({ pool, box } = {}) {
    if (!pool?.connect) throw new Error('pool with connect() is required');
    if (!box) throw new Error('SecretBox is required');
    this.pool = pool;
    this.box = box;
  }

  async createCredential({
    tenantId,
    projectId,
    provider,
    sourceId = null,
    displayName = '',
    secret,
    scope = {},
    expiresAt = null,
  }) {
    validateCreateInput({
      tenantId,
      projectId,
      provider,
      secret,
      scope,
      expiresAt,
    });
    const id = randomUUID();
    const encrypted = this.box.encrypt(secret, {
      aad: credentialAad({ tenantId, projectId, provider, credentialId: id }),
    });
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO connector_secrets
           (id, tenant_id, project_id, source_id, provider, display_name,
            secret_ref, secret_ciphertext, secret_iv, secret_tag, key_version,
            scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
         RETURNING ${METADATA_COLUMNS}`,
        [
          id,
          tenantId,
          projectId,
          sourceId,
          provider,
          String(displayName || ''),
          `local:${encrypted.keyVersion}`,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.keyVersion,
          JSON.stringify(scope || {}),
          expiresAt,
        ],
      );
      return metadata(result.rows[0]);
    });
  }

  async listCredentials({ tenantId, projectId, includeRevoked = false }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${METADATA_COLUMNS}
         FROM connector_secrets
         WHERE tenant_id = $1
           AND project_id = $2
           AND ($3::boolean OR revoked_at IS NULL)
         ORDER BY created_at DESC`,
        [tenantId, projectId, Boolean(includeRevoked)],
      );
      return result.rows.map(metadata);
    });
  }

  async getCredentialRecord({ tenantId, projectId, credentialId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, provider, revoked_at, expires_at, key_version,
                secret_ciphertext, secret_iv, secret_tag
         FROM connector_secrets
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
        [tenantId, projectId, credentialId],
      );
      return result.rows[0] || null;
    });
  }

  async runtimeSecret({ tenantId, projectId, credentialId }) {
    const row = await this.getCredentialRecord({ tenantId, projectId, credentialId });
    if (!row) throw new Error('connector credential not found');
    if (row.revoked_at) throw new Error('connector credential is revoked');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      throw new Error('connector credential is expired');
    }
    return this.box.decrypt({
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      tag: row.secret_tag,
    }, {
      aad: credentialAad({
        tenantId,
        projectId,
        provider: row.provider,
        credentialId,
      }),
    });
  }

  async rotateCredential({
    tenantId,
    projectId,
    credentialId,
    secret,
    scope,
    expiresAt = null,
  }) {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
      throw new Error('connector secret must be a JSON object');
    }
    return withTenant(this.pool, tenantId, async (client) => {
      const found = await client.query(
        `SELECT provider
         FROM connector_secrets
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
         FOR UPDATE`,
        [tenantId, projectId, credentialId],
      );
      const current = found.rows[0];
      if (!current) return null;
      const encrypted = this.box.encrypt(secret, {
        aad: credentialAad({
          tenantId,
          projectId,
          provider: current.provider,
          credentialId,
        }),
      });
      const result = await client.query(
        `UPDATE connector_secrets
         SET secret_ref = $4,
             secret_ciphertext = $5,
             secret_iv = $6,
             secret_tag = $7,
             key_version = $8,
             scope = COALESCE($9::jsonb, scope),
             expires_at = $10,
             revoked_at = NULL,
             updated_at = now()
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
         RETURNING ${METADATA_COLUMNS}`,
        [
          tenantId,
          projectId,
          credentialId,
          `local:${encrypted.keyVersion}`,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.keyVersion,
          scope === undefined ? null : JSON.stringify(scope),
          expiresAt,
        ],
      );
      return metadata(result.rows[0]);
    });
  }

  async revokeCredential({ tenantId, projectId, credentialId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE connector_secrets
         SET revoked_at = now(), updated_at = now()
         WHERE tenant_id = $1
           AND project_id = $2
           AND id = $3
           AND revoked_at IS NULL
         RETURNING ${METADATA_COLUMNS}`,
        [tenantId, projectId, credentialId],
      );
      return metadata(result.rows[0]);
    });
  }
}
