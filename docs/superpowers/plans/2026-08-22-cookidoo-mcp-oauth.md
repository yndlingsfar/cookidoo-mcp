# Cookidoo-MCP OAuth-Türsteher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einen OAuth-2.0-Türsteher (DCR + PKCE + Passphrase-Login) additiv in den Cookidoo-MCP-Fork einbauen, sodass `POST /api/mcp` nur mit gültigem Bearer-Token erreichbar ist und der Server als claude.ai-Custom-Connector hinter einem Cloudflare-Tunnel sicher öffentlich betrieben werden kann.

**Architecture:** Das `@modelcontextprotocol/sdk` (1.30.0) liefert die OAuth-Protokoll-Endpunkte via `mcpAuthRouter` und die Bearer-Prüfung via `requireBearerAuth`. Wir implementieren nur den `OAuthServerProvider` (persistenter JSON-Token-Store im `/data`-Volume), eine Passphrase-Login-Seite und die Verdrahtung in NestJS/Express — eine 1:1-Portierung des bewährten `ynab-mcp/auth.py`. Alles liegt in einem neuen, isolierten Modul `src/core/auth/`; bestehender Code (Tools, CQRS, Cookidoo-Client) bleibt unangetastet.

**Tech Stack:** NestJS 11, Express 5, `@modelcontextprotocol/sdk` ^1.29 (installiert: 1.30.0), Zod 4, Jest 30 + supertest, TypeScript. Node 24 (`.nvmrc`), pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-22-cookidoo-mcp-oauth-design.md`

## Global Constraints

- **Auth-Aktivierung:** Der Türsteher ist NUR aktiv, wenn `MCP_LOGIN_SECRET` UND `MCP_PUBLIC_URL` gesetzt sind. Ohne beide startet der Server wie Upstream ohne Auth (Backward-Compat, lokale Entwicklung).
- **SDK-Importe (ESM-Subpaths, exakt so):** `@modelcontextprotocol/sdk/server/auth/router.js` (`mcpAuthRouter`, `getOAuthProtectedResourceMetadataUrl`), `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js` (`requireBearerAuth`), `@modelcontextprotocol/sdk/server/auth/provider.js` (Typen `OAuthServerProvider`, `AuthorizationParams`), `@modelcontextprotocol/sdk/server/auth/errors.js` (`InvalidTokenError`, `InvalidGrantError`), `@modelcontextprotocol/sdk/shared/auth.js` (Typen `OAuthClientInformationFull`, `OAuthTokens`, `OAuthTokenRevocationRequest`), `@modelcontextprotocol/sdk/server/auth/types.js` (Typ `AuthInfo`).
- **Provider-Kontrakt (aus dem SDK, verbatim):**
  - `clientsStore.getClient(clientId): OAuthClientInformationFull | undefined | Promise<...>`
  - `clientsStore.registerClient(client): OAuthClientInformationFull | Promise<...>` — die Library erzeugt `client_id`/`client_secret` selbst und übergibt das VOLLE Objekt; wir speichern nur.
  - `authorize(client, params: AuthorizationParams, res: express.Response): Promise<void>` — MUSS selbst per `res` weiterleiten.
  - `challengeForAuthorizationCode(client, authorizationCode: string): Promise<string>` — gibt den gespeicherten `codeChallenge` zurück (PKCE validiert das SDK lokal).
  - `exchangeAuthorizationCode(client, authorizationCode: string, codeVerifier?, redirectUri?, resource?): Promise<OAuthTokens>`
  - `exchangeRefreshToken(client, refreshToken: string, scopes?, resource?): Promise<OAuthTokens>`
  - `verifyAccessToken(token: string): Promise<AuthInfo>` — bei ungültig/abgelaufen `throw new InvalidTokenError(...)`.
  - `revokeToken?(client, request: OAuthTokenRevocationRequest): Promise<void>`
  - `AuthorizationParams = { state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: URL }`
  - `AuthInfo = { token: string; clientId: string; scopes: string[]; expiresAt?: number; resource?: URL; extra?: Record<string, unknown> }`
  - `OAuthTokens = { access_token: string; token_type: string; expires_in?: number; scope?: string; refresh_token?: string; id_token?: string }`
- **Sicherheits-Parität (aus `auth.py`, nicht verhandelbar):** atomare Store-Writes (`tmp`→`rename`) + `chmod 0o600`; korrupte Store-Datei beiseitelegen statt Crash; `crypto.timingSafeEqual` für die Passphrase; Bruteforce-Bremse (5 Fehlversuche/300 s/IP → 429, ~1 s Verzögerung/Fehlversuch); IP = LETZTER Eintrag aus `X-Forwarded-For`; Consent-Seite mit HTML-escaptem Client-Namen + Redirect-Ziel; Caps `MAX_CLIENTS=200`, `MAX_OPEN_LOGINS=500`; TTLs Access 3600 s, Refresh 30 d, Code 300 s, Login 600 s.
- **Kein `Date.now`-Verbot hier** (das gilt nur für Workflow-Skripte) — in App-Code ist `Date.now()` erlaubt und wird für TTLs genutzt.
- **Repo-Konventionen:** Zod für Env-Validierung (`src/core/config/env.validation.ts`), `registerAs` für Config-Namespaces, ein `@Module` je Bounded Context, Winston-`Logger`. Prettier/ESLint laufen via husky pre-commit; `HUSKY=0` nur in Docker.

---

### Task 1: Auth-Konfiguration, Konstanten & Env-Validierung

**Files:**
- Create: `src/core/config/auth.config.ts`
- Create: `src/core/auth/domain/constants/auth.constants.ts`
- Modify: `src/core/config/env.validation.ts` (Schema um Auth-Vars + Refinement erweitern; DE-Defaults im Doc-Kommentar)
- Modify: `src/app.module.ts` (`authConfig` in `ConfigModule.forRoot({ load: [...] })` ergänzen)
- Test: `src/core/config/env.validation.spec.ts` (bestehend erweitern)

**Interfaces:**
- Produces: `authConfig` (registerAs `'auth'`) → `AuthConfig { enabled: boolean; loginSecret: string; publicUrl: string; dataDir: string; trustProxy: boolean }`. `AuthConfig` als exportiertes Interface.
- Produces: Konstanten `ACCESS_TTL_S=3600`, `REFRESH_TTL_S=2592000`, `CODE_TTL_S=300`, `LOGIN_TTL_S=600`, `MAX_LOGIN_FAILURES=5`, `LOGIN_FAILURE_WINDOW_S=300`, `LOGIN_DELAY_MS=1000`, `MAX_OPEN_LOGINS=500`, `MAX_CLIENTS=200`, `DEFAULT_SCOPES=['cookidoo']`.

- [ ] **Step 1: Failing test — Env-Refinement**

In `src/core/config/env.validation.spec.ts` ergänzen:

```typescript
describe('auth env refinement', () => {
  const base = {
    COOKIDOO_EMAIL: 'a@b.de',
    COOKIDOO_PASSWORD: 'x',
  };

  it('accepts config with neither auth var set (auth disabled)', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('accepts config with both auth vars set', () => {
    expect(() =>
      validateEnv({
        ...base,
        MCP_LOGIN_SECRET: 'supersecret',
        MCP_PUBLIC_URL: 'https://cookidoo-mcp.example.com',
      }),
    ).not.toThrow();
  });

  it('rejects config with only MCP_PUBLIC_URL set', () => {
    expect(() =>
      validateEnv({ ...base, MCP_PUBLIC_URL: 'https://x.example.com' }),
    ).toThrow(/MCP_LOGIN_SECRET/);
  });

  it('rejects a non-https MCP_PUBLIC_URL', () => {
    expect(() =>
      validateEnv({
        ...base,
        MCP_LOGIN_SECRET: 's',
        MCP_PUBLIC_URL: 'http://insecure.example.com',
      }),
    ).toThrow(/https/);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm jest src/core/config/env.validation.spec.ts -t "auth env refinement"`
Expected: FAIL (neue Regeln existieren noch nicht).

- [ ] **Step 3: Extend `env.validation.ts`**

Im `baseEnvSchema` diese Felder ergänzen (nach den `COOKIDOO_*`-Feldern):

```typescript
  MCP_LOGIN_SECRET: z.string().trim().min(1).optional(),
  MCP_PUBLIC_URL: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('https://'), 'MCP_PUBLIC_URL must use https')
    .optional(),
  MCP_DATA_DIR: z.string().trim().min(1).optional(),
  MCP_TRUST_PROXY: z
    .enum(['true', 'false'])
    .optional(),
```

Danach `baseEnvSchema` in ein `z.object({...}).superRefine(...)` wandeln — konkret die bestehende `const baseEnvSchema = z.object({ ... });` ersetzen durch `const baseEnvSchema = z.object({ ... }).superRefine((cfg, ctx) => { ... });` mit:

```typescript
  .superRefine((cfg, ctx) => {
    const hasSecret = !!cfg.MCP_LOGIN_SECRET;
    const hasUrl = !!cfg.MCP_PUBLIC_URL;
    if (hasSecret !== hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasSecret ? 'MCP_PUBLIC_URL' : 'MCP_LOGIN_SECRET'],
        message:
          'MCP_LOGIN_SECRET and MCP_PUBLIC_URL must be set together to enable auth',
      });
    }
  });
```

(Zod 4: `z.ZodIssueCode.custom` ist gültig; falls der Typ meckert, `code: 'custom'` als String verwenden.)

- [ ] **Step 4: Run test — verify it passes**

Run: `pnpm jest src/core/config/env.validation.spec.ts`
Expected: PASS (alle, inkl. bestehende).

- [ ] **Step 5: Create `auth.constants.ts`**

```typescript
// src/core/auth/domain/constants/auth.constants.ts
/** Token- und Session-Lebensdauern sowie Missbrauchs-Limits des Türstehers. */
export const ACCESS_TTL_S = 3600; // Access-Token: 1 Stunde
export const REFRESH_TTL_S = 30 * 24 * 3600; // Refresh-Token: 30 Tage
export const CODE_TTL_S = 300; // Authorization-Code: 5 Minuten
export const LOGIN_TTL_S = 600; // offener Login-Vorgang: 10 Minuten

export const MAX_LOGIN_FAILURES = 5; // Fehlversuche pro IP...
export const LOGIN_FAILURE_WINDOW_S = 300; // ...in diesem Fenster -> Sperre
export const LOGIN_DELAY_MS = 1000; // künstliche Bremse pro Fehlversuch

export const MAX_OPEN_LOGINS = 500; // gleichzeitig offene Logins (RAM)
export const MAX_CLIENTS = 200; // gespeicherte Clients (Disk)

export const DEFAULT_SCOPES = ['cookidoo'];
```

- [ ] **Step 6: Create `auth.config.ts`**

```typescript
// src/core/config/auth.config.ts
import { registerAs } from '@nestjs/config';

export interface AuthConfig {
  /** true, wenn Passphrase + Public-URL gesetzt sind. */
  readonly enabled: boolean;
  readonly loginSecret: string;
  /** Öffentliche Basis-URL, ohne Trailing-Slash. */
  readonly publicUrl: string;
  /** Verzeichnis für auth_store.json (Volume in Produktion). */
  readonly dataDir: string;
  /** Express `trust proxy` — hinter cloudflared true. */
  readonly trustProxy: boolean;
}

export const authConfig = registerAs('auth', (): AuthConfig => {
  const loginSecret = process.env.MCP_LOGIN_SECRET?.trim() ?? '';
  const publicUrl = (process.env.MCP_PUBLIC_URL?.trim() ?? '').replace(/\/$/, '');
  return {
    enabled: !!loginSecret && !!publicUrl,
    loginSecret,
    publicUrl,
    dataDir: process.env.MCP_DATA_DIR?.trim() || '/data',
    trustProxy: (process.env.MCP_TRUST_PROXY?.trim() ?? 'true') !== 'false',
  };
});
```

- [ ] **Step 7: Register config in `app.module.ts`**

Import ergänzen und `load`-Array erweitern:

```typescript
import { authConfig } from '@core/config/auth.config';
// ...
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [cookidooConfig, otelConfig, authConfig],
      cache: true,
    }),
