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
    return xff
      .split(',')
      .map((s) => s.trim())
      .pop() as string;
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
  // Genau EIN vertrauenswürdiger Proxy (cloudflared) — nicht `true`, sonst
  // warnt express-rate-limit (ERR_ERL_PERMISSIVE_TRUST_PROXY: die vorderste,
  // fälschbare XFF-Adresse würde vertraut). `1` = nur der letzte Hop.
  expressApp.set('trust proxy', config.trustProxy ? 1 : false);

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
        res
          .status(out.status)
          .type('html')
          .send(out.html ?? '');
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
