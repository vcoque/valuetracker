import { Injectable } from '@nestjs/common';

export interface HealthReport {
  readonly status: 'ok';
}

@Injectable()
export class AppService {
  getHealth(): HealthReport {
    return { status: 'ok' };
  }
}
