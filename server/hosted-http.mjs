import { clearCookie, parseCookieHeader, serializeCookie } from './hosted-session.mjs';
import { authorize } from './hosted-rbac.mjs';
import { CONNECTOR_PROVIDERS } from './hosted-secrets.mjs';

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_BODY_BYTES = 1024 * 1024;
const PROVIDERS = new Set(CONNECTOR_PROVIDERS);

function validSecretObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function validScope(value) {
  return value === undefined
    || value === null
    || (typeof value === 'object' && !Array.isArray(value));
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function headers(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers(extra),
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location, extra = {}) {
  res.writeHead(302, {
    Location: location,
    ...headers(extra),
  });
  res.end();
}

function originAllowed(req, allowedOrigins) {
  const site = String(req.headers['sec-fetch-site'] || '').trim();
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return false;
  }
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function sessionMaxAge(expiresAt, now = Date.now()) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

async function readRawBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const raw = await readRawBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function pathSegments(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function publicMemberships(identity) {
  return (identity.memberships || []).map((membership) => ({
    tenantId: membership.tenantId,
    tenantSlug: membership.tenantSlug || '',
    displayName: membership.displayName || membership.tenantSlug || '',
    role: membership.role,
    projects: (membership.projects || []).map((project) => ({
      projectId: project.projectId,
      slug: project.slug || '',
      displayName: project.displayName || project.slug || '',
      role: project.role,
    })),
  }));
}

/**
 * Hosted HTTP surface. It is intentionally separate from the local console's
 * token API. Authentication is an OIDC session cookie; every hosted route that
 * needs a tenant must go through HostedAuthService and RBAC before reading or
 * mutating tenant data.
 */
export function createHostedHandler({
  authService,
  secureCookies = true,
  sessionCookieName = 'self_loop_hosted_session',
  transactionCookieName = 'self_loop_hosted_login',
  allowedOrigins = [],
  projectStore = null,
  ticketStore = null,
  secretStore = null,
  ingressStore = null,
  ingressService = null,
} = {}) {
  if (!authService) throw new Error('authService is required');
  const origins = allowedOrigins.map((item) => String(item).replace(/\/+$/, ''));

  async function readThrough(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'hosted data service unavailable');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const cookies = parseCookieHeader(req.headers.cookie || '');
    const requireIdentity = async () => {
      try {
        const identity = await authService.currentIdentity(cookies[sessionCookieName]);
        if (!identity) throw new HttpError(401, 'not authenticated');
        return identity;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'session service unavailable');
      }
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, mode: 'hosted' });
      }

      if (req.method === 'POST' && url.pathname === '/hooks/github') {
        if (req.headers.origin && !originAllowed(req, origins)) {
          return sendJson(res, 403, { error: 'cross-site request rejected' });
        }
        if (!ingressService) {
          return sendJson(res, 503, { error: 'hosted webhook ingress is not configured' });
        }
        const rawBody = await readRawBody(req);
        const result = await ingressService.ingestGitHub({
          headers: req.headers,
          rawBody,
        });
        return sendJson(res, 202, {
          ok: true,
          duplicate: result.duplicate,
          dedupeKey: result.dedupeKey,
          event: {
            id: result.id,
            kind: result.kind,
            status: result.status,
            ignoredReason: result.ignoredReason,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/hooks/slack') {
        if (req.headers.origin && !originAllowed(req, origins)) {
          return sendJson(res, 403, { error: 'cross-site request rejected' });
        }
        if (!ingressService) {
          return sendJson(res, 503, { error: 'hosted webhook ingress is not configured' });
        }
        const rawBody = await readRawBody(req);
        const result = await ingressService.ingestSlack({
          headers: req.headers,
          rawBody,
          contentType: req.headers['content-type'] || '',
        });
        if (result.challenge !== undefined) {
          return sendJson(res, 200, { challenge: result.challenge });
        }
        if (result.acknowledgement) {
          return sendJson(res, 200, {
            response_type: 'ephemeral',
            text: result.acknowledgement,
            duplicate: result.duplicate,
            eventId: result.id,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          duplicate: result.duplicate,
          dedupeKey: result.dedupeKey,
          event: {
            id: result.id,
            kind: result.kind,
            status: result.status,
            ignoredReason: result.ignoredReason,
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/auth/login') {
        const started = await authService.beginLogin({
          returnTo: url.searchParams.get('return_to') || '/',
        });
        return redirect(res, started.authorizationUrl, {
          'Set-Cookie': serializeCookie(transactionCookieName, started.transactionToken, {
            path: '/auth',
            maxAge: 600,
            secure: secureCookies,
            sameSite: 'Lax',
          }),
        });
      }

      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const completed = await authService.completeLogin({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          transactionToken: cookies[transactionCookieName],
        });
        return redirect(res, completed.returnTo, {
          'Set-Cookie': [
            serializeCookie(sessionCookieName, completed.sessionToken, {
              path: '/',
              maxAge: sessionMaxAge(completed.expiresAt),
              secure: secureCookies,
              sameSite: 'Lax',
            }),
            clearCookie(transactionCookieName, {
              path: '/auth',
              secure: secureCookies,
              sameSite: 'Lax',
            }),
          ],
        });
      }

      if (UNSAFE_METHODS.has(req.method) && !originAllowed(req, origins)) {
        return sendJson(res, 403, { error: 'cross-site request rejected' });
      }

      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        await authService.logout(cookies[sessionCookieName]);
        return sendJson(res, 204, null, {
          'Set-Cookie': clearCookie(sessionCookieName, {
            path: '/',
            secure: secureCookies,
            sameSite: 'Lax',
          }),
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/me') {
        const identity = await requireIdentity();
        return sendJson(res, 200, { identity });
      }

      if (req.method === 'GET' && url.pathname === '/api/tenants') {
        const identity = await requireIdentity();
        return sendJson(res, 200, { tenants: publicMemberships(identity) });
      }

      const segments = pathSegments(url.pathname);
      if (
        ['GET', 'POST', 'DELETE'].includes(req.method)
        && segments[0] === 'api'
        && segments[1] === 'tenants'
      ) {
        const identity = await requireIdentity();
        const tenantId = segments[2];
        const projectId = segments[4];
        if (!tenantId || segments[3] !== 'projects') {
          return sendJson(res, 404, { error: 'not found' });
        }
        const resource = segments[5];
        const resourceId = segments[6];
        const resourceAction = segments[7];
        const isTicketRoute = resource === 'tickets';
        const isCredentialRoute = resource === 'credentials';
        const isBindingRoute = resource === 'bindings';
        const isConnectorRoute = isCredentialRoute || isBindingRoute;
        const validShape = segments.length === 4
          || segments.length === 5
          || (isTicketRoute && (segments.length === 6 || segments.length === 7))
          || (isCredentialRoute && (
            segments.length === 6
            || segments.length === 7
            || (segments.length === 8 && resourceAction === 'rotate')
          ))
          || (isBindingRoute && (segments.length === 6 || segments.length === 7));
        if (!validShape) return sendJson(res, 404, { error: 'not found' });
        const permission = isTicketRoute
          ? 'ticket:read'
          : isConnectorRoute
            ? 'source:manage'
            : 'project:read';
        const allowed = authorize({ identity, tenantId, projectId, permission });
        if (!allowed.ok) return sendJson(res, 403, { error: allowed.reason });

        if (isTicketRoute) {
          if (req.method !== 'GET') {
            return sendJson(res, 405, { error: 'method not allowed' });
          }
          if (!ticketStore) {
            return sendJson(res, 501, { error: 'hosted ticket store is not configured' });
          }
          const ticketId = segments[6];
          if (ticketId) {
            const ticket = await readThrough(
              () => ticketStore.getTicket({ tenantId, projectId, ticketId }),
            );
            if (!ticket) return sendJson(res, 404, { error: 'ticket not found' });
            return sendJson(res, 200, { ticket });
          }
          const tickets = await readThrough(() => ticketStore.listTickets({
            tenantId,
            projectId,
            state: url.searchParams.get('state'),
            limit: url.searchParams.get('limit'),
          }));
          return sendJson(res, 200, { tenantId, projectId, tickets });
        }

        if (isConnectorRoute) {
          if (!secretStore || !ingressStore) {
            return sendJson(res, 501, { error: 'hosted connector store is not configured' });
          }
          if (isCredentialRoute) {
            if (req.method === 'GET' && segments.length === 6) {
              const credentials = await readThrough(() => secretStore.listCredentials({
                tenantId,
                projectId,
                includeRevoked: url.searchParams.get('includeRevoked') === 'true',
              }));
              return sendJson(res, 200, { tenantId, projectId, credentials });
            }
            if (req.method === 'POST' && segments.length === 6) {
              const body = await readJsonBody(req);
              const provider = String(body.provider || '').toLowerCase();
              if (!PROVIDERS.has(provider) || !validSecretObject(body.secret)) {
                return sendJson(res, 400, { error: 'provider and secret are required' });
              }
              if (!validScope(body.scope)) {
                return sendJson(res, 400, { error: 'scope must be a JSON object' });
              }
              if (body.expiresAt && !Number.isFinite(Date.parse(body.expiresAt))) {
                return sendJson(res, 400, { error: 'expiresAt must be an ISO timestamp' });
              }
              const credential = await readThrough(() => secretStore.createCredential({
                tenantId,
                projectId,
                provider,
                sourceId: body.sourceId || null,
                displayName: body.displayName || '',
                secret: body.secret,
                scope: body.scope || {},
                expiresAt: body.expiresAt || null,
              }));
              return sendJson(res, 201, { credential });
            }
            if (req.method === 'POST' && segments.length === 8 && resourceAction === 'rotate') {
              const body = await readJsonBody(req);
              if (!validSecretObject(body.secret)) {
                return sendJson(res, 400, { error: 'secret must be a JSON object' });
              }
              if (!validScope(body.scope)) {
                return sendJson(res, 400, { error: 'scope must be a JSON object' });
              }
              if (body.expiresAt && !Number.isFinite(Date.parse(body.expiresAt))) {
                return sendJson(res, 400, { error: 'expiresAt must be an ISO timestamp' });
              }
              const credential = await readThrough(() => secretStore.rotateCredential({
                tenantId,
                projectId,
                credentialId: resourceId,
                secret: body.secret,
                scope: body.scope,
                expiresAt: body.expiresAt || null,
              }));
              if (!credential) return sendJson(res, 404, { error: 'credential not found' });
              return sendJson(res, 200, { credential });
            }
            if (req.method === 'DELETE' && segments.length === 7) {
              const credential = await readThrough(() => secretStore.revokeCredential({
                tenantId,
                projectId,
                credentialId: resourceId,
              }));
              if (!credential) return sendJson(res, 404, { error: 'credential not found' });
              return sendJson(res, 200, { credential });
            }
            return sendJson(res, 405, { error: 'method not allowed' });
          }

          if (req.method === 'GET' && segments.length === 6) {
            const bindings = await readThrough(() => ingressStore.listBindings({
              tenantId,
              projectId,
            }));
            return sendJson(res, 200, { tenantId, projectId, bindings });
          }
          if (req.method === 'POST' && segments.length === 6) {
            const body = await readJsonBody(req);
            const provider = String(body.provider || '').toLowerCase();
            const externalId = String(body.externalId || '').trim();
            if (!PROVIDERS.has(provider) || !externalId) {
              return sendJson(res, 400, { error: 'provider and externalId are required' });
            }
            if (externalId.length > 500) {
              return sendJson(res, 400, { error: 'externalId is too long' });
            }
            if (body.allowedChannels !== undefined && !Array.isArray(body.allowedChannels)) {
              return sendJson(res, 400, { error: 'allowedChannels must be an array' });
            }
            if (body.credentialId) {
              const credential = await readThrough(() => secretStore.getCredentialRecord({
                tenantId,
                projectId,
                credentialId: body.credentialId,
              }));
              if (!credential) {
                return sendJson(res, 400, { error: 'credential does not belong to this project' });
              }
              if (credential.provider !== provider) {
                return sendJson(res, 400, { error: 'credential provider does not match' });
              }
              if (credential.revoked_at) {
                return sendJson(res, 400, { error: 'credential is revoked' });
              }
              if (credential.expires_at && Date.parse(credential.expires_at) <= Date.now()) {
                return sendJson(res, 400, { error: 'credential is expired' });
              }
            }
            const binding = await readThrough(() => ingressStore.createBinding({
              tenantId,
              projectId,
              provider,
              externalId,
              credentialId: body.credentialId || null,
              sourceId: body.sourceId || null,
              allowedChannels: Array.isArray(body.allowedChannels) ? body.allowedChannels : [],
              enabled: body.enabled !== false,
            }));
            if (!binding) {
              return sendJson(res, 409, { error: 'connector binding already exists' });
            }
            return sendJson(res, 201, { binding });
          }
          if (req.method === 'DELETE' && segments.length === 7) {
            const deleted = await readThrough(() => ingressStore.deleteBinding({
              tenantId,
              projectId,
              bindingId: resourceId,
            }));
            if (!deleted) return sendJson(res, 404, { error: 'binding not found' });
            return sendJson(res, 204, null);
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        if (!projectStore) {
          return sendJson(res, 501, { error: 'hosted project store is not configured' });
        }
        if (req.method !== 'GET') {
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        if (projectId) {
          const project = await readThrough(
            () => projectStore.getProject({ tenantId, projectId }),
          );
          if (!project) return sendJson(res, 404, { error: 'project not found' });
          return sendJson(res, 200, { project });
        }
        const projects = await readThrough(() => projectStore.listProjects({ tenantId }));
        return sendJson(res, 200, { tenantId, projects });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.statusCode
        : Number(error?.statusCode) || 400;
      if (status >= 500) {
        console.error(`hosted request failed: ${req.method} ${url.pathname}: ${error.message}`);
        return sendJson(res, status, { error: 'hosted service unavailable' });
      }
      return sendJson(res, status, { error: error.message });
    }
  }

  return handler;
}
