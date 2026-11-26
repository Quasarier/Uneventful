import { Module } from '@nestjs/common';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { DatabaseModule } from '../database/database.module';
import { AppConfigModule } from '../config/config.module';
import { AnalyticsCacheService } from './analytics-cache.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [AppConfigModule, AuthRateLimitModule, DatabaseModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsCacheService, AnalyticsService],
  exports: [AnalyticsCacheService],
})
export class AnalyticsModule {}
