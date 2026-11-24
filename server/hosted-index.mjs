#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { HostedAuthService } from './hosted-auth.mjs';
import { createHostedHandler } from './hosted-http.mjs';
import {
  PgProjectStore,
  PgTicketStore,
  PgUserStore,
  createPgLoginTransactionStore,
  createPgSessionStore,
} from './hosted-pg.mjs';
import { discoverOidc, fetchJwks } from './hosted-oidc.mjs';

function requiredEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for hosted mode`);
  return value;
}

function optionalEnv(env, name, fallback = '') {
  return String(env[name] || fallback).trim();
}

function allowedOriginsFrom(env, redirectUri) {
  const configured = optionalEnv(env, 'HOSTED_ALLOWED_ORIGINS');
  if (configured) {
    return configured
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [new URL(redirectUri).origin];
}

function jwksLoader(jwksUri, ttlMs = 5 * 60 * 1000) {
  let cached = null;
  let fetchedAt = 0;
  return async () => {
    if (cached && Date.now() - fetchedAt < ttlMs) return cached;
    cached = await fetchJwks(jwksUri);
    fetchedAt = Date.now();
    return cached;
  };
}

async function loadPool(env, databaseUrl) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      "Hosted mode requires the optional 'pg' package. Run `npm install pg` in the deployment image.",
    );
  }
  const Pool = pg.Pool || pg.default?.Pool;
  if (!Pool) throw new Error("the installed 'pg' package does not export Pool");
  const sslMode = optionalEnv(env, 'HOSTED_DATABASE_SSL');
  return new Pool({
    connectionString: databaseUrl,
    max: Number(optionalEnv(env, 'HOSTED_DATABASE_POOL', '10')) || 10,
    ssl: sslMode
      ? { rejectUnauthorized: sslMode !== 'no-verify' }
      : undefined,
  });
}

export async function startHostedServer(env = process.env) {
  const issuer = requiredEnv(env, 'HOSTED_ISSUER');
  const clientId = requiredEnv(env, 'HOSTED_CLIENT_ID');
  const redirectUri = requiredEnv(env, 'HOSTED_REDIRECT_URI');
  const databaseUrl = requiredEnv(env, 'DATABASE_URL');

  const redirect = new URL(redirectUri);
  if (!['http:', 'https:'].includes(redirect.protocol)) {
    throw new Error('HOSTED_REDIRECT_URI must be an absolute http(s) URL');
  }
  const localRedirect = ['127.0.0.1', 'localhost', '::1'].includes(redirect.hostname);
  if (redirect.protocol !== 'https:' && !localRedirect) {
    throw new Error('HOSTED_REDIRECT_URI must use https outside localhost');
  }

  const discovery = await discoverOidc(issuer);
  const pool = await loadPool(env, databaseUrl);
  const userStore = new PgUserStore({ pool });
  const projectStore = new PgProjectStore({ pool });
  const ticketStore = new PgTicketStore({ pool });
  const authService = new HostedAuthService({
    discovery,
    clientId,
    clientSecret: String(env.HOSTED_CLIENT_SECRET || ''),
    redirectUri,
    jwks: jwksLoader(discovery.jwks_uri),
    userStore,
    sessionStore: createPgSessionStore({ pool }),
    transactionStore: createPgLoginTransactionStore({ pool }),
    identityResolver: (session) => userStore.getIdentity(session.id),
  });
  const handler = createHostedHandler({
    authService,
    projectStore,
    ticketStore,
    secureCookies: String(env.HOSTED_SECURE_COOKIES || '')
      ? env.HOSTED_SECURE_COOKIES === 'true'
      : !localRedirect,
    allowedOrigins: allowedOriginsFrom(env, redirectUri),
  });
  const host = String(env.HOSTED_HOST || '127.0.0.1').trim();
  const port = Number(env.HOSTED_PORT || 4327);
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    pool,
    host,
    port: server.address().port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startHostedServer()
    .then((runtime) => {
      console.log(JSON.stringify({
        mode: 'hosted',
        listening: `http://${runtime.host}:${runtime.port}`,
        login: '/auth/login',
      }));
      const stop = async () => {
        await runtime.close();
        process.exit(0);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error) => {
      console.error(`hosted startup failed: ${error.message}`);
      process.exit(1);
    });
}
