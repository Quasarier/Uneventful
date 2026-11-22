import { Module } from '@nestjs/common';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { DatabaseModule } from '../database/database.module';
import { EventImageStorageService } from './event-image-storage.service';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { VenueBookingsModule } from '../venues/venue-bookings.module';

@Module({
  imports: [DatabaseModule, AuthRateLimitModule, VenueBookingsModule],
  controllers: [EventsController],
  providers: [EventsRepository, EventsService, EventImageStorageService],
})
export class EventsModule {}