```

- [ ] **Step 8: Run full config tests + commit**

Run: `pnpm jest src/core/config`
Expected: PASS.

```bash
git add src/core/config/auth.config.ts src/core/auth/domain/constants/auth.constants.ts src/core/config/env.validation.ts src/core/config/env.validation.spec.ts src/app.module.ts
git commit -m "feat(auth): config, constants and env validation for OAuth türsteher"
```

---

### Task 2: Auth-Typen & persistenter TokenStore

**Files:**
- Create: `src/core/auth/domain/types/auth-store.types.ts`
- Create: `src/core/auth/application/services/token-store.service.ts`
- Test: `src/core/auth/application/services/token-store.service.spec.ts`

**Interfaces:**
- Consumes: Konstanten aus Task 1 (indirekt); `OAuthClientInformationFull` aus dem SDK.
- Produces:
  - Typen `CodeEntry`, `TokenEntry`, `StoreData` (siehe Code).
  - `@Injectable() TokenStore` mit: Gettern `clients`, `codes`, `access`, `refresh` (mutable Records), `save(): void`, `activeClientIds(): Set<string>`. Konstruktor liest `AuthConfig.dataDir` via `@Inject(authConfig.KEY)`. Für Tests ein zweiter Pfad-Override: statische Factory `TokenStore.fromFile(filePath: string)`.

- [ ] **Step 1: Create types**

```typescript
// src/core/auth/domain/types/auth-store.types.ts
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CodeEntry {
  code: string;
  clientId: string;
  scopes: string[];
  expiresAt: number; // Sekunden seit Epoch
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
}

