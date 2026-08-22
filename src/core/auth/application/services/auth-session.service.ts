import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';

import {
  LOGIN_TTL_S,
  MAX_OPEN_LOGINS,
} from '@core/auth/domain/constants/auth.constants';

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
