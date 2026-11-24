import { clearCookie, parseCookieHeader, serializeCookie } from './hosted-session.mjs';
import { authorize } from './hosted-rbac.mjs';

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

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
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'tenants') {
        const identity = await requireIdentity();
        const tenantId = segments[2];
        const projectId = segments[4];
        if (!tenantId || segments[3] !== 'projects') {
          return sendJson(res, 404, { error: 'not found' });
        }
        const isTicketRoute = segments[5] === 'tickets';
        const validShape = segments.length === 4
          || segments.length === 5
          || (isTicketRoute && (segments.length === 6 || segments.length === 7));
        if (!validShape) return sendJson(res, 404, { error: 'not found' });
        const permission = isTicketRoute ? 'ticket:read' : 'project:read';
        const allowed = authorize({ identity, tenantId, projectId, permission });
        if (!allowed.ok) return sendJson(res, 403, { error: allowed.reason });

        if (isTicketRoute) {
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

        if (!projectStore) {
          return sendJson(res, 501, { error: 'hosted project store is not configured' });
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
      const status = error instanceof HttpError ? error.statusCode : 400;
      if (status >= 500) {
        console.error(`hosted request failed: ${req.method} ${url.pathname}: ${error.message}`);
        return sendJson(res, status, { error: 'hosted service unavailable' });
      }
      return sendJson(res, status, { error: error.message });
    }
  }

  return handler;
}
