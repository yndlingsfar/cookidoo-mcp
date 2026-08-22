import { validateEnv } from './env.validation';

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    COOKIDOO_EMAIL: 'user@example.com',
    COOKIDOO_PASSWORD: 'secret',
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('accepts a complete environment', () => {
    expect(() => validateEnv(validEnv())).not.toThrow();
  });

  it('accepts optional localization overrides', () => {
    expect(() =>
      validateEnv(
        validEnv({
          COOKIDOO_COUNTRY_CODE: 'es',
          COOKIDOO_LANGUAGE: 'es',
          COOKIDOO_URL: 'https://cookidoo.es/foundation/es',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a missing email', () => {
    expect(() => validateEnv(validEnv({ COOKIDOO_EMAIL: undefined }))).toThrow(
      /Environment validation failed:[\s\S]*COOKIDOO_EMAIL/,
    );
  });

  it('rejects an invalid email', () => {
    expect(() =>
      validateEnv(validEnv({ COOKIDOO_EMAIL: 'not-an-email' })),
    ).toThrow(/COOKIDOO_EMAIL/);
  });

  it('rejects an empty password', () => {
    expect(() => validateEnv(validEnv({ COOKIDOO_PASSWORD: '' }))).toThrow(
      /COOKIDOO_PASSWORD/,
    );
  });

  it('rejects a non-URL localization url', () => {
    expect(() => validateEnv(validEnv({ COOKIDOO_URL: 'not a url' }))).toThrow(
      /COOKIDOO_URL/,
    );
  });

  it('accepts a valid OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const env = validEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });

    expect(() => validateEnv(env)).not.toThrow();
  });

  it('rejects a non-URL OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const env = validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' });

    expect(() => validateEnv(env)).toThrow(
      /Environment validation failed:[\s\S]*OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
});

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
