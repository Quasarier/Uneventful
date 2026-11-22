import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { EventDashboardGateway } from './event-dashboard.gateway';
import { EventDashboardRepository } from './event-dashboard.repository';
import { EVENT_DASHBOARD_PUBLISHER } from './event-dashboard.types';

@Module({
  imports: [AppConfigModule, AuthModule, DatabaseModule],
  providers: [
    EventDashboardRepository,
    EventDashboardGateway,
    { provide: EVENT_DASHBOARD_PUBLISHER, useExisting: EventDashboardGateway },
  ],
  exports: [EVENT_DASHBOARD_PUBLISHER],
})
export class EventDashboardModule {}
