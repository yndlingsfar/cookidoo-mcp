import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenStore } from './token-store.service';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'cookidoo-auth-')), 'auth_store.json');
}

describe('TokenStore', () => {
  it('starts empty when no file exists', () => {
    const store = TokenStore.fromFile(tmpFile());
    expect(store.clients).toEqual({});
    expect(store.access).toEqual({});
  });

  it('persists atomically with 0600 permissions', () => {
    const path = tmpFile();
    const store = TokenStore.fromFile(path);
    store.access['tok'] = {
      token: 'tok',
      clientId: 'c1',
      scopes: ['cookidoo'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    store.save();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const reloaded = TokenStore.fromFile(path);
    expect(reloaded.access['tok']?.clientId).toBe('c1');
  });

  it('prunes expired entries on save', () => {
    const path = tmpFile();
    const store = TokenStore.fromFile(path);
    const past = Math.floor(Date.now() / 1000) - 10;
    store.access['old'] = {
      token: 'old',
      clientId: 'c',
      scopes: [],
      expiresAt: past,
    };
    store.save();
    expect(TokenStore.fromFile(path).access['old']).toBeUndefined();
  });

  it('recovers from a corrupt file by starting empty and moving it aside', () => {
    const path = tmpFile();
    writeFileSync(path, '{ this is : not json');
    const store = TokenStore.fromFile(path);
    expect(store.clients).toEqual({});
    // corrupt file wurde beiseitegelegt
    expect(() => readFileSync(`${path}.corrupt`)).not.toThrow();
  });

  it('activeClientIds reflects access + refresh tokens', () => {
    const store = TokenStore.fromFile(tmpFile());
    const future = Math.floor(Date.now() / 1000) + 3600;
    store.access['a'] = {
      token: 'a',
      clientId: 'c1',
      scopes: [],
      expiresAt: future,
    };
    store.refresh['r'] = {
      token: 'r',
      clientId: 'c2',
      scopes: [],
      expiresAt: future,
    };
    expect(store.activeClientIds()).toEqual(new Set(['c1', 'c2']));
  });
});
