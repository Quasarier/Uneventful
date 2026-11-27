import { Module } from '@nestjs/common';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { DatabaseModule } from '../database/database.module';
import { VenueBookingsModule } from './venue-bookings.module';
import { VenuesController } from './venues.controller';
import { VenuesRepository } from './venues.repository';
import { VenuesService } from './venues.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, AuthRateLimitModule, DatabaseModule, VenueBookingsModule],
  controllers: [VenuesController],
  providers: [VenuesRepository, VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
