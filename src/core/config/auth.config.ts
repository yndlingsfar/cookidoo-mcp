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
  const publicUrl = (process.env.MCP_PUBLIC_URL?.trim() ?? '').replace(
    /\/$/,
    '',
  );
  return {
    enabled: !!loginSecret && !!publicUrl,
    loginSecret,
    publicUrl,
    dataDir: process.env.MCP_DATA_DIR?.trim() || '/data',
    trustProxy: (process.env.MCP_TRUST_PROXY?.trim() ?? 'true') !== 'false',
  };
});
