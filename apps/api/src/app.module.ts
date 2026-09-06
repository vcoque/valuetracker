import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './shared/prisma/prisma.module';

/**
 * Root module. It imports one module per capability-map module id as those are
 * built (identity, catalog, portfolio, ...); for now it carries the health
 * endpoint and the shared database connection.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