export interface TokenEntry {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number; // Sekunden seit Epoch
}

export interface StoreData {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, CodeEntry>;
  access: Record<string, TokenEntry>;
  refresh: Record<string, TokenEntry>;
}

export const EMPTY_STORE: StoreData = {
  clients: {},
  codes: {},
  access: {},
  refresh: {},
};
```

- [ ] **Step 2: Failing test — TokenStore Persistenz & Härtung**

```typescript
// src/core/auth/application/services/token-store.service.spec.ts
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
    store.access['old'] = { token: 'old', clientId: 'c', scopes: [], expiresAt: past };
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
    store.access['a'] = { token: 'a', clientId: 'c1', scopes: [], expiresAt: future };
    store.refresh['r'] = { token: 'r', clientId: 'c2', scopes: [], expiresAt: future };
    expect(store.activeClientIds()).toEqual(new Set(['c1', 'c2']));
  });
});
```

- [ ] **Step 3: Run — verify fail**

Run: `pnpm jest token-store`
Expected: FAIL (`TokenStore` fehlt).

- [ ] **Step 4: Implement `TokenStore`**

```typescript
// src/core/auth/application/services/token-store.service.ts
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import { EMPTY_STORE, type StoreData } from '@core/auth/domain/types/auth-store.types';

/**
 * JSON-Ablage für OAuth-Clients, Codes und Tokens. Portiert aus
 * `ynab-mcp/auth.py` (Klasse `Ablage`): atomare Writes, chmod 600,
 * Korruptionsschutz und Ablauf-Cleanup.
 */
@Injectable()
export class TokenStore {
  private readonly logger = new Logger(TokenStore.name);
  private data: StoreData;

  constructor(@Inject(authConfig.KEY) config: AuthConfig) {
    this.filePath = `${config.dataDir.replace(/\/$/, '')}/auth_store.json`;
    this.data = this.load();
  }

  private readonly filePath: string;

  /** Test-Helfer: Store an einem beliebigen Pfad (umgeht DI). */
  static fromFile(filePath: string): TokenStore {
    const instance = Object.create(TokenStore.prototype) as TokenStore;
    (instance as unknown as { logger: Logger }).logger = new Logger(TokenStore.name);
    (instance as unknown as { filePath: string }).filePath = filePath;
    (instance as unknown as { data: StoreData }).data = instance['load']();
    return instance;
  }

  get clients() {
    return this.data.clients;
  }
  get codes() {
    return this.data.codes;
  }
  get access() {
    return this.data.access;
  }
  get refresh() {
    return this.data.refresh;
  }

  activeClientIds(): Set<string> {
    const ids = new Set<string>();
    for (const v of Object.values(this.data.access)) ids.add(v.clientId);
    for (const v of Object.values(this.data.refresh)) ids.add(v.clientId);
    return ids;
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) return structuredClone(EMPTY_STORE);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoreData>;
      return { ...structuredClone(EMPTY_STORE), ...parsed };
    } catch (err) {
      this.logger.error(
        `auth_store.json unreadable (${String(err)}) — starting empty`,
      );
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        /* ignore */
      }
      return structuredClone(EMPTY_STORE);
    }
  }

  save(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const pot of ['codes', 'access', 'refresh'] as const) {
      const bag = this.data[pot] as Record<string, { expiresAt?: number }>;
      for (const [k, v] of Object.entries(bag)) {
        if (v.expiresAt !== undefined && v.expiresAt <= now) delete bag[k];
      }
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath); // atomar
    chmodSync(this.filePath, 0o600);
  }
}
```

- [ ] **Step 5: Run — verify pass**

Run: `pnpm jest token-store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/auth/domain/types/auth-store.types.ts src/core/auth/application/services/token-store.service.ts src/core/auth/application/services/token-store.service.spec.ts
git commit -m "feat(auth): persistent token store (atomic writes, 0600, corruption-safe)"
```

---

### Task 3: AuthSessionService (offene Logins) & LoginRateLimiter

**Files:**
- Create: `src/core/auth/application/services/auth-session.service.ts`
- Create: `src/core/auth/application/services/login-rate-limiter.service.ts`
- Test: `src/core/auth/application/services/auth-session.service.spec.ts`
- Test: `src/core/auth/application/services/login-rate-limiter.service.spec.ts`

**Interfaces:**
- Consumes: Konstanten `LOGIN_TTL_S`, `MAX_OPEN_LOGINS`, `MAX_LOGIN_FAILURES`, `LOGIN_FAILURE_WINDOW_S`.
- Produces:
  - `interface OpenLogin { clientId: string; params: AuthorizationParams; expiresAt: number }`
  - `@Injectable() AuthSessionService` mit `create(clientId: string, params: AuthorizationParams): string` (gibt `txn`), `get(txn: string): OpenLogin | undefined`, `consume(txn: string): OpenLogin | undefined`, `size(): number`.
  - `@Injectable() LoginRateLimiter` mit `isBlocked(ip: string): boolean`, `recordFailure(ip: string): number` (gibt Anzahl im Fenster), `reset(ip: string): void`.

- [ ] **Step 1: Failing tests — AuthSessionService**

```typescript
// src/core/auth/application/services/auth-session.service.spec.ts
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
```

- [ ] **Step 2: Failing tests — LoginRateLimiter**

```typescript
// src/core/auth/application/services/login-rate-limiter.service.spec.ts
import { LoginRateLimiter } from './login-rate-limiter.service';

describe('LoginRateLimiter', () => {
  it('blocks an IP after MAX_LOGIN_FAILURES failures', () => {
    const rl = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    expect(rl.isBlocked('1.2.3.4')).toBe(true);
    expect(rl.isBlocked('9.9.9.9')).toBe(false);
  });

  it('reset clears an IP counter', () => {
    const rl = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    rl.reset('1.2.3.4');
    expect(rl.isBlocked('1.2.3.4')).toBe(false);
  });
});
```

- [ ] **Step 3: Run — verify fail**

Run: `pnpm jest auth-session login-rate-limiter`
Expected: FAIL (Services fehlen).

- [ ] **Step 4: Implement `AuthSessionService`**

```typescript
// src/core/auth/application/services/auth-session.service.ts
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import { LOGIN_TTL_S, MAX_OPEN_LOGINS } from '@core/auth/domain/constants/auth.constants';

