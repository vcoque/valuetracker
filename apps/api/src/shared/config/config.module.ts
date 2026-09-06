import { Module } from '@nestjs/common';

import { AppConfig, loadAppConfig } from './app-config';

/**
 * Provides the validated {@link AppConfig}. The factory below is the only place
 * in the application that touches `process.env`; every other module receives
 * configuration by injection.
 *
 * Deliberately not `@Global()`. A module that needs configuration should say so
 * in its `imports`, the same way it declares any other dependency -- ambient
 * availability is what makes module boundaries erode.
 */
@Module({
  providers: [
    {
      provide: AppConfig,
      // eslint-disable-next-line no-restricted-properties -- the single sanctioned read
      useFactory: () => loadAppConfig(process.env),
    },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
