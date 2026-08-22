import { Module } from '@nestjs/common';
import { createSharedWinstonLoggerOptions } from '@sisques-labs/nestjs-kit';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';
import { WinstonModule } from 'nest-winston';

@Module({
  imports: [
    WinstonModule.forRoot(
      createSharedWinstonLoggerOptions({
        service: 'cookidoo-mcp',
        // Im Container laufen wir als User `node`; das Standard-Ziel `logs/`
        // unter /app ist nicht schreibbar (EACCES). Logs gehören ohnehin auf
        // stdout — Docker/Portainer fängt sie ab. Datei-Rotation daher aus;
        // Console + OTEL bleiben aktiv.
        enableDailyRotateFile: false,
        // Forwards every log line into the OpenTelemetry Logs pipeline
        // (src/telemetry.ts) alongside the console transport.
        // A no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
        additionalTransports: [new OpenTelemetryTransportV3()],
      }),
    ),
  ],
  exports: [WinstonModule],
})
export class LoggingModule {}
