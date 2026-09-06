import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { AppConfig } from '../config/app-config';

/**
 * The application's single database client.
 *
 * Prisma 7 has no Rust query engine and no `url` in the datasource block: a
 * direct connection is made through a driver adapter, which is why this
 * constructs {@link PrismaPg} from the validated connection string rather than
 * letting the client discover `process.env.DATABASE_URL` on its own. The
 * connection string arrives by injection, so tests can point the same service
 * at a throwaway database without touching global state.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({ adapter: new PrismaPg(config.databaseUrl) });
  }

  /**
   * Connect eagerly. Prisma would otherwise connect lazily on the first query,
   * which turns a bad connection string or an unreachable database into a
   * failed *request* long after deploy, rather than a failed startup.
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Release the pool on shutdown. This only runs if shutdown hooks are enabled
   * on the Nest application -- see `main.ts`.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}
