import { Controller, Get } from '@nestjs/common';

import { AppService, type HealthReport } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Liveness in name, but not in effect once PrismaService exists: it connects
   * eagerly in `onModuleInit`, and Nest builds the whole module graph before
   * `main.ts` calls `app.listen()`. A database that is unreachable at boot means
   * this process never starts listening -- there is no window in which "the
   * process is up" is true and "the database is up" is not, so a 200 here
   * currently certifies both.
   *
   * That coupling was chosen deliberately (see `PrismaService`: a bad connection
   * string should refuse to start, not fail every request), and it is fine for
   * a single-container deploy with no rolling updates. It stops being fine once
   * something restarts instances while others still serve traffic (Task 17) --
   * at that point a transient database blip will read as a crash-loop across the
   * whole fleet rather than a delay in one instance, and a real readiness check
   * that can fail without taking liveness down with it becomes necessary.
   */
  @Get('health')
  getHealth(): HealthReport {
    return this.appService.getHealth();
  }
}
