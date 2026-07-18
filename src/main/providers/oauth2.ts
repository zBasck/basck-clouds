/**
 * Helper OAuth 2.0 com PKCE usado por todos os provedores que seguem
 * o fluxo padrão de autorização (Google, Microsoft, Dropbox, Box, etc.).
 */
import { randomBytes, createHash } from 'node:crypto';
import { httpRequestAuto } from './http-client';
import type { OAuthCallbackResult } from './types';

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
  usePKCE: boolean;
}

export interface OAuthState {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  config: OAuthConfig;
}

export function createOAuthState(config: OAuthConfig): OAuthState {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
    state: randomBytes(16).toString('hex'),
    config,
  };
}

export function buildAuthorizeUrl(state: OAuthState): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: state.config.clientId,
    redirect_uri: state.config.redirectUri,
    scope: state.config.scopes.join(' '),
    state: state.state,
  });
  if (state.config.usePKCE) {
    params.set('code_challenge', state.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${state.config.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(state: OAuthState, code: string): Promise<OAuthCallbackResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: state.config.clientId,
    redirect_uri: state.config.redirectUri,
  });
  if (state.config.clientSecret) body.set('client_secret', state.config.clientSecret);
  if (state.config.usePKCE) body.set('code_verifier', state.codeVerifier);

  const res = await httpRequestAuto(state.config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return parseTokenResponse(res.body);
}

export async function refreshToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthCallbackResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  const res = await httpRequestAuto(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return parseTokenResponse(res.body, refreshToken);
}

function parseTokenResponse(body: Buffer, fallbackRefresh?: string): OAuthCallbackResult {
  const json = JSON.parse(body.toString('utf8'));
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallbackRefresh,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scope: json.scope,
  };
}
