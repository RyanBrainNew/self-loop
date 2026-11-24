import {
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  verifyIdToken,
} from './hosted-oidc.mjs';
import { safeReturnTo } from './hosted-session.mjs';

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Hosted OIDC login orchestration. The service owns no HTTP or database
 * details; stores are injected so the same flow can use PostgreSQL, Redis, or
 * a test fixture. Tokens never leave this object except in the authorization
 * redirect and the short-lived transaction record.
 */
export class HostedAuthService {
  constructor({
    discovery,
    clientId,
    clientSecret = '',
    redirectUri,
    jwks,
    userStore,
    sessionStore,
    transactionStore,
    exchangeCode = exchangeAuthorizationCode,
    verifyToken = verifyIdToken,
    identityResolver = null,
  }) {
    this.discovery = required(discovery, 'discovery');
    this.clientId = required(clientId, 'clientId');
    this.clientSecret = clientSecret;
    this.redirectUri = required(redirectUri, 'redirectUri');
    this.jwks = required(jwks, 'jwks');
    this.userStore = required(userStore, 'userStore');
    this.sessionStore = required(sessionStore, 'sessionStore');
    this.transactionStore = required(transactionStore, 'transactionStore');
    this.exchangeCode = exchangeCode;
    this.verifyToken = verifyToken;
    this.identityResolver = identityResolver;
  }

  async beginLogin({ returnTo = '/' } = {}) {
    const pkce = createPkcePair();
    const state = createState();
    const nonce = createState();
    const transaction = await this.transactionStore.create({
      state,
      nonce,
      verifier: pkce.verifier,
      returnTo: safeReturnTo(returnTo),
    });
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: this.discovery.authorization_endpoint,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.method,
      extra: { nonce },
    });
    return {
      authorizationUrl,
      transactionToken: transaction.token,
      expiresAt: transaction.expiresAt,
    };
  }

  async completeLogin({ code, state, transactionToken } = {}) {
    if (!code || !state || !transactionToken) {
      throw new Error('OIDC callback requires code, state, and transaction token');
    }
    const transaction = await this.transactionStore.take({
      state,
      token: transactionToken,
    });
    if (!transaction) throw new Error('OIDC login state is invalid or expired');

    const tokens = await this.exchangeCode({
      tokenEndpoint: this.discovery.token_endpoint,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      code,
      codeVerifier: transaction.verifier,
      redirectUri: this.redirectUri,
    });
    const jwks = typeof this.jwks === 'function' ? await this.jwks() : this.jwks;
    const verified = this.verifyToken(tokens.id_token, {
      issuer: this.discovery.issuer,
      audience: this.clientId,
      jwks,
      nonce: transaction.nonce,
    });
    const claims = verified.claims;
    const identity = await this.userStore.upsertIdentity({
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email || '',
      displayName: claims.name || claims.preferred_username || claims.email || claims.sub,
      claims,
    });
    const session = await this.sessionStore.create(identity);
    return {
      identity,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      returnTo: safeReturnTo(transaction.returnTo),
    };
  }

  async currentIdentity(sessionToken) {
    const session = await this.sessionStore.get(sessionToken);
    if (!session) return null;
    if (typeof this.identityResolver !== 'function') return session;
    const current = await this.identityResolver(session);
    if (!current) {
      await this.sessionStore.delete(sessionToken);
      return null;
    }
    return current;
  }

  async logout(sessionToken) {
    return this.sessionStore.delete(sessionToken);
  }
}
