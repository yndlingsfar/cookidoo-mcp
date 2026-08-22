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
    res.redirect(
      302,
      `${this.config.publicUrl}/login?txn=${encodeURIComponent(txn)}`,
    );
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.store.codes[authorizationCode];
    if (
      !entry ||
      entry.clientId !== client.client_id ||
      entry.expiresAt < nowS()
    ) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.store.codes[authorizationCode];
    if (
      !entry ||
      entry.clientId !== client.client_id ||
      entry.expiresAt < nowS()
    ) {
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
    if (
      !entry ||
      entry.clientId !== client.client_id ||
      entry.expiresAt < nowS()
    ) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    delete this.store.refresh[refreshToken]; // Rotation: alter Refresh verfällt
    return this.newTokens(
      client.client_id,
      scopes?.length ? scopes : entry.scopes,
    );
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
