import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  decodeJwt,
  discoverOidc,
  exchangeAuthorizationCode,
  fetchJwks,
  verifyIdToken,
} from './hosted-oidc.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

function jwt(claims, { kid = 'test-key', alg = 'RS256' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

async function oidcFixture() {
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
      }));
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('code') !== 'code-1' || form.get('code_verifier') !== 'verifier-1') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'access-1',
          id_token: jwt({
            iss: base,
            aud: 'self-loop',
            sub: 'user-1',
            exp: Math.floor(Date.now() / 1000) + 300,
            nonce: 'nonce-1',
          }),
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('OIDC discovery, PKCE, and token exchange are standard-compliant', async () => {
  const fixture = await oidcFixture();
  try {
    const discovery = await discoverOidc(fixture.base);
    assert.equal(discovery.issuer, fixture.base);
    const jwks = await fetchJwks(discovery.jwks_uri);
    assert.equal(jwks.keys.length, 1);

    const pkce = createPkcePair();
    const state = createState();
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: 'self-loop',
      redirectUri: `${fixture.base}/auth/callback`,
      state,
      codeChallenge: pkce.challenge,
    }));
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
    assert.equal(pkce.challenge, createHash('sha256')
      .update(pkce.verifier)
      .digest('base64url'));

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: 'self-loop',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: `${fixture.base}/auth/callback`,
    });
    assert.equal(tokens.access_token, 'access-1');
    assert.equal(decodeJwt(tokens.id_token).payload.sub, 'user-1');
  } finally {
    await fixture.close();
  }
});

test('ID Token verification rejects tampering, wrong audience, and expiry', async () => {
  const fixture = await oidcFixture();
  try {
    const discovery = await discoverOidc(fixture.base);
    const jwks = await fetchJwks(discovery.jwks_uri);
    const valid = jwt({
      iss: fixture.base,
      aud: ['self-loop', 'another'],
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: 'nonce-1',
    });
    const result = verifyIdToken(valid, {
      issuer: discovery.issuer,
      audience: 'self-loop',
      jwks,
      nonce: 'nonce-1',
    });
    assert.equal(result.claims.sub, 'user-1');

    assert.throws(() => verifyIdToken(`${valid}x`, {
      issuer: discovery.issuer,
      audience: 'self-loop',
      jwks,
    }), /signature|invalid/i);
    assert.throws(() => verifyIdToken(jwt({
      iss: fixture.base,
      aud: 'other',
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) + 300,
    }), {
      issuer: discovery.issuer,
      audience: 'self-loop',
      jwks,
    }), /audience/);
    assert.throws(() => verifyIdToken(jwt({
      iss: fixture.base,
      aud: 'self-loop',
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) - 300,
    }), {
      issuer: discovery.issuer,
      audience: 'self-loop',
      jwks,
    }), /expired/);
    assert.throws(() => verifyIdToken(valid, {
      issuer: discovery.issuer,
      audience: 'self-loop',
      jwks,
      nonce: 'wrong',
    }), /nonce/);
  } finally {
    await fixture.close();
  }
});

test('ES256 ID Tokens verify with an EC JWKS key', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256',
    typ: 'JWT',
    kid: 'ec-key',
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://issuer.example',
    aud: 'self-loop',
    sub: 'user-ec',
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign(
    'sha256',
    Buffer.from(input),
    { key: ec.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  const jwk = ec.publicKey.export({ format: 'jwk' });
  jwk.kid = 'ec-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const result = verifyIdToken(`${input}.${signature}`, {
    issuer: 'https://issuer.example',
    audience: 'self-loop',
    jwks: { keys: [jwk] },
  });
  assert.equal(result.claims.sub, 'user-ec');
});