export interface OpenLogin {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

/** Offene Login-Vorgänge, nur im Speicher (ein Neustart bricht sie ab). */
@Injectable()
export class AuthSessionService {
  private readonly openLogins = new Map<string, OpenLogin>();

  create(clientId: string, params: AuthorizationParams): string {
    this.prune();
    while (this.openLogins.size >= MAX_OPEN_LOGINS) {
      const oldest = this.openLogins.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.openLogins.delete(oldest);
    }
    const txn = randomBytes(16).toString('base64url');
    this.openLogins.set(txn, {
      clientId,
      params,
      expiresAt: Math.floor(Date.now() / 1000) + LOGIN_TTL_S,
    });
    return txn;
  }

  get(txn: string): OpenLogin | undefined {
    const login = this.openLogins.get(txn);
    if (!login) return undefined;
    if (login.expiresAt < Math.floor(Date.now() / 1000)) {
      this.openLogins.delete(txn);
      return undefined;
    }
    return login;
  }

  consume(txn: string): OpenLogin | undefined {
    const login = this.get(txn);
    if (login) this.openLogins.delete(txn);
    return login;
  }

  size(): number {
    return this.openLogins.size;
  }

  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [txn, login] of this.openLogins) {
      if (login.expiresAt < now) this.openLogins.delete(txn);
    }
  }
}
```

- [ ] **Step 5: Implement `LoginRateLimiter`**

```typescript
// src/core/auth/application/services/login-rate-limiter.service.ts
import { Injectable } from '@nestjs/common';

import {
  LOGIN_FAILURE_WINDOW_S,
  MAX_LOGIN_FAILURES,
} from '@core/auth/domain/constants/auth.constants';

/** Bruteforce-Bremse pro IP für die Login-Seite (portiert aus auth.py). */
@Injectable()
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  isBlocked(ip: string): boolean {
    return this.recent(ip).length >= MAX_LOGIN_FAILURES;
  }

  recordFailure(ip: string): number {
    const recent = this.recent(ip);
    recent.push(Date.now() / 1000);
    this.failures.set(ip, recent);
    return recent.length;
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }

  private recent(ip: string): number[] {
    const cutoff = Date.now() / 1000 - LOGIN_FAILURE_WINDOW_S;
    // gleichzeitig alte IPs vergessen (DoS-Schutz gegen unbegrenztes Wachstum)
    for (const [k, v] of this.failures) {
      if (!v.some((t) => t > cutoff)) this.failures.delete(k);
    }
    return (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
  }
}
```

- [ ] **Step 6: Run — verify pass + commit**

Run: `pnpm jest auth-session login-rate-limiter`
Expected: PASS.

```bash
git add src/core/auth/application/services/auth-session.service.ts src/core/auth/application/services/auth-session.service.spec.ts src/core/auth/application/services/login-rate-limiter.service.ts src/core/auth/application/services/login-rate-limiter.service.spec.ts
git commit -m "feat(auth): in-memory login sessions and bruteforce rate limiter"
```

---

### Task 4: CookidooAuthProvider (OAuthServerProvider)

**Files:**
- Create: `src/core/auth/application/services/cookidoo-auth.provider.ts`
- Test: `src/core/auth/application/services/cookidoo-auth.provider.spec.ts`

**Interfaces:**
- Consumes: `TokenStore` (Task 2), `AuthSessionService` (Task 3), `AuthConfig` (Task 1), SDK-Typen/Errors.
- Produces: `@Injectable() CookidooAuthProvider implements OAuthServerProvider` mit allen Kontrakt-Methoden. Zusätzlich öffentliche Helfer für den LoginService:
  - `issueCodeForLogin(login: OpenLogin): string` — erzeugt Code-Entry im Store, gibt den `code`.
  - `newTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens` (public, von exchange* genutzt).

- [ ] **Step 1: Failing test**

```typescript
// src/core/auth/application/services/cookidoo-auth.provider.spec.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

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
    const res = { redirect: (_s: number, url: string) => (location = url) } as never;
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
    expect((await provider.verifyAccessToken(rotated.access_token)).clientId).toBe(
      'client-1',
    );
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm jest cookidoo-auth.provider`
Expected: FAIL (`CookidooAuthProvider` fehlt).

- [ ] **Step 3: Implement provider**

```typescript
// src/core/auth/application/services/cookidoo-auth.provider.ts
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import {
  ACCESS_TTL_S,
  CODE_TTL_S,
  DEFAULT_SCOPES,
  MAX_CLIENTS,
  REFRESH_TTL_S,
} from '@core/auth/domain/constants/auth.constants';
import { AuthSessionService, type OpenLogin } from './auth-session.service';
import { TokenStore } from './token-store.service';

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * OAuth-2.0-Provider für den Cookidoo-MCP. Portierung von
 * `ynab-mcp/auth.py` (`YnabAuthProvider`). Der SDK liefert die
 * Protokoll-Endpunkte; diese Klasse beantwortet die Provider-Fragen.
 */
