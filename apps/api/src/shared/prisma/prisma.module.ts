import { Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { PrismaService } from './prisma.service';

/**
 * Owns the database client. Capability modules import this rather than
 * constructing a client of their own, so the application holds exactly one
 * connection pool.
 */
@Module({
  imports: [ConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
