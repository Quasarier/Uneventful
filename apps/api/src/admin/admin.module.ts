import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { VenueBookingsModule } from '../venues/venue-bookings.module';
import { VenuesModule } from '../venues/venues.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [
    AppConfigModule,
    AuthModule,
    AuthRateLimitModule,
    DatabaseModule,
    AnalyticsModule,
    VenueBookingsModule,
    VenuesModule,
  ],
  controllers: [AdminController, ReportsController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