@Injectable()
export class CookidooAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly store: TokenStore,
    private readonly sessions: AuthSessionService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.clients[clientId],
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        const clients = this.store.clients;
        if (Object.keys(clients).length >= MAX_CLIENTS) {
          const active = this.store.activeClientIds();
          for (const cid of Object.keys(clients)) {
            if (Object.keys(clients).length < MAX_CLIENTS) break;
            if (!active.has(cid)) delete clients[cid];
          }
        }
        clients[full.client_id] = full;
        this.store.save();
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const txn = this.sessions.create(client.client_id, params);
    res.redirect(302, `${this.config.publicUrl}/login?txn=${encodeURIComponent(txn)}`);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.store.codes[authorizationCode];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < nowS()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.store.codes[authorizationCode];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < nowS()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    delete this.store.codes[authorizationCode]; // Einmal-Code entwerten
    return this.newTokens(client.client_id, entry.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = this.store.refresh[refreshToken];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < nowS()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    delete this.store.refresh[refreshToken]; // Rotation: alter Refresh verfällt
    return this.newTokens(client.client_id, scopes?.length ? scopes : entry.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.store.access[token];
    if (!entry || entry.expiresAt < nowS()) {
      throw new InvalidTokenError('Access token is invalid or expired');
    }
    return {
      token: entry.token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    delete this.store.access[request.token];
    delete this.store.refresh[request.token];
    this.store.save();
  }

  /** Erzeugt aus einem verifizierten Login-Vorgang den Einmal-Code. */
  issueCodeForLogin(login: OpenLogin): string {
    const code = randomBytes(32).toString('base64url');
    this.store.codes[code] = {
      code,
      clientId: login.clientId,
      scopes: login.params.scopes?.length ? login.params.scopes : DEFAULT_SCOPES,
      expiresAt: nowS() + CODE_TTL_S,
      codeChallenge: login.params.codeChallenge,
      redirectUri: login.params.redirectUri,
      resource: login.params.resource?.toString(),
    };
    this.store.save();
    return code;
  }

  newTokens(clientId: string, scopes: string[]): OAuthTokens {
    const access = randomBytes(32).toString('base64url');
    const refresh = randomBytes(32).toString('base64url');
    this.store.access[access] = {
      token: access,
      clientId,
      scopes,
      expiresAt: nowS() + ACCESS_TTL_S,
    };
    this.store.refresh[refresh] = {
      token: refresh,
      clientId,
      scopes,
      expiresAt: nowS() + REFRESH_TTL_S,
    };
    this.store.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      scope: scopes.join(' '),
      refresh_token: refresh,
    };
  }
}
```

- [ ] **Step 4: Run — verify pass + commit**

Run: `pnpm jest cookidoo-auth.provider`
Expected: PASS.

```bash
git add src/core/auth/application/services/cookidoo-auth.provider.ts src/core/auth/application/services/cookidoo-auth.provider.spec.ts
git commit -m "feat(auth): CookidooAuthProvider implementing OAuthServerProvider"
```

---

### Task 5: LoginService + HTML-Templates (Consent + Passphrase)

**Files:**
- Create: `src/core/auth/transport/rest/login.templates.ts`
- Create: `src/core/auth/transport/rest/login.service.ts`
- Test: `src/core/auth/transport/rest/login.service.spec.ts`

**Interfaces:**
- Consumes: `AuthSessionService`, `TokenStore`, `LoginRateLimiter`, `CookidooAuthProvider`, `AuthConfig`.
- Produces: `@Injectable() LoginService` mit:
  - `renderLoginPage(txn: string): { status: number; html: string }`
  - `handleLogin(input: { txn: string; phrase: string; ip: string }): Promise<{ status: number; redirectUrl?: string; html?: string }>`
  - Helfer `escapeHtml(s: string): string` und `buildRedirectUri(base: string, code: string, state?: string): string` (exportiert für Tests).

- [ ] **Step 1: Create templates**

```typescript
// src/core/auth/transport/rest/login.templates.ts
/** HTML-Escaping gegen XSS über bösartige Client-Metadaten. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loginPageHtml(input: {
  txn: string;
  clientName: string;
  redirectTarget: string;
}): string {
  const txn = escapeHtml(input.txn);
  const clientName = escapeHtml(input.clientName);
  const target = escapeHtml(input.redirectTarget);
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Cookidoo-MCP Login</title></head>
<body style="font-family: sans-serif; max-width: 28rem; margin: 4rem auto; line-height: 1.5;">
  <h2>🔐 Cookidoo-MCP</h2>
  <p>Eine Anwendung möchte Zugriff auf deinen Cookidoo-Account:</p>
  <ul style="background: #f4f4f4; padding: 1rem 1.5rem; border-radius: .5rem; list-style: none;">
    <li><strong>Anwendung:</strong> ${clientName}</li>
    <li style="margin-top: .5rem;"><strong>Weiterleitung nach:</strong><br><code style="word-break: break-all;">${target}</code></li>
  </ul>
  <p style="color: #b00020;">⚠️ Gib die Passphrase <strong>nur</strong> ein, wenn du diesen Login gerade
  <strong>selbst</strong> gestartet hast. Kennst du Anwendung oder Ziel nicht — schließe diese Seite.</p>
  <form method="post" action="/login">
    <input type="hidden" name="txn" value="${txn}">
    <input type="password" name="phrase" autofocus style="width: 100%; padding: .5rem;">
    <button type="submit" style="margin-top: 1rem; padding: .5rem 1.5rem;">Erlauben</button>
  </form>
</body></html>`;
}
```

- [ ] **Step 2: Failing test — LoginService**

```typescript
// src/core/auth/transport/rest/login.service.spec.ts
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
    const out = await svc.handleLogin({ txn, phrase: 'correct horse', ip: '1.1.1.1' });
    expect(out.status).toBe(302);
    expect(out.redirectUrl).toMatch(/^https:\/\/client\.example\/cb\?code=.+&state=st-1$/);
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
    const out = await svc.handleLogin({ txn, phrase: 'whatever', ip: '3.3.3.3' });
    expect(out.status).toBe(429);
  });
});
```

- [ ] **Step 3: Run — verify fail**

Run: `pnpm jest login.service`
Expected: FAIL.

- [ ] **Step 4: Implement `LoginService`**

```typescript
// src/core/auth/transport/rest/login.service.ts
import { setTimeout as sleep } from 'node:timers/promises';
import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import { LOGIN_DELAY_MS } from '@core/auth/domain/constants/auth.constants';
import { AuthSessionService } from '@core/auth/application/services/auth-session.service';
import { CookidooAuthProvider } from '@core/auth/application/services/cookidoo-auth.provider';
import { LoginRateLimiter } from '@core/auth/application/services/login-rate-limiter.service';
import { TokenStore } from '@core/auth/application/services/token-store.service';
import { loginPageHtml } from './login.templates';

/** Hängt code/state sicher an die (validierte) Redirect-URI des Clients. */
export function buildRedirectUri(base: string, code: string, state?: string): string {
  const url = new URL(base);
  url.searchParams.set('code', code);
  if (state !== undefined) url.searchParams.set('state', state);
  return url.toString();
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly sessions: AuthSessionService,
    private readonly rateLimiter: LoginRateLimiter,
    private readonly provider: CookidooAuthProvider,
    private readonly store: TokenStore,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  renderLoginPage(txn: string): { status: number; html: string } {
    const login = this.sessions.get(txn);
    if (!login) {
      return { status: 400, html: 'Login-Vorgang unbekannt oder abgelaufen.' };
    }
    const client = this.store.clients[login.clientId];
    const clientName =
      (client?.client_name as string | undefined) ?? login.clientId;
    return {
      status: 200,
      html: loginPageHtml({
        txn,
        clientName,
        redirectTarget: login.params.redirectUri,
      }),
    };
  }

  async handleLogin(input: {
    txn: string;
    phrase: string;
    ip: string;
  }): Promise<{ status: number; redirectUrl?: string; html?: string }> {
    if (this.rateLimiter.isBlocked(input.ip)) {
      this.logger.warn(`Login blocked (too many failures) from IP ${input.ip}`);
      return { status: 429, html: 'Zu viele Fehlversuche. Bitte kurz warten.' };
    }

    const login = this.sessions.get(input.txn);
    if (!login) {
      return { status: 400, html: 'Login-Vorgang unbekannt oder abgelaufen.' };
    }

    if (!constantTimeEquals(input.phrase, this.config.loginSecret)) {
      const count = this.rateLimiter.recordFailure(input.ip);
      this.logger.warn(`Wrong passphrase (${count}) from IP ${input.ip}`);
      await sleep(LOGIN_DELAY_MS);
      if (this.rateLimiter.isBlocked(input.ip)) this.sessions.consume(input.txn);
      return { status: 403, html: 'Falsche Passphrase.' };
    }

    this.rateLimiter.reset(input.ip);
    const consumed = this.sessions.consume(input.txn)!;
    const code = this.provider.issueCodeForLogin(consumed);
    return {
      status: 302,
      redirectUrl: buildRedirectUri(
        consumed.params.redirectUri,
        code,
        consumed.params.state,
      ),
    };
  }
}
```

- [ ] **Step 5: Run — verify pass + commit**

Run: `pnpm jest login.service`
Expected: PASS.

```bash
git add src/core/auth/transport/rest/login.templates.ts src/core/auth/transport/rest/login.service.ts src/core/auth/transport/rest/login.service.spec.ts
git commit -m "feat(auth): passphrase login service with consent page and rate limiting"
```

---

### Task 6: AuthModule, Bearer-Guard-Middleware & Express-Wiring

**Files:**
- Create: `src/core/auth/auth.module.ts`
- Create: `src/core/auth/auth.wiring.ts`
- Modify: `src/main.ts` (Wiring aufrufen; `trust proxy` setzen)
- Modify: `src/app.module.ts` (`AuthModule` importieren)
- Test (e2e): `test/auth.e2e-spec.ts`
- Modify (falls nötig): `test/jest-e2e.json` (moduleNameMapper für `@core`/`@contexts`/`@shared`, siehe Step)

**Interfaces:**
- Consumes: alle Auth-Services; SDK `mcpAuthRouter`, `requireBearerAuth`, `getOAuthProtectedResourceMetadataUrl`.
- Produces:
  - `AuthModule implements NestModule` — providt alle Auth-Services + `LoginService`, exportiert `CookidooAuthProvider` und `LoginService`; `configure(consumer)` hängt bei aktivem Auth `requireBearerAuth` an die `mcp`-Route.
  - `configureAuth(app: INestApplication): void` — mountet auf dem rohen Express-Instance die Login-Routen und `mcpAuthRouter` (Root-Ebene) und setzt `trust proxy`.

- [ ] **Step 1: Implement `AuthModule`**

```typescript
// src/core/auth/auth.module.ts
import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import { AuthSessionService } from './application/services/auth-session.service';
import { CookidooAuthProvider } from './application/services/cookidoo-auth.provider';
import { LoginRateLimiter } from './application/services/login-rate-limiter.service';
import { TokenStore } from './application/services/token-store.service';
import { LoginService } from './transport/rest/login.service';

