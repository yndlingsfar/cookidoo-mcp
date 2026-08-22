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
