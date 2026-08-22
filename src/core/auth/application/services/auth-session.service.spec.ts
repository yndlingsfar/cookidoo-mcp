import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import { AuthSessionService } from './auth-session.service';

const params: AuthorizationParams = {
  codeChallenge: 'chal',
  redirectUri: 'https://client.example/cb',
  scopes: ['cookidoo'],
  state: 'st',
};

describe('AuthSessionService', () => {
  it('creates and retrieves a login by txn', () => {
    const svc = new AuthSessionService();
    const txn = svc.create('client-1', params);
    expect(typeof txn).toBe('string');
    expect(svc.get(txn)?.clientId).toBe('client-1');
  });

  it('consume returns the login once and removes it', () => {
    const svc = new AuthSessionService();
    const txn = svc.create('client-1', params);
    expect(svc.consume(txn)?.clientId).toBe('client-1');
    expect(svc.get(txn)).toBeUndefined();
  });

  it('caps the number of open logins at MAX_OPEN_LOGINS', () => {
    const svc = new AuthSessionService();
    for (let i = 0; i < 600; i++) svc.create(`c${i}`, params);
    expect(svc.size()).toBeLessThanOrEqual(500);
  });
});