/**
 * OAuth-Türsteher. Additiv: ohne MCP_LOGIN_SECRET/MCP_PUBLIC_URL bleibt der
 * Server unauthentifiziert wie Upstream. Bei aktivem Auth schützt eine
 * Bearer-Middleware die `mcp`-Route (relativ zum Global-Prefix -> /api/mcp).
 */
@Module({
  providers: [
    TokenStore,
    AuthSessionService,
    LoginRateLimiter,
    CookidooAuthProvider,
    LoginService,
  ],
  exports: [CookidooAuthProvider, LoginService],
})
export class AuthModule implements NestModule {
  constructor(
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    private readonly provider: CookidooAuthProvider,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    if (!this.config.enabled) return;
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
      new URL(`${this.config.publicUrl}/api/mcp`),
    );
    const bearer = requireBearerAuth({
      verifier: this.provider,
      resourceMetadataUrl,
    });
    consumer
      .apply(bearer)
      .forRoutes({ path: 'mcp', method: RequestMethod.POST });
  }
}
```

- [ ] **Step 2: Implement `configureAuth`**

```typescript
// src/core/auth/auth.wiring.ts
import express from 'express';
import { Logger, type INestApplication } from '@nestjs/common';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import { DEFAULT_SCOPES } from '@core/auth/domain/constants/auth.constants';
import { CookidooAuthProvider } from '@core/auth/application/services/cookidoo-auth.provider';
import { LoginService } from '@core/auth/transport/rest/login.service';

/** Ermittelt die echte Client-IP hinter cloudflared (LETZTER XFF-Eintrag). */
function clientIp(req: express.Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',').map((s) => s.trim()).pop() as string;
  }
  return req.ip ?? 'unknown';
}

/**
 * Mountet Login-Seiten und die SDK-OAuth-Endpunkte auf dem rohen Express-App
 * (Root-Ebene, nicht unter /api — passend zu den Discovery-Metadaten).
 * No-op, wenn Auth deaktiviert ist.
 */
export function configureAuth(app: INestApplication): void {
  const logger = new Logger('AuthWiring');
  const config = app.get<AuthConfig>(authConfig.KEY);
  if (!config.enabled) {
    logger.warn(
      'MCP auth DISABLED — set MCP_LOGIN_SECRET and MCP_PUBLIC_URL to protect /api/mcp',
    );
    return;
  }

  const provider = app.get(CookidooAuthProvider);
  const loginService = app.get(LoginService);
  const expressApp = app.getHttpAdapter().getInstance() as express.Application;
  expressApp.set('trust proxy', config.trustProxy);

  // Login-Seite (Consent + Passphrase)
  expressApp.get('/login', (req, res) => {
    const { status, html } = loginService.renderLoginPage(
      String(req.query.txn ?? ''),
    );
    res.status(status).type('html').send(html);
  });
  expressApp.post(
    '/login',
    express.urlencoded({ extended: false }),
    (req, res) => {
      void (async () => {
        const out = await loginService.handleLogin({
          txn: String(req.body.txn ?? ''),
          phrase: String(req.body.phrase ?? ''),
          ip: clientIp(req),
        });
        if (out.status === 302 && out.redirectUrl) {
          res.redirect(302, out.redirectUrl);
          return;
        }
        res.status(out.status).type('html').send(out.html ?? '');
      })();
    },
  );

  // SDK-OAuth-Endpunkte (/authorize, /token, /register, /revoke, Discovery)
  expressApp.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(`${config.publicUrl}/api/mcp`),
      resourceName: 'Cookidoo MCP',
      scopesSupported: DEFAULT_SCOPES,
    }),
  );

  logger.log('MCP auth ENABLED — /api/mcp requires a valid Bearer token');
}
```

- [ ] **Step 3: Wire into `main.ts` and `app.module.ts`**

`src/app.module.ts` — Import + in `imports`-Array (nach `McpModule`):

```typescript
import { AuthModule } from '@core/auth/auth.module';
// ... imports: [ ..., McpModule, AuthModule, CookidooModule ],
```

`src/main.ts` — nach `app.setGlobalPrefix('api');` und vor `app.listen(...)` einfügen:

```typescript
import { configureAuth } from '@core/auth/auth.wiring';
// ... in bootstrap(), nach setGlobalPrefix und useGlobalPipes:
  configureAuth(app);
