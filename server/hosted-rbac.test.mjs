import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOSTED_PERMISSIONS,
  HOSTED_ROLES,
  authorize,
  hasPermission,
  membershipFor,
  resolveTrustedIdentity,
  rolePermissions,
} from './hosted-rbac.mjs';

const identity = {
  id: 'user-1',
  email: 'alice@example.com',
  memberships: [
    {
      tenantId: 'tenant-a',
      role: 'viewer',
      projects: [
        { projectId: 'project-1', role: 'operator' },
        { projectId: 'project-2', role: 'maintainer' },
      ],
    },
    {
      tenantId: 'tenant-b',
      role: 'owner',
    },
  ],
};

test('hosted RBAC is default-deny and denies cross-tenant access', () => {
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-c',
    permission: 'project:read',
  }).ok, false);
  assert.equal(authorize({
    identity: null,
    tenantId: 'tenant-a',
    permission: 'project:read',
  }).ok, false);
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    projectId: 'project-1',
    permission: 'not-a-permission',
  }).ok, false);
});

test('hosted RBAC applies project overrides and least privilege', () => {
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    projectId: 'project-1',
    permission: 'ticket:operate',
  }).role, 'operator');
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    projectId: 'project-1',
    permission: 'ticket:approve',
  }).ok, false);
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    projectId: 'project-1',
    permission: 'ticket:read',
  }).ok, true);
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    projectId: 'project-2',
    permission: 'source:manage',
  }).ok, true);
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-a',
    permission: 'project:read',
  }).role, 'viewer');
  assert.equal(authorize({
    identity,
    tenantId: 'tenant-b',
    permission: 'secret:manage',
  }).role, 'owner');
});

test('role permissions are explicit and complete', () => {
  const matrix = rolePermissions();
  assert.deepEqual(Object.keys(matrix), [...HOSTED_ROLES]);
  assert.deepEqual(matrix.owner, [...HOSTED_PERMISSIONS]);
  assert.equal(hasPermission('viewer', 'tenant:manage'), false);
  assert.equal(hasPermission('maintainer', 'secret:manage'), false);
  assert.equal(hasPermission('operator', 'outbox:manage'), true);
  assert.equal(hasPermission('unknown', 'project:read'), false);
});

test('trusted proxy identity is opt-in and has no token material', () => {
  const headers = {
    'x-auth-request-user': 'alice',
    'x-auth-request-email': 'alice@example.com',
    'x-auth-request-groups': 'platform, self-loop',
    authorization: 'Bearer secret-that-must-not-leak',
  };
  assert.equal(resolveTrustedIdentity(headers, { enabled: false }), null);
  assert.deepEqual(resolveTrustedIdentity(headers, { enabled: true }), {
    id: 'alice',
    email: 'alice@example.com',
    groups: ['platform', 'self-loop'],
    source: 'trusted-proxy-oidc',
  });
  assert.equal(membershipFor(identity, 'tenant-a')?.role, 'viewer');
});
