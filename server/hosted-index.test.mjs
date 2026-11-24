import assert from 'node:assert/strict';
import test from 'node:test';
import { startHostedServer } from './hosted-index.mjs';

test('hosted server fails fast without OIDC and database configuration', async () => {
  await assert.rejects(
    () => startHostedServer({}),
    /HOSTED_ISSUER is required/,
  );
  await assert.rejects(
    () => startHostedServer({
      HOSTED_ISSUER: 'https://issuer.example',
    }),
    /HOSTED_CLIENT_ID is required/,
  );
  await assert.rejects(
    () => startHostedServer({
      HOSTED_ISSUER: 'https://issuer.example',
      HOSTED_CLIENT_ID: 'self-loop',
    }),
    /HOSTED_REDIRECT_URI is required/,
  );
  await assert.rejects(
    () => startHostedServer({
      HOSTED_ISSUER: 'https://issuer.example',
      HOSTED_CLIENT_ID: 'self-loop',
      HOSTED_REDIRECT_URI: 'https://console.example/auth/callback',
    }),
    /DATABASE_URL is required/,
  );
});

test('hosted server rejects insecure non-local redirect URIs', async () => {
  await assert.rejects(
    () => startHostedServer({
      HOSTED_ISSUER: 'https://issuer.example',
      HOSTED_CLIENT_ID: 'self-loop',
      HOSTED_REDIRECT_URI: 'http://console.example/auth/callback',
      DATABASE_URL: 'postgres://localhost/self_loop',
    }),
    /must use https outside localhost/,
  );
});
