import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';

const ALLOWED_ALGORITHMS = new Set(['RS256', 'ES256']);

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodePart(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OIDC request failed: ${response.status} ${body.error || body.message || ''}`.trim());
  }
  return body;
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function createState() {
  return randomBytes(24).toString('base64url');
}

export async function discoverOidc(issuer) {
  const base = String(issuer || '').replace(/\/+$/, '');
  if (!base) throw new Error('OIDC issuer is required');
  const document = await fetchJson(`${base}/.well-known/openid-configuration`);
  assertObject(document, 'invalid OIDC discovery document');
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof document[field] !== 'string' || !document[field]) {
      throw new Error(`OIDC discovery is missing ${field}`);
    }
  }
  if (String(document.issuer).replace(/\/+$/, '') !== base) {
    throw new Error('OIDC discovery issuer does not match the requested issuer');
  }
  return document;
}

export async function fetchJwks(jwksUri) {
  const document = await fetchJson(jwksUri);
  assertObject(document, 'invalid JWKS document');
  if (!Array.isArray(document.keys)) throw new Error('JWKS document is missing keys');
  return document;
}

export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  codeChallengeMethod = 'S256',
  scope = 'openid email profile',
  extra = {},
} = {}) {
  if (!authorizationEndpoint || !clientId || !redirectUri || !state || !codeChallenge) {
    throw new Error('authorizationEndpoint, clientId, redirectUri, state, and codeChallenge are required');
  }
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', codeChallengeMethod);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function exchangeAuthorizationCode({
  tokenEndpoint,
  clientId,
  clientSecret = '',
  code,
  codeVerifier,
  redirectUri,
} = {}) {
  if (!tokenEndpoint || !clientId || !code || !codeVerifier || !redirectUri) {
    throw new Error('tokenEndpoint, clientId, code, codeVerifier, and redirectUri are required');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const tokens = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  assertObject(tokens, 'invalid OIDC token response');
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) {
    throw new Error('OIDC token response is missing id_token');
  }
  return tokens;
}

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid JWT');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  assertObject(header, 'invalid JWT header');
  assertObject(payload, 'invalid JWT payload');
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function verifySignatureFor(header, signingInput, signature, jwk) {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const input = Buffer.from(signingInput);
  if (header.alg === 'RS256') {
    return verifySignature('RSA-SHA256', input, key, signature);
  }
  if (header.alg === 'ES256') {
    return verifySignature(
      'sha256',
      input,
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  }
  return false;
}

export function verifyIdToken(token, {
  issuer,
  audience,
  jwks,
  now = Date.now(),
  nonce = null,
  clockSkewSeconds = 60,
} = {}) {
  if (!issuer || !audience || !jwks) {
    throw new Error('issuer, audience, and jwks are required');
  }
  const decoded = decodeJwt(token);
  const { header, payload, signingInput, signature } = decoded;
  if (!ALLOWED_ALGORITHMS.has(header.alg)) {
    throw new Error(`unsupported JWT algorithm: ${header.alg || 'missing'}`);
  }
  const candidates = (jwks.keys || []).filter(
    (key) => key.kty && (!header.kid || key.kid === header.kid),
  );
  if (!candidates.length) throw new Error('no JWKS key matches the JWT kid');
  const verified = candidates.some((key) => {
    try {
      return verifySignatureFor(header, signingInput, signature, key);
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error('JWT signature verification failed');
  if (String(payload.iss || '').replace(/\/+$/, '') !== String(issuer).replace(/\/+$/, '')) {
    throw new Error('JWT issuer mismatch');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw new Error('JWT audience mismatch');
  const nowSeconds = Math.floor(now / 1000);
  const skew = Math.max(0, Number(clockSkewSeconds) || 0);
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) + skew < nowSeconds) {
    throw new Error('JWT is expired');
  }
  if (payload.nbf !== undefined && Number(payload.nbf) - skew > nowSeconds) {
    throw new Error('JWT is not active yet');
  }
  if (nonce !== null && payload.nonce !== nonce) {
    throw new Error('JWT nonce mismatch');
  }
  return { header, claims: payload };
}

export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('base64url');
}

export { base64url };
