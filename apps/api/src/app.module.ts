import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EventsModule } from './events/events.module';
import { DatabaseModule } from './database/database.module';
import { HealthService } from './health.service';
import { RsvpsModule } from './rsvps/rsvps.module';
import { VenuesModule } from './venues/venues.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { ClubsModule } from './clubs/clubs.module';

@Module({
  imports: [
    AppConfigModule,
    AuthModule,
    EventsModule,
    RsvpsModule,
    VenuesModule,
    NotificationsModule,
    AnalyticsModule,
    AdminModule,
    ClubsModule,
    DatabaseModule,
  ],
  controllers: [AppController],
  providers: [AppService, HealthService],
})
export class AppModule {}
