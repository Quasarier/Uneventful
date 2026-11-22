import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { VenueBookingsRepository } from './venue-bookings.repository';
import { VenueBookingsService } from './venue-bookings.service';

@Module({
  imports: [AppConfigModule, DatabaseModule],
  providers: [VenueBookingsRepository, VenueBookingsService],
  exports: [VenueBookingsRepository, VenueBookingsService],
})
export class VenueBookingsModule {}
