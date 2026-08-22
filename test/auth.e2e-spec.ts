import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

describe('OAuth türsteher (e2e)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    process.env.COOKIDOO_EMAIL = 'a@b.de';
    process.env.COOKIDOO_PASSWORD = 'pw';
    process.env.MCP_LOGIN_SECRET = 'test-passphrase';
    process.env.MCP_PUBLIC_URL = 'https://mcp.test.example.com';
    process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2e-auth-'));

    const { AppModule } = await import('../src/app.module');
    const { configureAuth } = await import('../src/core/auth/auth.wiring');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    configureAuth(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    // Auth-Env nicht in andere e2e-Dateien (gleicher Worker-Prozess) lecken lassen.
    delete process.env.MCP_LOGIN_SECRET;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_DATA_DIR;
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
    // Der Issuer ist die Public-URL (URL normalisiert mit Trailing-Slash).
    expect(res.body.issuer).toMatch(/^https:\/\/mcp\.test\.example\.com\/?$/);
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
    const codeVerifier = 'test-verifier-0123456789-0123456789-0123456789';
    const codeChallenge = createHash('sha256')
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
    const challenge = createHash('sha256')
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
