import { LoginRateLimiter } from './login-rate-limiter.service';

describe('LoginRateLimiter', () => {
  it('blocks an IP after MAX_LOGIN_FAILURES failures', () => {
    const rl = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    expect(rl.isBlocked('1.2.3.4')).toBe(true);
    expect(rl.isBlocked('9.9.9.9')).toBe(false);
  });

  it('reset clears an IP counter', () => {
    const rl = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) rl.recordFailure('1.2.3.4');
    rl.reset('1.2.3.4');
    expect(rl.isBlocked('1.2.3.4')).toBe(false);
  });
});
