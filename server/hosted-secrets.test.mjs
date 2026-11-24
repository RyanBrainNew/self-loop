import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  PgConnectorSecretStore,
  SecretBox,
  parseSecretKey,
} from './hosted-secrets.mjs';

function fakePool(handler) {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(text, values = []) {
          queries.push({ text: text.replace(/\s+/g, ' ').trim(), values });
          return handler(text, values);
        },
        release() {},
      };
    },
  };
  return { pool, queries };
}

test('secret box encrypts with AAD and rejects tampering', () => {
  const key = randomBytes(32);
  const box = new SecretBox({ key });
  const encrypted = box.encrypt({ webhookSecret: 'super-secret' }, { aad: 'tenant:a' });
  assert.equal(box.decrypt(encrypted, { aad: 'tenant:a' }).webhookSecret, 'super-secret');
  assert.throws(
    () => box.decrypt(encrypted, { aad: 'tenant:b' }),
    /authenticate|unable/i,
  );
  assert.throws(
    () => box.decrypt({ ...encrypted, ciphertext: 'tampered' }, { aad: 'tenant:a' }),
    /authenticate|unable|invalid/i,
  );
  assert.equal(parseSecretKey(key.toString('base64')).length, 32);
  assert.throws(() => parseSecretKey('short'), /32 bytes/);
});

test('connector credentials are encrypted, tenant-scoped, and never returned raw', async () => {
  let inserted = null;
  const context = fakePool((text, values) => {
    if (text.includes('INSERT INTO connector_secrets')) {
      inserted = values;
      return {
        rows: [{
          id: values[0],
          provider: 'github',
          display_name: 'GitHub webhook',
          source_id: null,
          scope: {},
          expires_at: null,
          revoked_at: null,
          created_at: '2026-11-24T00:00:00Z',
          updated_at: '2026-11-24T00:00:00Z',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT id, provider, revoked_at')) {
      return {
        rows: [{
          id: inserted[0],
          provider: 'github',
          revoked_at: null,
          expires_at: null,
          key_version: 'v1',
          secret_ciphertext: inserted[7],
          secret_iv: inserted[8],
          secret_tag: inserted[9],
        }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT provider') && text.includes('FOR UPDATE')) {
      return { rows: [{ provider: 'github' }], rowCount: 1 };
    }
    if (text.includes('UPDATE connector_secrets') && text.includes('secret_ciphertext')) {
      return {
        rows: [{
          id: values[2],
          provider: 'github',
          display_name: 'GitHub webhook',
          source_id: null,
          scope: {},
          expires_at: null,
          revoked_at: null,
          created_at: '2026-11-24T00:00:00Z',
          updated_at: '2026-11-24T00:01:00Z',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('UPDATE connector_secrets') && text.includes('revoked_at = now()')) {
      return {
        rows: [{
          id: values[2],
          provider: 'github',
          display_name: 'GitHub webhook',
          source_id: null,
          scope: {},
          expires_at: null,
          revoked_at: '2026-11-24T00:02:00Z',
          created_at: '2026-11-24T00:00:00Z',
          updated_at: '2026-11-24T00:02:00Z',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM connector_secrets') && text.includes('ORDER BY created_at')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PgConnectorSecretStore({
    pool: context.pool,
    box: new SecretBox({ key: randomBytes(32) }),
  });
  const credential = await store.createCredential({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    provider: 'github',
    displayName: 'GitHub webhook',
    secret: { webhookSecret: 'super-secret' },
  });
  assert.equal(credential.provider, 'github');
  assert.equal(JSON.stringify(credential).includes('super-secret'), false);
  assert.equal(JSON.stringify(inserted).includes('super-secret'), false);
  assert.match(inserted[6], /^local:v1$/);

  const runtime = await store.runtimeSecret({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    credentialId: credential.id,
  });
  assert.equal(runtime.webhookSecret, 'super-secret');

  const rotated = await store.rotateCredential({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    credentialId: credential.id,
    secret: { webhookSecret: 'rotated-secret' },
  });
  assert.equal(rotated.id, credential.id);
  const revoked = await store.revokeCredential({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    credentialId: credential.id,
  });
  assert.ok(revoked.revokedAt);

  const writes = context.queries.filter((item) => /INSERT|UPDATE|SELECT/.test(item.text));
  for (const query of writes.filter((item) => item.text.includes('connector_secrets'))) {
    assert.match(query.text, /tenant_id/);
    assert.ok(query.values.includes('tenant-a'));
  }
});

test('runtime credentials reject revoked and expired records', async () => {
  let record = {
    id: 'credential-1',
    provider: 'slack',
    revoked_at: '2026-11-24T00:00:00Z',
    expires_at: null,
  };
  const context = fakePool((text) => {
    if (text.includes('SELECT id, provider, revoked_at')) {
      return { rows: [record], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PgConnectorSecretStore({
    pool: context.pool,
    box: new SecretBox({ key: randomBytes(32) }),
  });
  await assert.rejects(
    () => store.runtimeSecret({
      tenantId: 'tenant-a',
      projectId: 'project-1',
      credentialId: 'credential-1',
    }),
    /revoked/,
  );
  record = {
    ...record,
    revoked_at: null,
    expires_at: '2020-01-01T00:00:00Z',
  };
  await assert.rejects(
    () => store.runtimeSecret({
      tenantId: 'tenant-a',
      projectId: 'project-1',
      credentialId: 'credential-1',
    }),
    /expired/,
  );
});
