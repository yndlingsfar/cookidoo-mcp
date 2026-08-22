import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import type { AuthConfig } from '@core/config/auth.config';
import { AuthSessionService } from '@core/auth/application/services/auth-session.service';
import { CookidooAuthProvider } from '@core/auth/application/services/cookidoo-auth.provider';
import { LoginRateLimiter } from '@core/auth/application/services/login-rate-limiter.service';
import { TokenStore } from '@core/auth/application/services/token-store.service';
import { LoginService, buildRedirectUri } from './login.service';

const CONFIG: AuthConfig = {
  enabled: true,
  loginSecret: 'correct horse',
  publicUrl: 'https://mcp.example.com',
  dataDir: '/unused',
  trustProxy: true,
};

const params: AuthorizationParams = {
  codeChallenge: 'chal',
  redirectUri: 'https://client.example/cb',
  scopes: ['cookidoo'],
  state: 'st-1',
};

function make() {
  const store = TokenStore.fromFile(
    join(mkdtempSync(join(tmpdir(), 'login-')), 'auth_store.json'),
  );
  const sessions = new AuthSessionService();
  const rl = new LoginRateLimiter();
  const provider = new CookidooAuthProvider(store, sessions, CONFIG);
  const svc = new LoginService(sessions, rl, provider, store, CONFIG);
  return { store, sessions, rl, provider, svc };
}

describe('buildRedirectUri', () => {
  it('appends code and state as query params', () => {
    const url = buildRedirectUri('https://client.example/cb', 'CODE', 'STATE');
    expect(url).toBe('https://client.example/cb?code=CODE&state=STATE');
  });
});

describe('LoginService', () => {
  it('renders the login page for a valid txn (escaping the redirect target)', () => {
    const { svc, sessions } = make();
    const txn = sessions.create('client-1', params);
    const out = svc.renderLoginPage(txn);
    expect(out.status).toBe(200);
    expect(out.html).toContain('client.example/cb');
  });

  it('returns 400 for an unknown txn', () => {
    const { svc } = make();
    expect(svc.renderLoginPage('nope').status).toBe(400);
  });

  it('correct passphrase issues a code and redirects to the client', async () => {
    const { svc, sessions } = make();
    const txn = sessions.create('client-1', params);
    const out = await svc.handleLogin({
      txn,
      phrase: 'correct horse',
      ip: '1.1.1.1',
    });
    expect(out.status).toBe(302);
    expect(out.redirectUrl).toMatch(
      /^https:\/\/client\.example\/cb\?code=.+&state=st-1$/,
    );
  });

  it('wrong passphrase returns 403 and counts as a failure', async () => {
    const { svc, sessions, rl } = make();
    const txn = sessions.create('client-1', params);
    const out = await svc.handleLogin({ txn, phrase: 'wrong', ip: '2.2.2.2' });
    expect(out.status).toBe(403);
    expect(rl.isBlocked('2.2.2.2')).toBe(false); // erst nach 5
  });

  it('blocks with 429 after too many failures', async () => {
    const { svc, sessions, rl } = make();
    for (let i = 0; i < 5; i++) rl.recordFailure('3.3.3.3');
    const txn = sessions.create('client-1', params);
    const out = await svc.handleLogin({
      txn,
      phrase: 'whatever',
      ip: '3.3.3.3',
    });
    expect(out.status).toBe(429);
  });
});
