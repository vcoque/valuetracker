import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';

/**
 * Root module. It imports one module per capability-map module id as those are
 * built (identity, catalog, portfolio, ...); until then it carries only the
 * health endpoint.
 */
@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
