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
