import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { authConfig, type AuthConfig } from '@core/config/auth.config';
import {
  EMPTY_STORE,
  type StoreData,
} from '@core/auth/domain/types/auth-store.types';

/**
 * JSON-Ablage für OAuth-Clients, Codes und Tokens. Portiert aus
 * `ynab-mcp/auth.py` (Klasse `Ablage`): atomare Writes, chmod 600,
 * Korruptionsschutz und Ablauf-Cleanup.
 */
@Injectable()
export class TokenStore {
  private readonly logger = new Logger(TokenStore.name);
  private readonly filePath: string;
  private data: StoreData;

  constructor(@Inject(authConfig.KEY) config: AuthConfig) {
    this.filePath = `${config.dataDir.replace(/\/$/, '')}/auth_store.json`;
    this.data = this.load();
  }

  /** Test-Helfer: Store an einem beliebigen Pfad (umgeht DI). */
  static fromFile(filePath: string): TokenStore {
    const instance = Object.create(TokenStore.prototype) as TokenStore;
    (instance as unknown as { logger: Logger }).logger = new Logger(
      TokenStore.name,
    );
    (instance as unknown as { filePath: string }).filePath = filePath;
    (instance as unknown as { data: StoreData }).data = instance.load();
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
      const parsed = JSON.parse(
        readFileSync(this.filePath, 'utf8'),
      ) as Partial<StoreData>;
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
