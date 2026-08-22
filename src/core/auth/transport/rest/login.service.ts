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
export function buildRedirectUri(
  base: string,
  code: string,
  state?: string,
): string {
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
