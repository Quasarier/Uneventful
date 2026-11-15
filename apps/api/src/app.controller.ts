import { Controller, Get } from '@nestjs/common';
import { Public, SkipGlobalRateLimit } from './auth/auth.decorators';
import { AppService } from './app.service';
import { HealthService } from './health.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly healthService: HealthService,
  ) {}

  @Get('health/live')
  @Public()
  @SkipGlobalRateLimit()
  getLiveness(): { status: 'ok' } {
    return this.appService.getLiveness();
  }

  @Get('health/ready')
  @Public()
  getReadiness(): Promise<{ status: 'ok' }> {
    return this.healthService.getReadiness();
  }
}