```

- [ ] **Step 4: Ensure e2e jest resolves path aliases**

Öffne `test/jest-e2e.json`. Falls kein `moduleNameMapper` mit `@core`/`@contexts`/`@shared` vorhanden ist, ergänze:

```json
{
  "moduleNameMapper": {
    "^@contexts/(.*)$": "<rootDir>/../src/contexts/$1",
    "^@core/(.*)$": "<rootDir>/../src/core/$1",
    "^@shared/(.*)$": "<rootDir>/../src/shared/$1"
  }
}
```

(Die bestehenden Keys nicht überschreiben — nur fehlende ergänzen. `rootDir` der e2e-Config ist `test/`.)

- [ ] **Step 5: Failing e2e test — Auth-Flow**

```typescript
// test/auth.e2e-spec.ts
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

describe('OAuth türsteher (e2e)', () => {
  let app: INestApplication;
  let server: import('http').Server;

  beforeAll(async () => {
    process.env.COOKIDOO_EMAIL = 'a@b.de';
    process.env.COOKIDOO_PASSWORD = 'pw';
    process.env.MCP_LOGIN_SECRET = 'test-passphrase';
    process.env.MCP_PUBLIC_URL = 'https://mcp.test.example.com';
    process.env.MCP_DATA_DIR = require('node:fs').mkdtempSync(
      require('node:path').join(require('node:os').tmpdir(), 'e2e-auth-'),
    );

    const { AppModule } = await import('../src/app.module');
    const { configureAuth } = await import('../src/core/auth/auth.wiring');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    configureAuth(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health is reachable without auth', async () => {
    await request(server).get('/api/health').expect(200);
  });

  it('POST /api/mcp without a token returns 401 with WWW-Authenticate', async () => {
    const res = await request(server)
      .post('/api/mcp')
      .set('content-type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata/);
  });

  it('advertises authorization server metadata', async () => {
    const res = await request(server).get(
      '/.well-known/oauth-authorization-server',
    );
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://mcp.test.example.com');
    expect(res.body.registration_endpoint).toBeTruthy();
  });

  it('completes DCR → authorize → login → token → authenticated /api/mcp', async () => {
    // 1) Dynamic Client Registration
    const reg = await request(server)
      .post('/register')
      .set('content-type', 'application/json')
      .send({
        client_name: 'Test Connector',
        redirect_uris: ['https://client.test/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
      .expect(201);
    const clientId = reg.body.client_id as string;
    expect(clientId).toBeTruthy();

    // 2) Authorize (PKCE) -> redirect to /login?txn=...
    // S256 challenge for verifier "verifier..." — precomputed constant.
    const codeVerifier = 'test-verifier-0123456789-0123456789-0123456789';
    const codeChallenge = require('node:crypto')
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const authRes = await request(server).get('/authorize').query({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: 'https://client.test/callback',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'cookidoo',
    });
    expect(authRes.status).toBe(302);
    const loginLocation = authRes.headers.location as string;
    expect(loginLocation).toContain('/login?txn=');
    const txn = new URL(loginLocation).searchParams.get('txn') as string;

    // 3) Submit the passphrase -> redirect back to client with ?code=
    const loginRes = await request(server)
      .post('/login')
      .type('form')
      .send({ txn, phrase: 'test-passphrase' });
    expect(loginRes.status).toBe(302);
    const cbLocation = new URL(loginRes.headers.location as string);
    const code = cbLocation.searchParams.get('code') as string;
    expect(code).toBeTruthy();
    expect(cbLocation.searchParams.get('state')).toBe('state-123');

    // 4) Exchange code -> tokens
    const tokenRes = await request(server)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://client.test/callback',
        code_verifier: codeVerifier,
      })
      .expect(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();

    // 5) Authenticated /api/mcp no longer returns 401
    const mcpRes = await request(server)
      .post('/api/mcp')
      .set('authorization', `Bearer ${accessToken}`)
      .set('content-type', 'application/json')
      .set('accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcpRes.status).not.toBe(401);
  });

  it('wrong passphrase returns 403', async () => {
    const reg = await request(server)
      .post('/register')
      .send({
        client_name: 'X',
        redirect_uris: ['https://client.test/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
    const challenge = require('node:crypto')
      .createHash('sha256')
      .update('v'.repeat(43))
      .digest('base64url');
    const authRes = await request(server).get('/authorize').query({
      client_id: reg.body.client_id,
      response_type: 'code',
      redirect_uri: 'https://client.test/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      scope: 'cookidoo',
    });
    const txn = new URL(authRes.headers.location as string).searchParams.get(
      'txn',
    ) as string;
    const res = await request(server)
      .post('/login')
      .type('form')
      .send({ txn, phrase: 'nope' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 6: Run e2e — iterate to green**

Run: `pnpm test:e2e -- auth.e2e-spec`
Expected: PASS. Wahrscheinliche Stolpersteine und Fixes:
- **401 statt Metadaten-Fund:** Prüfe, dass `configureAuth(app)` VOR `app.init()` läuft (im Test: vor `await app.init()`; in `main.ts`: vor `app.listen()`).
- **`/api/mcp` liefert 401 trotz Token:** Der Bearer-Guard aus `AuthModule.configure` greift; stelle sicher, dass `AuthModule` in `AppModule.imports` steht und `CookidooAuthProvider` exportiert/instanziiert ist (Singleton — derselbe Provider, der die Tokens ausgab).
- **`/authorize` 400 (invalid redirect):** Der registrierte `redirect_uris`-Eintrag muss exakt der Query-`redirect_uri` entsprechen.
- **Body-Parser-Konflikt auf `/token`/`/register`:** Der SDK-Router bringt eigene Parser mit; Nest-Global-Parser stört nicht. Falls doch, in `NestFactory.create(AppModule, { bodyParser: true })` belassen und NICHT global abschalten (der MCP-Controller braucht `req.body`).
- **`tools/list` gibt Fehler (kein 401):** akzeptabel — der Test prüft nur `not 401`; der echte Cookidoo-Login passiert lazy und ist hier nicht gemockt.

- [ ] **Step 7: Full test suite + build + commit**

Run: `pnpm jest && pnpm test:e2e && pnpm build`
Expected: alle grün, Build ok.

```bash
git add src/core/auth/auth.module.ts src/core/auth/auth.wiring.ts src/main.ts src/app.module.ts test/auth.e2e-spec.ts test/jest-e2e.json
git commit -m "feat(auth): wire OAuth router + bearer guard into NestJS (protects /api/mcp)"
```

---

### Task 7: Deployment (Docker Compose, .env, DE-Defaults, README)

**Files:**
- Create: `docker-compose.yml`
- Modify: `.env.example` (Auth-Vars + DE-Markt-Defaults)
- Modify: `src/core/config/cookidoo.config.ts` (Default-Markt auf DE)
- Modify: `src/core/config/env.validation.ts` (Doc-Kommentar auf DE korrigieren)
- Modify: `README.md` (Abschnitt „Betrieb mit Auth (claude.ai Connector)")
- Test: `src/core/config/env.validation.spec.ts` läuft weiter grün (Regression)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: lauffähiges Compose-Deployment + dokumentierte Betriebsanleitung.

- [ ] **Step 1: DE-Defaults in `cookidoo.config.ts`**

Ersetze die drei Default-Konstanten:

```typescript
const DEFAULT_COUNTRY_CODE = 'de';
const DEFAULT_LANGUAGE = 'de-DE';
const DEFAULT_URL = 'https://cookidoo.de/foundation/de-DE';
```

Und den JSDoc-Kommentar darüber auf „Default localization: German Cookidoo (Germany)." anpassen.

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
# Startet den Cookidoo-MCP hinter dem bestehenden Cloudflare-Tunnel.
# Bau: aus dem Dockerfile hier. Start: `docker compose up -d`.
services:
  cookidoo-mcp:
    build: .
    image: cookidoo-mcp:latest
    container_name: cookidoo-mcp
    env_file: .env
    volumes:
      # auth_store.json + optionale .cookidoo-session.json überleben die Kiste.
      # Verzeichnis mounten, nie die Datei (atomarer rename!).
      - ~/cookidoo-mcp-data:/data
    restart: unless-stopped
    networks:
      - proxy
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3

# Bestehendes externes Netz (Traefik/cloudflared hängen dran) — nur beitreten.
networks:
  proxy:
    external: true
```

- [ ] **Step 3: Extend `.env.example`**

Am Ende von `.env.example` anfügen und den Markt-Default-Block auf DE stellen:

```bash
# --- MCP-Türsteher (nur für öffentlichen Betrieb / claude.ai-Connector) ---
# Beide zusammen setzen, um Auth zu aktivieren. Bleiben sie leer, läuft der
# Server OHNE Auth (nur lokal/Tailnet vertretbar).
#
# Passphrase der Login-Seite. Lang & zufällig:  openssl rand -base64 32
MCP_LOGIN_SECRET=
# Öffentliche Basis-URL (https, ohne Trailing-Slash), z.B. der Tunnel-Hostname:
MCP_PUBLIC_URL=
# Verzeichnis für den Token-Store (im Container das /data-Volume):
MCP_DATA_DIR=/data
# Session persistieren (empfohlen), im /data-Volume:
COOKIDOO_COOKIE_FILE=/data/.cookidoo-session.json
```

Und den vorhandenen Markt-Block auf Deutschland ändern:

```bash
COOKIDOO_COUNTRY_CODE=de
COOKIDOO_LANGUAGE=de-DE
COOKIDOO_URL=https://cookidoo.de/foundation/de-DE
```

- [ ] **Step 4: README-Abschnitt ergänzen**

Füge in `README.md` einen Abschnitt „## Betrieb mit Auth (claude.ai Connector)" hinzu mit:
- Erklärung, dass ohne `MCP_LOGIN_SECRET`+`MCP_PUBLIC_URL` KEIN Schutz besteht.
- `.env` befüllen (`openssl rand -base64 32` für die Passphrase; Tunnel-Hostname als `MCP_PUBLIC_URL`).
- `mkdir -p ~/cookidoo-mcp-data && docker compose up -d --build`.
- Cloudflare: bestehenden Tunnel → Public Hostname `cookidoo-mcp.<domain>` → Service `http://cookidoo-mcp:3000`.
- claude.ai: Settings → Connectors → Custom Connector → URL `https://cookidoo-mcp.<domain>/api/mcp`; beim Verbinden erscheint die Passphrase-Login-Seite.
- Hinweis: Cookidoo-`.env` liegt nur auf dem Server, niemals committen.

- [ ] **Step 5: Regression + build + commit**

Run: `pnpm jest src/core/config && pnpm build`
Expected: PASS.

```bash
git add docker-compose.yml .env.example src/core/config/cookidoo.config.ts src/core/config/env.validation.ts README.md
git commit -m "feat(deploy): docker-compose, DE defaults and auth operations docs"
```

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/mcp-oauth-auth
```

---

## Self-Review

**Spec coverage:**
- Spec §3.1/§3.2 (Portierung + NestJS-Integration) → Tasks 4 (Provider), 6 (Wiring/Guard). ✓
- Spec §3.3 (Modulstruktur `src/core/auth/`) → Tasks 2–6 legen genau diese Dateien an (leichte, bewusste Vereinfachung: `AuthSessionService`/`LoginRateLimiter` statt der im Spec skizzierten Einzeldateien — funktional deckungsgleich). ✓
- Spec §4 (Env-Vars, Auth-Toggle) → Task 1. ✓
- Spec §5 (Sicherheits-Parität, alle Punkte) → Task 2 (atomar/0600/Korruption), 3 (Bruteforce/Caps), 4 (Token-TTLs/Client-Caps), 5 (constant-time, Consent-Escape, IP), 6 (WWW-Authenticate). ✓
- Spec §6 (Deployment, Tunnel-Reuse, kein Host-Port, DE-Markt) → Task 7. ✓
- Spec §7 (Teststrategie) → Unit-Tests in Tasks 2–5, e2e in Task 6, Regression in 1/7. ✓
- Spec §9 (Risiken: SDK-API verifiziert) → in diesem Plan bereits gegen die installierten `.d.ts` (1.30.0) geprüft; `WWW-Authenticate`/`resource_metadata` im e2e abgesichert. ✓

**Placeholder scan:** Keine TBD/TODO; jeder Code-Step enthält vollständigen Code. Der einzige „…"-artige Platzhalter ist `cookidoo-mcp.<domain>` in der Doku — bewusst ein vom Betreiber einzusetzender Wert.

**Type consistency:** `TokenStore.fromFile`, `activeClientIds`, `issueCodeForLogin`, `newTokens`, `buildRedirectUri`, `renderLoginPage`, `handleLogin`, `configureAuth`, `AuthConfig`-Felder und die SDK-Provider-Signaturen sind über Tasks 1–6 hinweg identisch benannt und verwendet.
