import { Controller, Get } from '@nestjs/common';

import { AppService, type HealthReport } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Liveness only. It answers "this process is up and its HTTP stack works",
   * which is what a container orchestrator needs to decide whether to restart.
   * Readiness -- can it reach the database? -- is a separate concern and lands
   * with PrismaService in Task 4; conflating the two makes a database blip look
   * like a crashed process.
   */
  @Get('health')
  getHealth(): HealthReport {
    return this.appService.getHealth();
  }
}
