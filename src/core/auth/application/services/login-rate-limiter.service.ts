import { Injectable } from '@nestjs/common';

import {
  LOGIN_FAILURE_WINDOW_S,
  MAX_LOGIN_FAILURES,
} from '@core/auth/domain/constants/auth.constants';

/** Bruteforce-Bremse pro IP für die Login-Seite (portiert aus auth.py). */
@Injectable()
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  isBlocked(ip: string): boolean {
    return this.recent(ip).length >= MAX_LOGIN_FAILURES;
  }

  recordFailure(ip: string): number {
    const recent = this.recent(ip);
    recent.push(Date.now() / 1000);
    this.failures.set(ip, recent);
    return recent.length;
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }

  private recent(ip: string): number[] {
    const cutoff = Date.now() / 1000 - LOGIN_FAILURE_WINDOW_S;
    // gleichzeitig alte IPs vergessen (DoS-Schutz gegen unbegrenztes Wachstum)
    for (const [k, v] of this.failures) {
      if (!v.some((t) => t > cutoff)) this.failures.delete(k);
    }
    return (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
  }
}
