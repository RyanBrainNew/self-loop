const ALL = '*';

export const HOSTED_ROLES = Object.freeze([
  'owner',
  'maintainer',
  'operator',
  'viewer',
]);

export const HOSTED_PERMISSIONS = Object.freeze([
  'tenant:read',
  'tenant:manage',
  'project:read',
  'project:write',
  'ticket:read',
  'ticket:operate',
  'ticket:approve',
  'source:manage',
  'worker:manage',
  'automation:manage',
  'outbox:manage',
  'audit:read',
  'secret:manage',
]);

const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set([ALL]),
  maintainer: new Set([
    'tenant:read',
    'project:read',
    'project:write',
    'ticket:read',
    'ticket:operate',
    'ticket:approve',
    'source:manage',
    'worker:manage',
    'automation:manage',
    'outbox:manage',
    'audit:read',
  ]),
  operator: new Set([
    'tenant:read',
    'project:read',
    'ticket:read',
    'ticket:operate',
    'outbox:manage',
    'audit:read',
  ]),
  viewer: new Set([
    'tenant:read',
    'project:read',
    'ticket:read',
  ]),
});

function roleOf(membership, projectId) {
  if (!membership) return null;
  if (projectId) {
    const project = (membership.projects || []).find(
      (item) => String(item.projectId) === String(projectId),
    );
    if (project?.role) return project.role;
  }
  return membership.role || null;
}

export function hasPermission(role, permission) {
  if (!HOSTED_ROLES.includes(role)) return false;
  const allowed = ROLE_PERMISSIONS[role];
  return allowed.has(ALL) || allowed.has(permission);
}

export function membershipFor(identity, tenantId) {
  return (identity?.memberships || []).find(
    (membership) => String(membership.tenantId) === String(tenantId),
  ) || null;
}

/**
 * Resolve a role for one tenant/project pair. Cross-tenant access is denied
 * before role lookup, so a project id by itself can never escape its tenant.
 */
export function authorize({
  identity,
  tenantId,
  projectId = null,
  permission,
} = {}) {
  if (!identity?.id) return { ok: false, reason: 'missing identity' };
  if (!tenantId) return { ok: false, reason: 'missing tenant' };
  if (!HOSTED_PERMISSIONS.includes(permission)) {
    return { ok: false, reason: `unknown permission: ${permission}` };
  }
  const membership = membershipFor(identity, tenantId);
  if (!membership) return { ok: false, reason: 'not a tenant member' };
  const role = roleOf(membership, projectId);
  if (!role) return { ok: false, reason: 'no role for project' };
  if (!hasPermission(role, permission)) {
    return { ok: false, reason: `role ${role} cannot ${permission}` };
  }
  return { ok: true, tenantId, projectId, role };
}

/**
 * Trusted reverse proxies may forward an already-authenticated OIDC identity.
 * This helper is deliberately opt-in: callers must pass an allowlisted proxy
 * configuration and must never expose these headers to the public internet.
 */
export function resolveTrustedIdentity(headers, {
  enabled = false,
  headerPrefix = 'x-auth-request-',
} = {}) {
  if (!enabled) return null;
  const get = (name) => {
    const key = `${headerPrefix}${name}`.toLowerCase();
    const value = headers?.[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const id = String(get('user') || '').trim();
  const email = String(get('email') || '').trim();
  if (!id && !email) return null;
  const groups = String(get('groups') || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    id: id || email,
    email: email || id,
    groups,
    source: 'trusted-proxy-oidc',
  };
}

export function rolePermissions() {
  return Object.fromEntries(
    HOSTED_ROLES.map((role) => [
      role,
      ROLE_PERMISSIONS[role].has(ALL)
        ? [...HOSTED_PERMISSIONS]
        : [...ROLE_PERMISSIONS[role]],
    ]),
  );
}
