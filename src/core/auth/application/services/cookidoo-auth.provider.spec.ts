import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { Response } from 'express';

import type { AuthConfig } from '@core/config/auth.config';
import { AuthSessionService } from './auth-session.service';
import { CookidooAuthProvider } from './cookidoo-auth.provider';
import { TokenStore } from './token-store.service';

const CONFIG: AuthConfig = {
  enabled: true,
  loginSecret: 'secret',
  publicUrl: 'https://mcp.example.com',
  dataDir: '/unused',
  trustProxy: true,
};

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: ['https://client.example/cb'],
};

function makeProvider() {
  const store = TokenStore.fromFile(
    join(mkdtempSync(join(tmpdir(), 'prov-')), 'auth_store.json'),
  );
  const sessions = new AuthSessionService();
  const provider = new CookidooAuthProvider(store, sessions, CONFIG);
  return { store, sessions, provider };
}

const params: AuthorizationParams = {
  codeChallenge: 'the-challenge',
  redirectUri: 'https://client.example/cb',
  scopes: ['cookidoo'],
  state: 'xyz',
};

describe('CookidooAuthProvider', () => {
  it('registers and reads back a client', async () => {
    const { provider } = makeProvider();
    await provider.clientsStore.registerClient!(CLIENT);
    expect((await provider.clientsStore.getClient('client-1'))?.client_id).toBe(
      'client-1',
    );
  });

  it('authorize redirects to the login page with a txn', async () => {
    const { provider } = makeProvider();
    let location = '';
    const res = {
      redirect: (_s: number, url: string) => (location = url),
    } as unknown as Response;
    await provider.authorize(CLIENT, params, res);
    expect(location).toMatch(/^https:\/\/mcp\.example\.com\/login\?txn=/);
  });

  it('full code→token→verify roundtrip works', async () => {
    const { provider, sessions } = makeProvider();
    const txn = sessions.create('client-1', params);
    const login = sessions.consume(txn)!;
    const code = provider.issueCodeForLogin(login);

    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe(
      'the-challenge',
    );
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
    expect(info.scopes).toEqual(['cookidoo']);
  });

  it('verifyAccessToken throws InvalidTokenError for unknown token', async () => {
    const { provider } = makeProvider();
    await expect(provider.verifyAccessToken('nope')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('refresh token rotates and yields a working access token', async () => {
    const { provider, sessions } = makeProvider();
    const login = sessions.consume(sessions.create('client-1', params))!;
    const first = await provider.exchangeAuthorizationCode(
      CLIENT,
      provider.issueCodeForLogin(login),
    );
    const rotated = await provider.exchangeRefreshToken(
      CLIENT,
      first.refresh_token!,
    );
    expect(rotated.access_token).not.toBe(first.access_token);
    expect(
      (await provider.verifyAccessToken(rotated.access_token)).clientId,
    ).toBe('client-1');
  });
});
