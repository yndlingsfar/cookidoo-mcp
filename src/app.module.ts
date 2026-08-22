import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';

import { authConfig } from '@core/config/auth.config';
import { cookidooConfig } from '@core/config/cookidoo.config';
import { validateEnv } from '@core/config/env.validation';
import { otelConfig } from '@core/config/otel.config';
import { AuthModule } from '@core/auth/auth.module';
import { HealthModule } from '@core/health/health.module';
import { McpModule } from '@core/mcp/mcp.module';
import { ObservabilityModule } from '@core/observability/observability.module';
import { CookidooModule } from '@contexts/cookidoo/cookidoo.module';
import { LoggingModule } from './support/logging/logging.module';

@Module({
  imports: [
    CqrsModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      load: [cookidooConfig, otelConfig, authConfig],
      cache: true,
    }),
    LoggingModule,
    ObservabilityModule,
    HealthModule,
    McpModule,
    AuthModule,
    CookidooModule,
  ],
})
export class AppModule {}
